import type { UserRecord } from '../types';
import { parseUserResult } from './user';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function findInstructions(node: unknown, depth = 0): unknown[] | null {
  if (depth > 10 || !isObj(node)) return null;
  if (Array.isArray(node.instructions)) return node.instructions;
  for (const value of Object.values(node)) {
    const found = findInstructions(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function cursorValue(entry: Obj): string | undefined {
  const content = isObj(entry.content) ? entry.content : {};
  const item = isObj(content.itemContent) ? content.itemContent : {};
  const v = content.value ?? item.value;
  return typeof v === 'string' ? v : undefined;
}

function tweetResult(node: unknown): Obj | null {
  if (!isObj(node)) return null;
  if (node.__typename === 'Tweet' || typeof node.rest_id === 'string') return node;
  if (isObj(node.tweet)) return tweetResult(node.tweet);
  if (isObj(node.result)) return tweetResult(node.result);
  return null;
}

function authorFromTweet(tweet: Obj): UserRecord | null {
  const core = isObj(tweet.core) ? tweet.core : {};
  const results = isObj(core.user_results) ? core.user_results : isObj(tweet.user_results) ? tweet.user_results : {};
  const parsed = parseUserResult(results.result);
  return parsed.kind === 'ok' ? parsed.user : null;
}

function tweetIdOf(tweet: Obj): string | undefined {
  return typeof tweet.rest_id === 'string' ? tweet.rest_id : undefined;
}

function collectTweetEntries(entries: Obj[]): Obj[] {
  const tweets: Obj[] = [];
  for (const entry of entries) {
    const content = isObj(entry.content) ? entry.content : {};
    const item = isObj(content.itemContent) ? content.itemContent : {};
    const tr = isObj(item.tweet_results) ? item.tweet_results : {};
    const one = tweetResult(tr.result ?? tr);
    if (one) tweets.push(one);
    if (Array.isArray(content.items)) {
      for (const sub of content.items) {
        if (!isObj(sub)) continue;
        const sc = isObj(sub.item) ? sub.item : sub;
        const si = isObj(sc.itemContent) ? sc.itemContent : {};
        const str = isObj(si.tweet_results) ? si.tweet_results : {};
        const nested = tweetResult(str.result ?? str);
        if (nested) tweets.push(nested);
      }
    }
  }
  return tweets;
}

export interface ParsedReplyAuthor {
  user: UserRecord;
  replyTweetId: string;
}

export interface ParsedTweetPage {
  replies: ParsedReplyAuthor[];
  bottomCursor?: string;
  topCursor?: string;
  warnings: number;
}

function inReplyToId(tweet: Obj): string | undefined {
  const legacy = isObj(tweet.legacy) ? tweet.legacy : {};
  if (typeof legacy.in_reply_to_status_id_str === 'string') return legacy.in_reply_to_status_id_str;
  if (typeof legacy.in_reply_to_status_id === 'number') return String(legacy.in_reply_to_status_id);
  return undefined;
}

/**
 * Authors of tweets in a conversation/detail timeline, excluding the root engagement tweet.
 * Returns null when the body has no recognisable timeline.
 */
export function parseTweetPage(body: unknown, rootTweetId?: string): ParsedTweetPage | null {
  const instructions = findInstructions(body);
  if (!instructions) return null;

  const entries: Obj[] = [];
  for (const ins of instructions) {
    if (!isObj(ins)) continue;
    if (ins.type === 'TimelineAddEntries' && Array.isArray(ins.entries)) {
      entries.push(...ins.entries.filter(isObj));
    } else if (ins.type === 'TimelineReplaceEntry' && isObj(ins.entry)) {
      entries.push(ins.entry);
    }
  }

  const page: ParsedTweetPage = { replies: [], warnings: 0 };
  for (const entry of entries) {
    const entryId = typeof entry.entryId === 'string' ? entry.entryId : '';
    if (entryId.startsWith('cursor-bottom')) {
      page.bottomCursor = cursorValue(entry) ?? page.bottomCursor;
      continue;
    }
    if (entryId.startsWith('cursor-top')) {
      page.topCursor = cursorValue(entry) ?? page.topCursor;
    }
  }

  const seen = new Set<string>();
  for (const tweet of collectTweetEntries(entries)) {
    const replyTweetId = tweetIdOf(tweet);
    if (!replyTweetId) continue;
    if (rootTweetId && replyTweetId === rootTweetId) continue;
    if (rootTweetId) {
      const parent = inReplyToId(tweet);
      if (parent !== rootTweetId) continue;
    }
    const user = authorFromTweet(tweet);
    if (!user) {
      page.warnings++;
      continue;
    }
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    page.replies.push({ user, replyTweetId });
  }
  return page;
}

/** Tweet id (+ optional text) from a successful CreateTweet response. */
export function parseCreatedTweet(body: unknown): { tweetId: string; text?: string } | null {
  const walk = (node: unknown, depth: number): { tweetId: string; text?: string } | null => {
    if (depth > 12 || !isObj(node)) return null;
    const tweet = tweetResult(node);
    if (tweet && typeof tweet.rest_id === 'string') {
      const legacy = isObj(tweet.legacy) ? tweet.legacy : {};
      const text = typeof legacy.full_text === 'string' ? legacy.full_text : typeof legacy.text === 'string' ? legacy.text : undefined;
      return { tweetId: tweet.rest_id, text };
    }
    for (const v of Object.values(node)) {
      const found = walk(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(body, 0);
}

/** True when CreateTweet variables look like a reply (not a root engagement post). */
export function createTweetIsReply(requestBody: string | undefined): boolean {
  if (!requestBody) return false;
  try {
    const parsed = JSON.parse(requestBody) as Obj;
    const vars = isObj(parsed.variables) ? parsed.variables : parsed;
    if (isObj(vars.reply) && vars.reply.in_reply_to_tweet_id) return true;
    if (typeof vars.in_reply_to_tweet_id === 'string' && vars.in_reply_to_tweet_id) return true;
  } catch {
    /* fall through */
  }
  return /"in_reply_to_tweet_id"\s*:\s*"\d+"/.test(requestBody);
}
