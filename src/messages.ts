import type { ListKind } from './core/types';
import type { Pace } from './core/pace';
import type { ScanStatus } from './db/schema';

export const CHANNEL = 'ghosted';

export type ScrollKind = ListKind | 'replies';

/** Page (MAIN world) -> bridge (isolated world), via window.postMessage. */
export interface PageCapture {
  channel: typeof CHANNEL;
  url: string;
  status: number;
  body: unknown;
  /** Request body, only for captured unfollow / CreateTweet requests. */
  requestBody?: string;
}

/** Bridge -> background. */
export type ToBackground =
  | { type: 'capture'; url: string; status: number; body: unknown; requestBody?: string }
  | { type: 'bridge-ready'; path: string }
  | { type: 'owner-handle'; handle: string }
  | { type: 'scan-finished'; kind: ScrollKind; outcome: 'complete' | 'invalid' | 'stopped' | 'timeout' | 'rate-limited' }
  | { type: 'start-scan'; kinds: ListKind[] }
  | { type: 'start-engagement-scan'; tweetId: string }
  | { type: 'set-engagement-mark'; on: boolean }
  | { type: 'resolve-review'; scanId: number; accept: boolean }
  | { type: 'test-notify'; channel: 'browser' | 'telegram' | 'discord' | 'webhook' };

export interface CaptureReply {
  handled: boolean;
  ignored?: 'not-owner' | 'unknown-owner' | 'irrelevant';
  status?: ScanStatus | 'error' | 'collecting' | 'committed';
  reason?: string;
  collected?: number;
  expected?: number;
  kind?: ScrollKind;
  rateLimited?: boolean;
  /** The scan committed as the first one for this list: a starting point, so no changes yet. */
  baseline?: boolean;
}

export interface BridgeReadyReply {
  autoscroll: ScrollKind | null;
  /** Check speed chosen in Settings. */
  pace?: Pace;
  /** Position of this list in the check, for "1 of 2". */
  step?: { index: number; total: number };
}

export interface ScanFinishedReply {
  ok: boolean;
  /** The list the check moves on to, and roughly when its page opens (ms). */
  next?: { kind: ScrollKind; inMs: number };
}

export interface CommandReply {
  ok: boolean;
  error?: string;
}
