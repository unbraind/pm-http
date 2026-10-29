import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { observations } from '../index.ts';
import type { Step } from '../index.ts';
import { investigation, environment } from './helpers.ts';

/** Run a real independent investigator, optionally killing it at a durable protocol boundary. */
async function child(root: string, workspace: string, item: string, operation: string, crash?: Step): Promise<boolean> {
  const file = join(root, `send-${operation}-${randomUUID()}.ts`);
  await writeFile(file, `import { send, HttpError } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\ntry { await send(${JSON.stringify(item)}, 'api', {workspace:process.env.PM_PATH!,author:'fixture',operationId:${JSON.stringify(operation)},boundary:async step=>{if(step===${JSON.stringify(crash)}){setInterval(()=>{},1000);console.log('crash-ready');await new Promise<void>(()=>{});}}}); console.log('finished'); } catch(error) { if(error instanceof HttpError && error.code==='conflict') process.exitCode=3; else throw error; }\n`);
  return new Promise<boolean>((resolve, reject) => {
    const instance = spawn(process.execPath, [file], { cwd: root, env: environment(root, workspace), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = ''; let killed = false;
    const timeout = setTimeout(() => { instance.kill('SIGKILL'); reject(new Error('Synthetic investigator deadline exceeded')); }, 180000);
    instance.stdout.on('data', chunk => { output += String(chunk); if (crash !== undefined && output.includes('crash-ready') && !killed) { killed = true; instance.kill('SIGKILL'); } });
    instance.stderr.on('data', chunk => { error += String(chunk); });
    instance.on('error', reject); instance.on('exit', (code, signal) => { clearTimeout(timeout); if (crash === undefined && code === 3) resolve(false); else if (crash === undefined ? code === 0 : killed && signal === 'SIGKILL') resolve(true); else reject(new Error(`Synthetic investigator failed: ${error}`)); });
  });
}

test('independent processes preserve distinct sends and serialize the same operation identity', async t => {
  const f = await investigation(t);
  for (const ids of [['one', 'two'], ['shared', 'shared']]) {
    const settled = await Promise.allSettled(ids.map(id => child(f.root, f.workspace, f.item, id)));
    for (const [index, result] of settled.entries()) {
      if (result.status === 'rejected') throw result.reason;
      if (!result.value) assert.ok(await child(f.root, f.workspace, f.item, ids[index]));
    }
  }
  assert.equal(f.count.calls, 3); const rows = (await observations(f.item, f.options)).observations; assert.equal(rows.length, 3); assert.equal(new Set(rows.map(row => row.id)).size, 3);
});

for (const point of ['validated', 'plan-ready', 'planned', 'sending', 'received', 'record-ready', 'recorded', 'complete'] as const) test(`SIGKILL at ${point} recovers dead leases and converges without duplicate observations`, async t => {
  const f = await investigation(t);
  await child(f.root, f.workspace, f.item, 'crashed', point); await child(f.root, f.workspace, f.item, 'crashed'); await child(f.root, f.workspace, f.item, 'crashed');
  const rows = (await observations(f.item, f.options)).observations; assert.equal(rows.length, 1); assert.ok(f.count.calls <= 1); assert.equal(rows[0].outcome, point === 'sending' ? 'uncertain' : 'response');
});
