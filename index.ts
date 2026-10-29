import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import { register } from './src/commands.ts';
import { guarded } from './src/core.ts';
import * as api from './src/api.ts';
import * as derive from './src/derive.ts';
/** Declare an immutable task-bound request. */
export const addProbe = guarded(api.addProbe);
/** Record a separate reviewed mutation capability. */
export const reviewProbe = guarded(api.reviewProbe);
/** Read complete request declarations. */
export const listProbes = guarded(api.listProbes);
/** Preview without resolving credentials or writing. */
export const preview = guarded(api.preview);
/** Execute one explicit journaled send; stable operation identities recover without duplicate effects. */
export const send = guarded(api.send);
/** Set an explicit bounded response expectation. */
export const setContract = guarded(api.setContract);
/** Read secret-free historical observations in process. */
export const observations = guarded(derive.observations);
/** Compare stored observations to current explicit contracts. */
export const compare = guarded(derive.compare);
/** Produce historical differences under a self-inclusive token budget. */
export const differencePacket = guarded(derive.differencePacket);
/** Enumerate exact outstanding evidence requests. */
export const missingEvidence = guarded(derive.missingEvidence);
/** Typed refusals with safe diagnostics and remedies. */
export { HttpError } from './src/core.ts';
/** Documented integration and durable record contracts. */
export type { Options, ProbeInput, Probe, Observation, Contract, Shape, State, Plan, Missing, Verdict, Step, Boundary, Review, CaptureReceipt } from './src/types.ts';
/** Native host integration; no request runs on activation. */
export default defineExtension({ name: 'pm-http', version: '2026.10.29', description: 'Task-scoped explicit HTTP investigation context', activate: register });
