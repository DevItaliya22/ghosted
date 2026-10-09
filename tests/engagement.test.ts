import { describe, expect, it } from 'vitest';
import { attributeReplies, engagementTotals } from '../src/core/engagement';
import { createTweetIsReply, parseCreatedTweet, parseTweetPage } from '../src/core/parse/tweet';
import { parseOperationUrl } from '../src/core/parse/operations';

const u = (id: string, handle = `u${id}`) => ({ id, handle, name: handle });

describe('attributeReplies', () => {
  it('marks followers who replied as already_following', () => {
    const rows = attributeReplies(
      [
        { user: u('1'), replyTweetId: '101' },
        { user: u('2'), replyTweetId: '102' },
      ],
      new Set(['1']),
    );
    expect(rows.map((r) => `${r.userId}:${r.status}`)).toEqual(['1:already_following', '2:replied_only']);
  });

  it('totals match statuses', () => {
    const rows = attributeReplies(
      [
        { user: u('1'), replyTweetId: '101' },
        { user: u('2'), replyTweetId: '102' },
      ],
      new Set(['1']),
    );
    expect(engagementTotals(rows)).toEqual({ replies: 2, followed: 0, repliedOnly: 1, alreadyFollowing: 1 });
  });
});

describe('parseCreatedTweet', () => {
  it('finds rest_id in CreateTweet-shaped body', () => {
    const body = {
      data: {
        create_tweet: {
          tweet_results: {
            result: { __typename: 'Tweet', rest_id: '99', legacy: { full_text: 'hi' } },
          },
        },
      },
    };
    expect(parseCreatedTweet(body)).toEqual({ tweetId: '99', text: 'hi' });
  });
});

describe('createTweetIsReply', () => {
  it('detects reply variables', () => {
    expect(createTweetIsReply(JSON.stringify({ variables: { reply: { in_reply_to_tweet_id: '1' } } }))).toBe(true);
    expect(createTweetIsReply(JSON.stringify({ variables: { tweet_text: 'x' } }))).toBe(false);
  });
});

describe('parseTweetPage', () => {
  it('collects primary reply authors and skips nested thread replies', () => {
    const body = {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                {
                  entryId: 'tweet-10',
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: 'Tweet',
                          rest_id: '10',
                          legacy: { in_reply_to_status_id_str: '9' },
                          core: {
                            user_results: {
                              result: { __typename: 'User', rest_id: 'me', legacy: { screen_name: 'me', name: 'Me' } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                {
                  entryId: 'conversationthread-20',
                  content: {
                    items: [
                      {
                        item: {
                          itemContent: {
                            tweet_results: {
                              result: {
                                __typename: 'Tweet',
                                rest_id: '20',
                                legacy: { in_reply_to_status_id_str: '10' },
                                core: {
                                  user_results: {
                                    result: {
                                      __typename: 'User',
                                      rest_id: '7',
                                      legacy: { screen_name: 'bob', name: 'Bob' },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                      {
                        item: {
                          itemContent: {
                            tweet_results: {
                              result: {
                                __typename: 'Tweet',
                                rest_id: '21',
                                legacy: { in_reply_to_status_id_str: '20' },
                                core: {
                                  user_results: {
                                    result: {
                                      __typename: 'User',
                                      rest_id: '8',
                                      legacy: { screen_name: 'carol', name: 'Carol' },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
                {
                  entryId: 'cursor-bottom-abc',
                  content: { value: 'cursor1', cursorType: 'Bottom' },
                },
              ],
            },
          ],
        },
      },
    };
    const page = parseTweetPage(body, '10');
    expect(page?.replies.map((x) => x.user.id)).toEqual(['7']);
    expect(page?.replies[0]?.replyTweetId).toBe('20');
    expect(page?.bottomCursor).toBe('cursor1');
  });
});

describe('parseOperationUrl tweet ops', () => {
  it('recognises CreateTweet and TweetDetail', () => {
    expect(parseOperationUrl('https://x.com/i/api/graphql/abc/CreateTweet')?.op).toBe('CreateTweet');
    expect(
      parseOperationUrl(
        'https://x.com/i/api/graphql/abc/TweetDetail?variables=' +
          encodeURIComponent(JSON.stringify({ focalTweetId: '55' })),
      ),
    ).toMatchObject({ op: 'TweetDetail', tweetId: '55' });
  });
});
