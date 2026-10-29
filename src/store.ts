import { randomUUID } from 'node:crypto';
import { acquireLockLease, commitItemMutations, PmClient, readSettings, selectImportAuthor } from '@unbrained/pm-cli/sdk';
import type { GetResult } from '@unbrained/pm-cli/sdk';
import type { SchemaFieldDefinition } from '@unbrained/pm-cli/sdk/authoring';
import type { Options, State } from './types.ts';
import { digest, HttpError, requireInput } from './core.ts';

/** Registered native extension field, portable through native item exports. */
export const FIELDS: SchemaFieldDefinition[] = [{ name: 'http_state', type: 'string', optional: true }];
/** Process-local admission queues avoid overlapping SDK lock publication windows. */
const queues = new Map<string, Promise<void>>();
/** Empty state is read-compatible with tasks predating this extension. */
export function state(raw: unknown): State {
  if (raw === undefined) return { version: 1, revision: 0, probes: [], contracts: [], observations: [], plans: [] };
  try {
    const parsed = JSON.parse(String(raw)) as State;
    requireInput(parsed.version === 1 && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 && ['probes', 'contracts', 'observations', 'plans'].every(key => Array.isArray((parsed as unknown as Record<string, unknown>)[key])), 'Invalid HTTP state');
    return parsed;
  } catch { throw new HttpError('schema', 'HTTP state is malformed or uses an unsupported version', 'Repair through native pm or use a compatible pm-http version'); }
}
/** Native SDK repository; every mutation is revision-guarded under SDK locks. */
export class Store {
  /** Explicit tracker and invocation policy binding. */
  readonly options: Options;
  /** Native SDK client preserving the caller's backend. */
  readonly client: PmClient;
  /** Bind explicitly to one tracker; remote mutation needs a host-owned conditional writer. */
  constructor(options: Options) { this.options = options; this.client = options.client ?? new PmClient({ pmRoot: options.workspace, author: options.author, noExtensions: true }); }
  /** Resolve the SDK's attributed author setting. */
  async author(): Promise<string> { return selectImportAuthor(this.options.author, (await readSettings(this.options.workspace)).author_default); }
  /** Refuse unsupported remote effects before schema, journal or network writes. */
  writable(): void { if (this.options.backend === 'remote') throw new HttpError('capability', 'Host lacks backend-owned conditional mutation support', 'Use a filesystem tracker for sends and writes; injected clients support reads'); }
  /** Register through SDK schema services, never edit settings files. */
  async register(): Promise<void> {
    this.writable();
    const current = (await this.client.schemaListFields()).fields.find(field => field.key === 'http_state');
    if (current !== undefined) { requireInput(current.type === 'string', 'http_state must be a registered string field'); return; }
    await this.client.schemaAddField('http_state', { type: 'string', description: 'Versioned pm-http task context', author: await this.author() });
  }
  /** Read the entire relevant extension field without host truncation or git discovery. */
  async read(id: string): Promise<{ id: string; item: GetResult['item']; value: State }> {
    // Explicit unbounded reads exclude budget-exceeded results; the SDK declaration retains that union.
    // Full native reads preserve historical fields even if their registry entry was removed.
    const result = await this.client.get(id, { outputInclude: 'full', outputBudget: 'unbounded', outputLimit: 'unbounded' }) as GetResult;
    return { id: result.item.id, item: result.item, value: state(result.item.http_state) };
  }
  /** Guard one package operation with an SDK lease independent of the native item lock. */
  async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    this.writable(); const identity = this.options.workspace + ':' + key; const previous = queues.get(identity) ?? Promise.resolve();
    const pending = Promise.withResolvers<void>(); const tail = previous.then(() => pending.promise); queues.set(identity, tail); await previous;
    try {
      const author = await this.author(); const lockId = `http-${digest(key)}`;
      const lease = await acquireLockLease(this.options.workspace, lockId, 120, author, false, false, 10000, { maxWaitMs: 10000 });
      try { return await lease.fence(action); } finally { await lease.release(); }
    } finally { pending.resolve(); if (queues.get(identity) === tail) queues.delete(identity); }
  }
  /** Freshly read each target, merge unrelated writes, then atomically compare its revision. */
  async change(id: string, change: (value: State) => boolean | Promise<boolean>, comment: string, references?: string[]): Promise<State> {
    this.writable();
    return this.locked(`state:${id}`, async () => {
      const snapshot = await this.read(id); const before = JSON.stringify(snapshot.value);
      if (this.options.expectedRevision !== undefined && this.options.expectedRevision !== snapshot.value.revision) throw new HttpError('conflict', 'Expected HTTP revision changed', 'Read current context and re-plan with that revision');
      const value = snapshot.value;
      if (!await change(value)) { const current = await this.read(id); if (JSON.stringify(current.value) !== before) throw new HttpError('conflict', 'HTTP target changed during unchanged verification', 'Read the current target and retry'); return current.value; }
      value.revision++;
      requireInput(value.probes.length <= 32 && value.observations.length <= 128 && value.plans.length <= 128 && JSON.stringify(value).length <= 1048576, 'Task context ceiling reached; declare a new investigation task');
      try {
        await commitItemMutations({ pmRoot: this.options.workspace, author: await this.author(), transactionId: `http-${randomUUID()}`, lockWaitMs: 10000, onTransition: this.options.onTransition, mutations: [{ op: 'update', id: snapshot.id, match: snapshot.item.http_state === undefined ? { key: 'updated_at', value: snapshot.item.updated_at } : { key: 'http_state', value: snapshot.item.http_state }, options: { httpState: JSON.stringify(value), comment: [comment], doc: references } }] });
      } catch { throw new HttpError('conflict', 'Conditional HTTP context write did not complete', 'Read the current target and recover using the same operation identity'); }
      return value;
    });
  }
}
