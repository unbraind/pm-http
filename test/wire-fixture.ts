import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import type { RequestListener } from 'node:http';
import type { ServerOptions } from 'node:https';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { listen } from './helpers.ts';

/** Fail by assertion when a transport promise outlives its deadline, without leaving a test waiting on it. */
export async function bounded<T>(action: Promise<T>, milliseconds = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([action.then(value => ({ value })), new Promise<{ pending: true }>(resolve => { timer = setTimeout(() => resolve({ pending: true }), milliseconds); })]);
    assert.ok('value' in result, 'Transport did not settle after its timeout or terminal event'); return result.value;
  } finally { clearTimeout(timer); }
}

/** Serve real adversarial HTTP wires and destroy even detached upgrade sockets during fixture cleanup. */
export async function wireServer(t: TestContext, tls?: ServerOptions) {
  const sockets = new Set<Socket>(); const calls: string[] = []; const secret = randomBytes(24).toString('hex');
  const handler: RequestListener = (request, response) => {
    const path = request.url!; calls.push(path); const socket = response.socket!;
    if (path === '/ok') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); }
    else if (path === '/slow') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); setTimeout(() => response.end('}'), 30); }
    else if (path === '/silent') { /* Keep an ordinary request open until its absolute deadline or cancellation. */ }
    else if (path === '/only-info') socket.write('HTTP/1.1 103 Early Hints\r\nLink: </fixture>\r\n\r\n');
    else if (path === '/reset') socket.destroy();
    else if (path === '/broken') socket.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort');
    else if (path === '/partial') socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort');
    else if (path === '/bare') socket.write('HTTP/1.1 101 Switching Protocols\r\nContent-Length: 0\r\n\r\n');
    else {
      if (path === '/info') socket.write('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </fixture>\r\n\r\n');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\nSet-Cookie: value=' + secret + '\r\nX-Trace: ' + secret + '\r\n\r\n' + secret.repeat(1024));
      if (path === '/closed') socket.end();
    }
  };
  const instance = tls === undefined ? httpServer(handler) : httpsServer(tls, handler);
  instance.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const service = await listen(t, instance, tls === undefined ? 'http' : 'https'); return { ...service, sockets, calls, secret };
}
