import { readFile } from 'node:fs/promises';
import { createPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from '@unbrained/pm-cli/sdk/authoring';
import { addProbe, listProbes, preview, reviewProbe, send, setContract } from './api.ts';
import { compare, differencePacket, missingEvidence } from './derive.ts';
import { HttpError, requireInput, wire } from './core.ts';
import { FIELDS } from './store.ts';

/** Reject absent or array operands without echoing untrusted data. */
function text(value: unknown): string { requireInput(typeof value === 'string', 'Required text operand is missing'); return value; }
/** Preserve repeated header flags and status sets. */
function texts(value: unknown): string[] { return value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(text); }
/** Parse an optional integral flag without silently accepting empty inputs. */
function number(value: unknown): number | undefined { if (value === undefined) return undefined; requireInput(typeof value === 'string' && /^\d+$/.test(value), 'Numeric flag requires a nonnegative integer'); const parsed = Number(value); requireInput(Number.isSafeInteger(parsed), 'Numeric flag exceeds the safe integer range'); return parsed; }
/** Convert one refusal into the native host's safe expected-error contract. */
function expected(error: unknown) {
  const refusal = error instanceof HttpError ? error : new HttpError('sdk', 'HTTP context command failed', 'Check tracker health, schema file and access before retrying');
  return createPmCliExpectedError(`http ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: refusal.code === 'cancelled' ? 130 : refusal.code === 'conflict' ? 3 : 2, context: { code: refusal.code, ...refusal.details, required: refusal.remedy, recovery: { attempted_command: 'pm http [arguments omitted]', normalized_args: [], provided_fields: [] } } });
}
/** Execute through the native host renderer and structured expected-error boundary. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<unknown> {
  const controller = new AbortController();
  /** Make SIGINT a cancellation that cannot leave a partial observation. */
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const flags = ctx.options; const item = text(ctx.args[0]);
    const options = { workspace: ctx.pm_root, author: ctx.global.author, client: ctx.sdk?.client, operationId: flags.operation === undefined ? undefined : text(flags.operation), expectedRevision: number(flags.expectedRevision), signal: controller.signal };
    if (command === 'probe add') return await addProbe(item, text(ctx.args[1]), { url: text(flags.url), method: flags.method === undefined ? undefined : text(flags.method), headers: texts(flags.header), body: flags.body === undefined ? undefined : text(flags.body), boundary: flags.boundary === undefined ? undefined : text(flags.boundary), maxBytes: number(flags.maxBytes), timeoutMs: number(flags.timeoutMs), maxHeaders: number(flags.maxHeaders), responseHeaders: flags.responseHeader === undefined ? undefined : texts(flags.responseHeader) }, options);
    if (command === 'probe review') { requireInput(flags.allowMutation === true, 'Review requires --allow-mutation'); return await reviewProbe(item, text(ctx.args[1]), text(flags.reason), options); }
    if (command === 'probe list') return await listProbes(item, options);
    if (command === 'send') return await (flags.dryRun === true ? preview : send)(item, text(ctx.args[1]), options);
    if (command === 'contract set') {
      let shape: unknown;
      if (flags.jsonShape !== undefined) { const bytes = await readFile(text(flags.jsonShape)); requireInput(bytes.length <= 16384, 'Contract shape file exceeds 16384 bytes'); shape = JSON.parse(bytes.toString('utf8')) as unknown; }
      return await setContract(item, text(ctx.args[1]), { statuses: texts(flags.status).map(value => number(value)!), shape, headers: texts(flags.requireHeader), maxLatencyMs: number(flags.maxLatencyMs) }, options);
    }
    if (command === 'compare') return await compare(item, { ...options, probe: ctx.args[1] });
    if (command === 'diff') return await differencePacket(item, { ...options, budget: number(flags.budget) });
    if (command === 'missing') return await missingEvidence(item, options);
  } catch (error) {
    throw expected(error);
  } finally { process.removeListener('SIGINT', cancel); }
  throw expected(new HttpError('invalid', 'Unknown HTTP command'));
}
/** Register all commands, scalar fields and native output renderers. */
export function register(api: ExtensionApi): void {
  api.registerItemFields(FIELDS);
  const definitions = [
    ['probe add', ['item', 'name'], ['url', 'method', 'header', 'body', 'boundary', 'max-bytes', 'timeout-ms', 'max-headers', 'response-header', 'expected-revision'], [], 'Declare a bounded request', 'pm http probe add task-id api --url https://example.com/api'],
    ['probe review', ['item', 'name'], ['reason', 'expected-revision'], ['allow-mutation'], 'Record a separate mutation review', 'pm http probe review task-id api --allow-mutation --reason "Reviewed controlled fixture mutation"'],
    ['probe list', ['item'], [], [], 'List request declarations', 'pm http probe list task-id'],
    ['send', ['item', 'probe'], ['operation', 'expected-revision'], ['dry-run'], 'Explicitly send or preview one probe', 'pm http send task-id api --dry-run'],
    ['contract set', ['item', 'probe'], ['status', 'json-shape', 'require-header', 'max-latency-ms', 'expected-revision'], [], 'Set a bounded response expectation', 'pm http contract set task-id api --status 200 --json-shape shape.json'],
    ['compare', ['item', 'probe'], [], [], 'Compare historical observations', 'pm http compare task-id'],
    ['diff', ['item'], ['budget'], [], 'Build a bounded historical difference packet', 'pm http diff task-id --budget 1500'],
    ['missing', ['item'], [], [], 'Name exact outstanding evidence', 'pm http missing task-id'],
  ] as const;
  for (const format of ['toon', 'json'] as const) api.registerRenderer(format, ctx => wire(ctx.result, format), { commands: definitions.map(([name]) => `http ${name}`) });
  for (const [name, args, strings, booleans, description, example] of definitions) {
    const flags: FlagDefinition[] = [...strings.map(flag => ({ long: `--${flag}`, description: `${flag}; ${example}`, value_type: 'string' as const, value_name: flag, repeatable: ['header', 'response-header', 'require-header', 'status'].includes(flag) })), ...booleans.map(flag => ({ long: `--${flag}`, description: `${flag}; ${example}`, value_type: 'boolean' as const }))];
    api.registerCommand(defineCommand({ name: `http ${name}`, description, intent: 'Context management for explicit HTTP investigations; observations are historical', arguments: args.map((arg, index) => ({ name: arg, description: arg, required: name !== 'compare' || index === 0 })), flags, examples: [example], run: ctx => runCommand(name, ctx) }));
  }
}
