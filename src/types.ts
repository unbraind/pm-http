import type { PmClient, CommitWorkspaceTransactionOptions } from '@unbrained/pm-cli/sdk';

/** JSON shape without response values or property names. */
export interface Shape { type: string; properties?: Record<string, Shape>; items?: Shape[]; }
/** Explicit destination authorization; private addresses require a literal declaration. */
export interface Boundary { origin: string; prefix: string; private: boolean; }
/** A reviewed permission is separate from the request declaration. */
export interface Review { allowMutation: true; author: string; reason: string; at: string; }
/** Durable declaration; credentials and bodies are environment references only. */
export interface Probe {
  name: string; method: string; url: string; headers: Record<string, string>;
  body?: string; boundary: Boundary; maxBytes: number; timeoutMs: number;
  maxHeaders: number; responseHeaders: string[]; review?: Review;
}
/** Expected bounded response contract, with structural JSON keys hashed. */
export interface Contract { probe: string; statuses: number[]; headers: string[]; shape?: Shape; maxLatencyMs?: number; }
/** Truthful losses at the HTTP capture boundary. */
export interface CaptureReceipt { bodyTruncated: boolean; headersOmitted: number; shapeIncomplete: boolean; redactions: number; redirectsOmitted: number; digestScope: 'captured-prefix' | 'complete'; }
/** One historical response or uncertain transport outcome; never a live health claim. */
export interface Observation {
  id: string; probe: string; probeDigest: string; at: string; outcome: 'response' | 'uncertain';
  status?: number; headers: Record<string, string>; selectedHeaders?: string[]; shape?: Shape; digest?: string;
  bytes: number; timing: { dns?: number; connect?: number; tls?: number; firstByte?: number; total: number | null };
  redirects: string[]; receipt: CaptureReceipt;
  retry: { automaticRetries: 0; safeToRepeat: boolean; reason: string };
}
/** Durable send intent, including the exact revision-bound declaration digest. */
export interface Plan { id: string; probe: string; probeDigest: string; stage: 'planned' | 'sending' | 'received' | 'recorded' | 'cancelled'; observation?: Observation; expectedRevision?: number; guardRevision?: number; targetDigest?: string; reservedBytes?: number; }
/** Native task extension envelope. Every change increments revision. */
export interface State { version: 1; revision: number; probes: Probe[]; contracts: Contract[]; observations: Observation[]; plans: Plan[]; }
/** Public deterministic send/record boundaries used for fault injection. */
export type Step = 'validated' | 'plan-ready' | 'planned' | 'sending' | 'received' | 'record-ready' | 'recorded' | 'complete';
/** SDK integration options; no git dependency or implicit network execution. */
export interface Options {
  workspace: string; author?: string; client?: PmClient; backend?: 'filesystem' | 'remote';
  expectedRevision?: number; operationId?: string; signal?: AbortSignal;
  boundary?: (step: Step) => Promise<void> | void;
  onTransition?: CommitWorkspaceTransactionOptions['onTransition'];
}
/** Probe declaration input shared by CLI previews and SDK writes. */
export interface ProbeInput { url: string; method?: string; headers?: string[]; body?: string; boundary?: string; maxBytes?: number; timeoutMs?: number; maxHeaders?: number; responseHeaders?: string[]; }
/** A historical contract verdict, never a claim of present health. */
export interface Verdict { observation: string; probe: string; at: string; result: 'satisfies' | 'violates' | 'unknown'; reasons: string[]; }
/** Exact outstanding evidence request. */
export interface Missing { probe: string; evidence: 'observation' | 'contract' | 'complete-response'; }
