import { createHash } from 'node:crypto';
import { encode } from '@toon-format/toon';
import { PmCliError, EXIT_CODE } from '@unbrained/pm-cli/sdk';

/** Typed refusal with no raw network, environment or SDK diagnostic. */
export class HttpError extends Error {
  /** Stable refusal classification for embedded callers. */
  readonly code: string;
  /** Concrete next step without private diagnostics. */
  readonly remedy: string;
  /** Safe hop identities and refusal metadata. */
  readonly details: Record<string, string>;
  /** Keep all error fields safe for both renderers. */
  constructor(code: string, message: string, remedy = 'Read pm http --help and correct the declaration', details: Record<string, string> = {}) {
    super(message); this.name = 'HttpError'; this.code = code; this.remedy = remedy; this.details = details;
  }
}
/** Reject before effects without interpolating untrusted input. */
export function requireInput(condition: unknown, message: string): asserts condition { if (!condition) throw new HttpError('invalid', message); }
/** Stable full SHA-256 identity for declarations and structural property names. */
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Render untrusted controls and instruction delimiters as inert escaped data. */
export function inert(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f<>`]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`); }
/** Recursively sanitize every emitted string, including object keys. */
export function data(value: unknown): unknown {
  if (typeof value === 'string') return inert(value);
  if (Array.isArray(value)) return value.map(data);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [inert(k), data(v)]));
  return value;
}
/** Use host-selected TOON or JSON; untrusted text stays labeled data. */
export function wire(value: unknown, format: 'json' | 'toon'): string { const safe = data(value); return format === 'json' ? JSON.stringify(safe, null, 2) : encode(safe); }
/** Conservative byte/4 estimate covering both serialized host formats and newline. */
export function tokens(value: unknown): number { return Math.ceil(Math.max(Buffer.byteLength(wire(value, 'json') + '\n'), Buffer.byteLength(wire(value, 'toon') + '\n')) / 4); }
/** Accept bounded integral controls without coercing malformed values. */
export function bound(value: number, min: number, max: number): number { requireInput(Number.isSafeInteger(value) && value >= min && value <= max, 'Numeric control is outside its documented bounds'); return value; }
/** Resolve a reference name without retaining its value in diagnostics. */
export function reference(value: string): string { requireInput(/^@[A-Z_][A-Z0-9_]{0,127}$/.test(value), 'Secrets and bodies require @ENV_NAME references'); return value; }
/** Read only explicitly referenced variables; never enumerate the environment. */
export function resolveReference(value: string): string {
  reference(value); const resolved = process.env[value.slice(1)];
  if (resolved === undefined || resolved.length === 0) throw new HttpError('credential_missing', 'A referenced environment variable is absent', 'Set the declared variable in the sending process');
  return resolved;
}
/** Reject prompt-sized and token-shaped declarations before persistence. */
export function label(value: string): string { requireInput(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(value), 'Names must be 1 to 48 identifier characters'); return value.toLowerCase(); }
/** Adapt all public operations to safe, typed failures. */
export function guarded<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => { try { return await fn(...args); } catch (error) { if (error instanceof HttpError) throw error; if (error instanceof PmCliError && error.exitCode === EXIT_CODE.CONFLICT) throw new HttpError('conflict', 'Another writer holds or changed the target', 'Wait for the writer, read current context and explicitly resume with the same operation identity'); throw new HttpError('sdk', 'HTTP context SDK operation failed', 'Check tracker health, access and registered schema; retry the same operation identity'); } };
}
