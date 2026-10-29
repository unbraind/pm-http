import { createHash } from 'node:crypto';
import type { Shape } from './types.ts';
import { digest, requireInput } from './core.ts';

/** Bound shape work and report structural omissions instead of inventing completeness. */
export function bodyShape(value: unknown): { shape: Shape; incomplete: boolean } {
  let nodes = 0; let incomplete = false;
  /** Hash keys and discard every scalar response value. */
  function walk(entry: unknown, depth: number): Shape {
    nodes++; if (depth > 12) { incomplete = true; return { type: 'omitted' }; }
    if (entry === null) return { type: 'null' };
    if (Array.isArray(entry)) { const shapes: Shape[] = []; for (const item of entry.slice(0, 64)) { if (nodes >= 256) { incomplete = true; break; } shapes.push(walk(item, depth + 1)); } if (entry.length > 64) incomplete = true; return { type: 'array', items: [...new Map(shapes.map(shape => [JSON.stringify(shape), shape])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')) }; }
    if (typeof entry === 'object') { const properties: Record<string, Shape> = {}; if (Object.keys(entry).length > 64) incomplete = true; for (const [key, content] of Object.entries(entry).slice(0, 64)) { if (nodes >= 256) { incomplete = true; break; } properties[digest(key)] = walk(content, depth + 1); } return { type: 'object', properties: Object.fromEntries(Object.entries(properties).sort(([a], [b]) => a.localeCompare(b, 'en'))) }; }
    return { type: typeof entry };
  }
  const shape = walk(value, 0);
  return { shape, incomplete };
}
/** Detect JSON semantics within the header count cap without exposing arbitrary media tokens. */
export function jsonMediaType(raw: string[], max: number): boolean | undefined {
  for (let index = 0; index < Math.min(raw.length, max * 2); index += 2) if (raw[index].toLowerCase() === 'content-type') return /^application\/(?:json|[!#$%&'*+.^_`|~0-9a-z-]+\+json)$/i.test(raw[index + 1].split(';')[0].trim());
  return undefined;
}
/** Compile the supported JSON-schema subset without retaining source strings. All properties are required. */
export function contractShape(value: unknown, depth = 0): Shape {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value) && depth <= 12, 'JSON shape must use the bounded documented schema subset');
  const node = value as Record<string, unknown>;
  requireInput(Object.keys(node).every(key => ['type', 'properties', 'items'].includes(key)) && typeof node.type === 'string' && ['object', 'array', 'string', 'number', 'boolean', 'null'].includes(node.type), 'Unsupported JSON shape keyword or type');
  const shape: Shape = { type: node.type };
  if (node.properties !== undefined) {
    requireInput(node.type === 'object' && node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties) && Object.keys(node.properties).length <= 64, 'Shape properties require an object with at most 64 keys');
    shape.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [digest(key), contractShape(child, depth + 1)]).sort(([a], [b]) => String(a).localeCompare(String(b), 'en')));
  }
  if (node.items !== undefined) { requireInput(node.type === 'array', 'Shape items require an array'); shape.items = [contractShape(node.items, depth + 1)]; }
  return shape;
}
/** Match required fields recursively; additional observed fields are allowed. */
export function matches(actual: Shape, expected: Shape): boolean {
  if (actual.type !== expected.type) return false;
  for (const [key, value] of Object.entries(expected.properties ?? {})) { const found = actual.properties?.[key]; if (found === undefined || !matches(found, value)) return false; }
  if (expected.items !== undefined && actual.items?.some(item => !matches(item, expected.items![0]))) return false;
  return true;
}
/** Retain only canonical nonopaque header semantics; everything else is redacted. */
export function headerValue(name: string, value: string, secrets: string[]): string {
  if (secrets.some(secret => value.includes(secret)) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return '[REDACTED]';
  if (name === 'content-type') { const mime = value.split(';')[0].trim().toLowerCase(); return ['application/json', 'application/problem+json', 'application/vnd.github+json', 'text/plain', 'text/html', 'application/octet-stream'].includes(mime) ? mime : '[REDACTED]'; }
  if ((name === 'content-length' || name === 'retry-after') && /^\d{1,7}$/.test(value) && Number(value) <= 1048576) return String(Number(value));
  if (name === 'cache-control' && /^(?:no-store|no-cache|public|private|max-age=\d{1,6})(?:, ?(?:no-store|no-cache|public|private|max-age=\d{1,6}))*$/.test(value)) return value;
  return '[REDACTED]';
}
/** Select a bounded response header prefix while recording all capture losses. */
export function captureHeaders(raw: string[], selected: string[], max: number, secrets: string[]): { headers: Record<string, string>; omitted: number; redactions: number } {
  const headers = new Map<string, string>(); let redactions = 0;
  for (let i = 0; i < Math.min(raw.length, max * 2); i += 2) {
    const name = raw[i].toLowerCase(); const value = headerValue(name, raw[i + 1], secrets);
    if (value === '[REDACTED]') redactions++;
    if (selected.includes(name)) headers.set(name, value);
  }
  return { headers: Object.fromEntries(headers), omitted: Math.max(0, raw.length / 2 - max), redactions };
}
/** Digest captured bytes, including a truthful prefix scope when truncated. */
export function bodyDigest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
