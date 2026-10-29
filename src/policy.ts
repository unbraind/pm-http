import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Boundary, Probe, ProbeInput } from './types.ts';
import { bound, digest, HttpError, label, reference, requireInput, resolveReference } from './core.ts';

/** Address resolver seam; socket destinations are still validated and pinned. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
/** Resolve with the operating system so hosts-file and address-family policy apply. */
async function resolveAddresses(host: string) { return lookup(host, { all: true, verbatim: true }); }

/** Restrict literal destinations conservatively, including IPv4-mapped IPv6. */
export function privateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (ip.includes(':')) return ip.startsWith('::') || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe') || ip.startsWith('ff') || !ip.startsWith('2') && !ip.startsWith('3');
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a >= 224 || a === 198 && (b === 18 || b === 19);
}
/** Parse canonical HTTP URLs without ambiguous credentials, encoded paths or fragments. */
export function parseUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new HttpError('invalid', 'Expected an absolute HTTP URL'); }
  requireInput(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !/%|\\/.test(url.pathname) && !value.includes('\\'), 'URL must use HTTP(S), plain paths, and no userinfo or fragment');
  requireInput(value.length <= 4096, 'URL exceeds declaration ceiling'); return url;
}
/** Require every hop to retain the exact origin and canonical path-prefix segment. */
export function within(url: URL, boundary: Boundary, hop = 0): void {
  const prefix = boundary.prefix;
  if (url.origin !== boundary.origin || !(prefix === '/' || url.pathname === prefix || url.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) throw new HttpError('boundary', 'Redirect or request leaves the declared destination boundary', 'Declare and review a separate probe for that destination', { hop: String(hop), targetDigest: digest(url.href) });
}
/** Validate query templates without ever storing literal query values. */
function queryTemplate(url: URL): void { for (const [key, value] of url.searchParams) { requireInput(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(key), 'Query names must be short identifiers'); reference(value); } }
/** Keep opaque path identifiers in environment references rather than durable URLs. */
function pathTemplate(url: URL, boundary = false): void {
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    if (segment.startsWith('@') && !boundary) reference(segment);
    else requireInput(segment.length < 24 && /^[a-zA-Z0-9_.~-]+$/.test(segment), 'Opaque path segments require @ENV_NAME; boundaries need static short path segments');
  }
}
/** Normalize header declarations; opaque values can only be environment references. */
function requestHeaders(values: string[]): Record<string, string> {
  requireInput(values.length <= 32, 'At most 32 request headers are allowed');
  return Object.fromEntries(values.map(value => {
    const index = value.indexOf('='); requireInput(index > 0, 'Header needs name=value');
    const key = value.slice(0, index).toLowerCase(); const content = value.slice(index + 1);
    requireInput(/^[a-z][a-z0-9-]{0,63}$/.test(key) && !['host', 'content-length', 'transfer-encoding', 'connection', 'proxy-authorization'].includes(key), 'Unsupported request header');
    if (content.startsWith('@')) reference(content);
    else requireInput((key === 'accept' || key === 'content-type') && ['application/json', 'text/plain', '*/*'].includes(content) || key === 'user-agent' && content === 'pm-http', 'Opaque header values require @ENV_NAME');
    return [key, content];
  }));
}
/** Single declaration validator used by preview, apply and send recovery. */
export function makeProbe(name: string, input: ProbeInput): Probe {
  const url = parseUrl(input.url); queryTemplate(url); pathTemplate(url);
  const boundaryUrl = parseUrl(input.boundary ?? url.origin + '/');
  requireInput(!boundaryUrl.search, 'Boundary cannot contain a query');
  pathTemplate(boundaryUrl, true);
  const host = boundaryUrl.hostname.replace(/^\[|\]$/g, '');
  const boundary: Boundary = { origin: boundaryUrl.origin, prefix: boundaryUrl.pathname, private: input.boundary !== undefined && (host === 'localhost' || isIP(host) !== 0 && privateAddress(host)) };
  within(url, boundary);
  const method = (input.method ?? 'GET').toUpperCase(); requireInput(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method), 'Unsupported method');
  const body = input.body === undefined ? undefined : reference(input.body);
  requireInput(body === undefined || !['GET', 'HEAD', 'OPTIONS'].includes(method), 'Bodies require a mutating method and separate review');
  const responseHeaders = [...new Set((input.responseHeaders ?? ['content-type', 'content-length', 'cache-control', 'retry-after']).map(key => key.toLowerCase()))];
  requireInput(responseHeaders.length <= 32 && responseHeaders.every(key => /^[a-z][a-z0-9-]{0,63}$/.test(key)), 'Response header selection is invalid');
  return { name: label(name), method, url: url.href, headers: requestHeaders(input.headers ?? []), ...(body === undefined ? {} : { body }), boundary, maxBytes: bound(input.maxBytes ?? 65536, 1, 1048576), timeoutMs: bound(input.timeoutMs ?? 5000, 1, 60000), maxHeaders: bound(input.maxHeaders ?? 64, 1, 128), responseHeaders };
}
/** Determine whether an explicit separate review is required. */
export function mutating(probe: Probe): boolean { return !['GET', 'HEAD', 'OPTIONS'].includes(probe.method); }
/** Resolve the exact send-time request after all durable declarations have been checked. */
export function requestFor(probe: Probe, resolve: boolean): { url: URL; headers: Record<string, string>; body?: string; secrets: string[] } {
  if (mutating(probe) && probe.review?.allowMutation !== true) throw new HttpError('mutation_review', 'Mutating probe has no reviewed capability', 'Run pm http probe review with --allow-mutation and --reason');
  if (mutating(probe)) requireInput([probe.review!.author, probe.review!.reason, probe.review!.at].every(entry => typeof entry === 'string' && entry.trim().length > 0), 'Reviewed capability requires an author, reason and timestamp');
  const secrets: string[] = [];
  /** Resolve a declared reference and collect only its ephemeral value. */
  const value = (entry: string): string => { if (!resolve) return entry; const actual = resolveReference(entry); secrets.push(actual); return actual; };
  const url = new URL(probe.url);
  if (resolve) url.pathname = url.pathname.split('/').map(segment => { if (!segment.startsWith('@')) return segment; const actual = value(segment); requireInput(/^[a-zA-Z0-9_-]{1,128}$/.test(actual), 'Resolved path reference must be a bounded single identifier segment'); return actual; }).join('/');
  if (resolve) { const params = [...url.searchParams]; url.search = ''; for (const [key, ref] of params) url.searchParams.append(key, value(ref)); }
  const headers: Record<string, string> = { 'user-agent': 'pm-http', ...Object.fromEntries(Object.entries(probe.headers).map(([key, entry]) => [key, entry.startsWith('@') ? value(entry) : entry])) };
  requireInput(Object.values(headers).every(entry => !/[\r\n\u0000]/.test(entry) && entry.length <= 8192), 'Resolved request header is invalid');
  const body = probe.body === undefined ? undefined : value(probe.body); requireInput(body === undefined || Buffer.byteLength(body) <= 1048576, 'Request body exceeds the hard ceiling');
  return { url, headers, body, secrets };
}
/** Resolve and pin DNS before opening a socket; reject rebinding to private networks. */
export async function destination(url: URL, boundary: Boundary, resolver: Resolver = resolveAddresses): Promise<{ address: string; family: number }> {
  within(url, boundary); const host = url.hostname.replace(/^\[|\]$/g, '');
  let answers: { address: string; family: number }[];
  try { answers = await resolver(host); } catch { throw new HttpError('dns', 'Destination resolution failed', 'Check the declared host and retry explicitly'); }
  if (answers.some(answer => privateAddress(answer.address)) && !boundary.private) throw new HttpError('private_destination', 'Private, loopback or link-local destination lacks explicit authorization', 'Declare a boundary with the literal private address or localhost');
  requireInput(answers.length > 0, 'Destination has no addresses'); return answers[0];
}
