import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { bodyDigest, bodyShape, captureHeaders } from './capture.ts';
import { HttpError, digest } from './core.ts';
import { destination, mutating, parseUrl, requestFor, within } from './policy.ts';
import type { Resolver } from './policy.ts';
import type { Observation, Probe } from './types.ts';

/** Construct a conservative terminal uncertainty without inventing a response. */
export function uncertain(id: string, probe: Probe, reason: string, total: number | null = null): Observation {
  return { id, probe: probe.name, probeDigest: digest(probe), at: new Date().toISOString(), outcome: 'uncertain', headers: {}, selectedHeaders: probe.responseHeaders, bytes: 0, timing: { total }, redirects: [], receipt: { bodyTruncated: false, headersOmitted: 0, shapeIncomplete: true, redactions: 0, redirectsOmitted: 0, digestScope: 'captured-prefix' }, retry: { automaticRetries: 0, safeToRepeat: !mutating(probe), reason } };
}
/** Send exactly once per hop with one total deadline, DNS pinning, and no automatic retries. */
export async function capture(id: string, probe: Probe, caller?: AbortSignal, resolver?: Resolver): Promise<Observation> {
  const request = requestFor(probe, true); const started = performance.now();
  const controller = new AbortController();
  /** Preserve caller cancellation separately from timeouts. */
  const cancel = (): void => controller.abort();
  caller?.addEventListener('abort', cancel, { once: true }); if (caller?.aborted) cancel();
  const timer = setTimeout(cancel, probe.timeoutMs); const redirects: string[] = [];
  const timing: Observation['timing'] = { total: 0 };
  /** Interrupt DNS as well as socket IO without logging raw resolver errors. */
  async function addressFor(url: URL) {
    if (controller.signal.aborted) throw new HttpError('timeout', 'Request deadline elapsed');
    const cancellation = Promise.withResolvers<never>();
    /** Cancel the pending DNS phase at the same total deadline as socket work. */
    const abort = (): void => { cancellation.reject(new HttpError('timeout', 'Request deadline elapsed')); };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await Promise.race([destination(url, probe.boundary, resolver), cancellation.promise]);
      timing.dns = performance.now() - started; return result;
    } finally { controller.signal.removeEventListener('abort', abort); }
  }
  try {
    let url = request.url; let remainingBytes = probe.maxBytes;
    for (let hop = 0; hop <= 5; hop++) {
      within(url, probe.boundary, hop); const address = await addressFor(url);
      const response = await new Promise<{ status: number; raw: string[]; bytes: Buffer; truncated: boolean; location?: string }>((resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: probe.method, headers: request.headers, signal: controller.signal, agent: false, family: address.family, maxHeaderSize: 16384, lookup: (_host, _options, done) => done(null, address.address, address.family) }, res => {
          timing.firstByte = performance.now() - started;
          const chunks: Buffer[] = []; let size = 0; let settled = false;
          /** Settle exactly once and close a capped stream promptly. */
          const finish = (truncated: boolean): void => { if (settled) return; settled = true; resolve({ status: res.statusCode!, raw: res.rawHeaders, bytes: Buffer.concat(chunks), truncated, location: res.headers.location }); if (truncated) res.destroy(); };
          res.on('data', (chunk: Buffer) => { const remaining = remainingBytes - size; chunks.push(chunk.subarray(0, remaining)); size += Math.min(chunk.length, remaining); if (chunk.length > remaining) finish(true); });
          res.on('end', () => finish(false)); res.on('error', reject);
        });
        req.on('socket', socket => { socket.once('connect', () => { timing.connect = performance.now() - started; }); socket.once('secureConnect', () => { timing.tls = performance.now() - started; }); });
        req.maxHeadersCount = 0; // The parser's 16 KiB byte cap bounds allocation; count the full header set truthfully.
        req.on('error', reject); req.end(request.body);
      });
      remainingBytes -= response.bytes.length;
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && response.location !== undefined;
      const redirectsOmitted = isRedirect && (response.truncated || remainingBytes === 0) ? 1 : 0;
      if (isRedirect && redirectsOmitted === 0) {
        // Never reinterpret a reviewed mutation as a GET or resend its body automatically.
        if (mutating(probe)) throw new HttpError('mutation_redirect', 'Mutating redirects require a separate reviewed probe', 'Inspect the response and declare the redirect destination explicitly');
        let next: URL; try { if (response.location!.includes('\\')) throw new Error(); next = parseUrl(new URL(response.location!, url).href); } catch { throw new HttpError('redirect', 'Redirect target is not an admissible HTTP destination', 'Declare a separate safe probe after reviewing the redirect'); }
        within(next, probe.boundary, hop + 1);
        // Redirect queries are remote data, so only a digest enters durable context.
        redirects.push(digest(next.href)); url = next; continue;
      }
      const selected = captureHeaders(response.raw, probe.responseHeaders, probe.maxHeaders, request.secrets);
      let shape; let shapeIncomplete = response.truncated;
      if (!response.truncated && response.bytes.length > 0 && selected.headers['content-type'] === 'application/json') {
        try { const result = bodyShape(JSON.parse(response.bytes.toString('utf8'))); shape = result.shape; shapeIncomplete = result.incomplete; } catch { shapeIncomplete = true; }
      }
      timing.total = performance.now() - started;
      return { id, probe: probe.name, probeDigest: digest(probe), at: new Date().toISOString(), outcome: 'response', status: response.status, headers: selected.headers, selectedHeaders: probe.responseHeaders, ...(shape === undefined ? {} : { shape }), digest: bodyDigest(response.bytes), bytes: response.bytes.length, timing, redirects, receipt: { bodyTruncated: response.truncated, headersOmitted: selected.omitted, shapeIncomplete, redactions: selected.redactions, redirectsOmitted, digestScope: response.truncated ? 'captured-prefix' : 'complete' }, retry: { automaticRetries: 0, safeToRepeat: !mutating(probe), reason: 'No automatic retries; repeat only by explicit new operation' } };
    }
  } catch (error) {
    if (caller?.aborted) throw new HttpError('cancelled', 'Send cancelled without an observation', 'Use a new operation identity for any explicitly reviewed retry');
    if (error instanceof HttpError && error.code !== 'timeout') throw error;
    return uncertain(id, probe, 'Transport outcome uncertain; no automatic retry', performance.now() - started);
  } finally { clearTimeout(timer); caller?.removeEventListener('abort', cancel); }
  throw new HttpError('redirect_limit', 'Redirect chain exceeds five hops', 'Declare a probe for the final authorized destination');
}
