import type { UserRecord } from './types';
import type { ParsedReplyAuthor } from './parse/tweet';

export interface EngagementReplyDraft {
  user: UserRecord;
  replyTweetId: string;
}

export interface EngagementScan {
  tabId: number;
  ownerId: string;
  handle: string;
  tweetId: string;
  replies: Record<string, EngagementReplyDraft>;
  startedAt: number;
}

export const newEngagementScan = (
  tabId: number,
  ownerId: string,
  handle: string,
  tweetId: string,
  now: number,
): EngagementScan => ({
  tabId,
  ownerId,
  handle,
  tweetId,
  replies: {},
  startedAt: now,
});

export const engagementUrl = (s: EngagementScan): string =>
  `https://x.com/${s.handle}/status/${s.tweetId}`;

const norm = (path: string) => path.toLowerCase().replace(/\/+$/, '');

export type EngagementBridgeAnswer = {
  autoscroll: 'replies' | null;
  waitForProfile: boolean;
};

export function answerEngagementBridge(
  s: EngagementScan | undefined,
  tabId: number | undefined,
  path: string,
): EngagementBridgeAnswer {
  const none = { autoscroll: null, waitForProfile: false };
  if (!s || tabId !== s.tabId) return none;
  const here = norm(path);
  return here === norm(`/${s.handle}/status/${s.tweetId}`)
    ? { autoscroll: 'replies', waitForProfile: false }
    : none;
}

export function mergeReplies(s: EngagementScan, page: ParsedReplyAuthor[], ownerId: string): EngagementScan {
  const replies = { ...s.replies };
  for (const row of page) {
    if (row.user.id === ownerId) continue;
    replies[row.user.id] = { user: row.user, replyTweetId: row.replyTweetId };
  }
  return { ...s, replies };
}

export function engagementStep(_s: EngagementScan): { index: number; total: number } {
  return { index: 1, total: 1 };
}
