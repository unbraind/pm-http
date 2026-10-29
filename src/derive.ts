import { matches } from './capture.ts';
import { bound, digest, label, tokens, requireInput } from './core.ts';
import { Store } from './store.ts';
import type { Contract, Missing, Observation, Options, State, Verdict } from './types.ts';

/** Evaluate known constraints independently; incomplete evidence cannot establish satisfaction. */
export function verdict(observation: Observation, contract: Contract | undefined, probeDigest: string): Verdict {
  const row: Verdict = { observation: observation.id, probe: observation.probe, at: observation.at, result: 'unknown', reasons: [] };
  if (contract === undefined) { row.reasons.push('No contract declared'); return row; }
  if (observation.outcome !== 'response' || observation.probeDigest !== probeDigest) { row.reasons.push('No response for the current probe declaration'); return row; }
  if (observation.receipt.redirectsOmitted > 0) { row.reasons.push('Redirect chain incomplete; final response is unknown'); return row; }
  let violated = false;
  let incomplete = observation.receipt.bodyTruncated || observation.receipt.shapeIncomplete || observation.receipt.headersOmitted > 0;
  /** Retain definitive failures separately from missing evidence. */
  const fail = (reason: string): void => { row.reasons.push(reason); violated = true; };
  if (!contract.statuses.includes(observation.status!)) fail('status');
  for (const header of contract.headers) {
    if (!observation.selectedHeaders?.includes(header)) { row.reasons.push(`header-not-selected:${header}`); incomplete = true; }
    else if (!Object.hasOwn(observation.headers, header)) {
      if (observation.receipt.headersOmitted > 0) row.reasons.push(`header-not-captured:${header}`);
      else fail(`header:${header}`);
    }
  }
  if (contract.shape !== undefined) {
    if (observation.receipt.bodyTruncated || observation.receipt.shapeIncomplete) row.reasons.push('json-shape-incomplete');
    else if (observation.shape === undefined || !matches(observation.shape, contract.shape)) fail('json-shape');
  }
  if (contract.maxLatencyMs !== undefined) {
    if (observation.timing.total === null) { row.reasons.push('latency-unavailable'); incomplete = true; }
    else if (observation.timing.total > contract.maxLatencyMs) fail('latency');
  }
  if (incomplete) row.reasons.push('Capture incomplete; repeat explicitly with suitable bounds');
  row.result = violated ? 'violates' : incomplete ? 'unknown' : 'satisfies'; return row;
}
/** Enumerate exact missing probes, expectations and complete response evidence. */
export function missing(value: State): Missing[] {
  return value.probes.flatMap(probe => {
    const rows: Missing[] = []; const observed = value.observations.filter(row => row.probe === probe.name && row.probeDigest === digest(probe));
    if (observed.length === 0) rows.push({ probe: probe.name, evidence: 'observation' });
    else if (!observed.some(row => row.outcome === 'response' && !row.receipt.bodyTruncated && !row.receipt.shapeIncomplete && row.receipt.headersOmitted === 0 && !row.receipt.redirectsOmitted)) rows.push({ probe: probe.name, evidence: 'complete-response' });
    if (!value.contracts.some(row => row.probe === probe.name)) rows.push({ probe: probe.name, evidence: 'contract' });
    return rows;
  });
}
/** Read every historical observation without execution, with explicit completeness. */
export async function observations(item: string, options: Options) { const { value } = await new Store(options).read(item); return { revision: value.revision, observations: value.observations, historical: true, receipt: { complete: true, omitted: 0 } }; }
/** Compare stored evidence in process without sending any request. */
export async function compare(item: string, options: Options & { probe?: string }) {
  const { value } = await new Store(options).read(item);
  const rows = value.observations.filter(row => options.probe === undefined || row.probe === label(options.probe)).map(row => verdict(row, value.contracts.find(contract => contract.probe === row.probe), digest(value.probes.find(probe => probe.name === row.probe))));
  return { revision: value.revision, historical: true, comparisons: rows, receipt: { complete: true, omitted: 0 } };
}
/** Read outstanding evidence requests with no implicit retries. */
export async function missingEvidence(item: string, options: Options) { const { value } = await new Store(options).read(item); return { revision: value.revision, missing: missing(value), receipt: { complete: true, omitted: 0 } }; }
/** Flatten per-field comparison data without including request secrets or body values. */
function fields(observation: Observation): Map<string, unknown> {
  const values = new Map<string, unknown>([['status', observation.status ?? null], ['outcome', observation.outcome], ['digest', observation.digest ?? null], ['bytes', observation.bytes], ['timing.total', observation.timing.total], ['retry', observation.retry]]);
  /** Walk structural properties so a packet names each changed field path. */
  function walk(value: unknown, prefix: string): void {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) for (const [key, entry] of Object.entries(value)) walk(entry, `${prefix}.${key}`);
    else values.set(prefix, value);
  }
  walk(observation.headers, 'headers'); walk(observation.shape ?? null, 'shape'); return values;
}
/** Derive first-bad/preceding-last-good differences; lacking a verdict, compare the latest pair. */
export function differences(value: State): unknown[] {
  return value.probes.map(probe => {
    const rows = value.observations.filter(row => row.probe === probe.name && row.probeDigest === digest(probe)).sort((a, b) => a.at.localeCompare(b.at, 'en') || a.id.localeCompare(b.id, 'en'));
    const contract = value.contracts.find(entry => entry.probe === probe.name);
    const firstBad = rows.findIndex(row => verdict(row, contract, digest(probe)).result === 'violates');
    const after = firstBad < 0 ? rows.at(-1) : rows[firstBad];
    const before = firstBad < 0 ? rows.at(-2) : rows.slice(0, firstBad).findLast(row => verdict(row, contract, digest(probe)).result === 'satisfies');
    const changes: { field: string; before: unknown; after: unknown }[] = [];
    if (before !== undefined && after !== undefined) {
      const a = fields(before); const b = fields(after);
      for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) if (JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key))) changes.push({ field: key, before: a.get(key) ?? null, after: b.get(key) ?? null });
    }
    return { kind: 'difference', probe: probe.name, mode: firstBad < 0 ? 'latest-pair' : 'first-bad-last-good', before: before === undefined ? null : { id: before.id, at: before.at }, after: after === undefined ? null : { id: after.id, at: after.at }, verdict: after === undefined ? null : verdict(after, contract, digest(probe)), changes };
  });
}
/** Build a compact, historical packet; the receipt and both renderer costs count toward budget. */
export async function differencePacket(item: string, options: Options & { budget?: number }) {
  const budget = bound(options.budget ?? 1500, 256, 1000000); const snapshot = await new Store(options).read(item);
  const source = [...missing(snapshot.value).map(row => ({ kind: 'missing', ...row })), ...differences(snapshot.value)];
  /** Recompute self-inclusive token accounting after every selected row. */
  const make = (rows: unknown[]) => {
    const packet = { task: snapshot.id, revision: snapshot.value.revision, historical: true, rows, estimatedTokens: 0, receipt: { sourceComplete: true, omitted: source.length - rows.length, returned: rows.length, restore: `pm http diff ${snapshot.id} --budget 1000000`, missing: `pm http missing ${snapshot.id}`, estimator: 'ceil(max(json,toon)_utf8_bytes/4)' } };
    let cost = tokens(packet); while (packet.estimatedTokens !== cost) { packet.estimatedTokens = cost; cost = tokens(packet); } return packet;
  };
  let result = make([]);
  requireInput(result.estimatedTokens <= budget, 'Budget cannot contain the complete omission receipt; increase --budget');
  for (const row of source) { const next = make([...result.rows, row]); if (next.estimatedTokens <= budget) result = next; }
  return result;
}
