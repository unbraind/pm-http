import { randomUUID } from 'node:crypto';
import { contractShape } from './capture.ts';
import { digest, HttpError, label, requireInput, bound } from './core.ts';
import { makeProbe, requestFor } from './policy.ts';
import { capture, uncertain } from './transport.ts';
import { Store, assertRevision, capacity, targetDigest, RESPONSE_RESERVATION } from './store.ts';
import type { Contract, Observation, Options, Probe, ProbeInput, State, Step } from './types.ts';

/** Locate a canonical probe with prototype-safe lookup. */
export function probeFrom(value: State, name: string) { const probe = value.probes.find(entry => entry.name === label(name)); if (probe === undefined) throw new HttpError('probe_missing', 'Declared probe does not exist', 'Run pm http probe add for this task'); return probe; }
/** Share operation identity, guard and recording-capacity admission between preview and apply. */
export function admitPlan(value: State, probe: Probe, id: string, expectedRevision: number | undefined, sourceDigest: string): boolean {
  requireInput(/^[a-zA-Z0-9_-]{1,64}$/.test(id), 'Operation identity must be a short identifier');
  const previous = value.plans.find(entry => entry.id === id);
  if (previous !== undefined) {
    requireInput(previous.probeDigest === digest(probe) && previous.probe === probe.name, 'Operation already belongs to another declaration');
    if (expectedRevision !== undefined) assertRevision(expectedRevision, previous.expectedRevision ?? -1);
    return false;
  }
  assertRevision(value.revision, expectedRevision);
  value.plans.push({ id, probe: probe.name, probeDigest: digest(probe), stage: 'planned', reservedBytes: RESPONSE_RESERVATION, ...(expectedRevision === undefined ? {} : { expectedRevision, guardRevision: value.revision + 1, targetDigest: sourceDigest }) });
  capacity(value); return true;
}
/** Declare an immutable request bound to an existing native task. */
export async function addProbe(item: string, name: string, input: ProbeInput, options: Options) {
  const probe = makeProbe(name, input); const store = new Store(options);
  const value = await store.change(item, async current => { const existing = current.probes.find(entry => entry.name === probe.name); if (existing !== undefined) { requireInput(digest({ ...existing, review: undefined }) === digest(probe), 'Probe name already declares a different request; use a new name'); return false; } await store.register(); current.probes.push(probe); return true; }, 'Declared HTTP probe; environment references only', [`path=${probe.url},scope=project`]);
  return { probe, revision: value.revision };
}
/** Record separate mutation review with attributed author and an explicit reason. */
export async function reviewProbe(item: string, name: string, reason: string, options: Options) {
  requireInput(reason.trim().length >= 8 && reason.length <= 256 && /^[a-zA-Z .,;:-]+$/.test(reason), 'Review reason must be 8 to 256 plain prose characters without secret values');
  const store = new Store(options); store.writable(); const author = await store.author();
  const value = await store.change(item, current => { const probe = probeFrom(current, name); if (probe.review !== undefined) { requireInput(probe.review.author === author && probe.review.reason === reason, 'Mutation review already exists with a different identity or reason'); if (probe.review.allowMutation === true) return false; } probe.review = { allowMutation: true, author, reason, at: new Date().toISOString() }; return true; }, 'Recorded explicit reviewed HTTP mutation capability');
  return { probe: probeFrom(value, name), revision: value.revision };
}
/** List complete declarations with a source-completeness receipt. */
export async function listProbes(item: string, options: Options) { const { value } = await new Store(options).read(item); return { revision: value.revision, probes: value.probes, receipt: { complete: true, omitted: 0 } }; }
/** Preview the same request planner used by send, without resolving credentials or writing. */
export async function preview(item: string, name: string, options: Options) {
  const { value, item: target } = await new Store(options).read(item); const probe = probeFrom(value, name); const request = requestFor(probe, false);
  const operation = options.operationId ?? randomUUID(); admitPlan(structuredClone(value), probe, operation, options.expectedRevision, targetDigest(target, operation));
  return { operation: options.operationId, revision: value.revision, method: probe.method, url: request.url.href, headers: request.headers, body: probe.body, boundary: probe.boundary, maxBytes: probe.maxBytes, timeoutMs: probe.timeoutMs, credentials: 'environment names only' };
}
/** Send using a durable intent; uncertain interrupted sends converge without replaying the request. */
export async function send(item: string, name: string, options: Options): Promise<{ observation: Observation; operation: string }> {
  const store = new Store(options); store.writable(); const id = options.operationId ?? randomUUID();
  const initial = await store.read(item); const probe = probeFrom(initial.value, name); requestFor(probe, false);
  admitPlan(structuredClone(initial.value), probe, id, options.expectedRevision, targetDigest(initial.item, id));
  // Invocation guards survive in the journal; subsequent writes merge only within their admission policy.
  const journal = new Store({ ...options, expectedRevision: undefined });
  /** Identify only this operation's own comments when checking durable native-source identity. */
  const note = (text: string): string => `HTTP operation ${id}: ${text}`;
  /** Expose each complete protocol step to deterministic competing-writer and crash tests. */
  const step = async (point: Step): Promise<void> => { await options.boundary?.(point); };
  /** Revalidate the immutable declaration in every journal mutation, including recovery. */
  const validate = (value: State): void => { if (digest(probeFrom(value, name)) !== digest(probe)) throw new HttpError('conflict', 'Probe revision changed after planning', 'Inspect the current declaration; use a new reviewed operation'); };
  await step('validated');
  return journal.locked(`send:${initial.id}:${id}`, async () => {
    await step('plan-ready');
    let current = await journal.change(initial.id, async value => {
      validate(value); const plan = value.plans.find(entry => entry.id === id);
      if (plan !== undefined) return admitPlan(value, probe, id, options.expectedRevision, targetDigest(initial.item, id));
      if (options.expectedRevision !== undefined && digest((await journal.read(initial.id)).item) !== digest(initial.item)) throw new HttpError('conflict', 'Native target changed before plan admission', 'Read current context and declare a new operation', { reason: 'stale_revision' });
      return admitPlan(value, probe, id, options.expectedRevision, targetDigest(initial.item, id));
    }, note('Journaled explicit HTTP send intent'));
    const plannedTarget = await journal.read(initial.id);
    await step('planned');
    const plan = current.plans.find(entry => entry.id === id)!;
    if (plan.stage === 'cancelled') throw new HttpError('cancelled', 'Operation was cancelled or refused without an observation', 'Inspect the refusal and use a new operation identity');
    let observation = current.observations.find(entry => entry.id === id) ?? plan.observation;
    if (plan.stage === 'sending') observation = uncertain(id, probe, 'Interrupted after send intent; outcome uncertain; no automatic retry');
    if (plan.stage === 'planned') {
      // Validate environment availability before marking a possible remote effect.
      requestFor(probe, true);
      try {
        current = await journal.change(initial.id, async value => {
          validate(value); const entry = value.plans.find(entry => entry.id === id)!;
          if (entry.expectedRevision !== undefined) {
            assertRevision(value.revision, entry.guardRevision);
            const target = (await journal.read(initial.id)).item;
            if (digest(target) !== digest(plannedTarget.item) || targetDigest(target, id) !== entry.targetDigest) throw new HttpError('conflict', 'Native target changed after planning', 'Read current context and declare a new operation', { reason: 'stale_revision' });
            entry.guardRevision = value.revision + 1;
          }
          entry.stage = 'sending'; entry.reservedBytes = RESPONSE_RESERVATION; return true;
        }, note('Marked possible HTTP request effect; retries require explicit identity'));
      } catch (error) {
        if (error instanceof HttpError && error.details.reason === 'stale_revision') await journal.change(initial.id, value => { const entry = value.plans.find(entry => entry.id === id)!; entry.stage = 'cancelled'; delete entry.reservedBytes; return true; }, note('Refused stale send before network effects'));
        throw error;
      }
      const readyTarget = await journal.read(initial.id);
      await step('sending');
      try {
        const fresh = await journal.read(initial.id); validate(fresh.value); capacity(fresh.value);
        const guard = fresh.value.plans.find(entry => entry.id === id)!;
        if (guard.expectedRevision !== undefined) {
          assertRevision(fresh.value.revision, guard.guardRevision);
          if (digest(fresh.item) !== digest(readyTarget.item) || digest(fresh.value) !== digest(current) || targetDigest(fresh.item, id) !== guard.targetDigest) throw new HttpError('conflict', 'Native target changed immediately before send', 'Read current context and declare a new operation', { reason: 'stale_revision' });
        }
        observation = await capture(id, probe, options.signal);
      }
      catch (error) { await journal.change(initial.id, value => { validate(value); const entry = value.plans.find(entry => entry.id === id)!; entry.stage = 'cancelled'; delete entry.reservedBytes; return true; }, note('HTTP send cancelled or refused; no partial observation')); throw error; }
      await journal.change(initial.id, value => { validate(value); const entry = value.plans.find(entry => entry.id === id)!; entry.stage = 'received'; entry.observation = observation; delete entry.reservedBytes; return true; }, note('Journaled complete secret-free HTTP result'));
    }
    await step('received'); await step('record-ready');
    requireInput(observation !== undefined, 'Send journal has no recoverable result');
    const final = observation;
    await journal.change(initial.id, value => {
      validate(value); const existing = value.observations.find(entry => entry.id === id);
      if (existing !== undefined) { requireInput(digest(existing) === digest(final), 'Observation identity already has different evidence'); return false; }
      value.observations.push(final); const entry = value.plans.find(entry => entry.id === id)!; entry.stage = 'recorded'; delete entry.observation; delete entry.reservedBytes; return true;
    }, note('Recorded historical HTTP observation; no present health assertion'));
    await step('recorded'); await step('complete'); return { observation: final, operation: id };
  });
}
/** Store one normalized contract, replacing the prior expectation under current revision. */
export async function setContract(item: string, name: string, input: { statuses: number[]; headers?: string[]; shape?: unknown; maxLatencyMs?: number }, options: Options) {
  requireInput(input.statuses.length > 0 && input.statuses.length <= 16, 'Contract needs 1 to 16 expected statuses');
  const contract: Contract = { probe: label(name), statuses: [...new Set(input.statuses.map(code => bound(code, 100, 599)))].sort((a, b) => a - b), headers: [...new Set((input.headers ?? []).map(header => header.toLowerCase()))].sort(), ...(input.shape === undefined ? {} : { shape: contractShape(input.shape) }), ...(input.maxLatencyMs === undefined ? {} : { maxLatencyMs: bound(input.maxLatencyMs, 1, 60000) }) };
  requireInput(contract.headers.length <= 32 && contract.headers.every(header => /^[a-z][a-z0-9-]{0,63}$/.test(header)), 'Required header list is invalid');
  const store = new Store(options);
  const value = await store.change(item, current => { probeFrom(current, name); const index = current.contracts.findIndex(entry => entry.probe === contract.probe); if (index >= 0 && digest(current.contracts[index]) === digest(contract)) return false; if (index < 0) current.contracts.push(contract); else current.contracts[index] = contract; return true; }, 'Recorded bounded HTTP response contract');
  return { contract, revision: value.revision };
}
