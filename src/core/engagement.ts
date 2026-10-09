import type { UserRecord } from './types';

export type EngagementReplyStatus = 'followed' | 'replied_only' | 'already_following';

export interface AttributedReply {
  userId: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  replyTweetId?: string;
  status: EngagementReplyStatus;
}

export function attributeReplies(
  replies: Array<{ user: UserRecord; replyTweetId: string }>,
  currentFollowerIds: Set<string>,
): AttributedReply[] {
  const out: AttributedReply[] = [];
  const seen = new Set<string>();
  for (const { user: u, replyTweetId } of replies) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({
      userId: u.id,
      handle: u.handle,
      name: u.name,
      avatarUrl: u.avatarUrl,
      replyTweetId,
      status: currentFollowerIds.has(u.id) ? 'already_following' : 'replied_only',
    });
  }
  return out;
}

export function engagementTotals(rows: AttributedReply[]) {
  let followed = 0;
  let repliedOnly = 0;
  let alreadyFollowing = 0;
  for (const r of rows) {
    if (r.status === 'followed') followed++;
    else if (r.status === 'replied_only') repliedOnly++;
    else alreadyFollowing++;
  }
  return { replies: rows.length, followed, repliedOnly, alreadyFollowing };
}
