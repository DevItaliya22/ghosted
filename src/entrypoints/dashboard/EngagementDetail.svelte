<script lang="ts">
  import { liveQuery } from 'dexie';
  import { browser } from 'wxt/browser';
  import { repo } from '../../ui/repo';
  import { engagementTotals } from '../../core/engagement';
  import { timeAgo } from '../../ui/format';
  import StatTile from '../../ui/StatTile.svelte';
  import Person from '../../ui/Person.svelte';
  import Icon from '../../ui/Icon.svelte';
  import type { EngagementReplyRow, UserRow } from '../../db/schema';

  let { ownerId, tweetId, goBack }: { ownerId: string; tweetId: string; goBack: () => void } = $props();

  let busy = $state(false);
  let scanError = $state('');
  let filter = $state<'all' | 'followed' | 'replied_only' | 'already_following'>('all');

  const data = $derived(
    liveQuery(async () => {
      const [tweet, replies, users] = await Promise.all([
        repo.getEngagementTweet(ownerId, tweetId),
        repo.listEngagementReplies(ownerId, tweetId),
        repo.db.users.where('ownerId').equals(ownerId).toArray(),
      ]);
      return { tweet, replies, users: new Map(users.map((u) => [u.id, u])) };
    }),
  );

  const view = $derived.by(() => {
    const d = $data;
    if (!d?.tweet) return null;
    const totals = engagementTotals(d.replies);
    const rows = filter === 'all' ? d.replies : d.replies.filter((r) => r.status === filter);
    const total = Math.max(1, totals.replies);
    const chart = [
      { label: 'Followed', n: totals.followed, color: '#62d6d0' },
      { label: 'Already following', n: totals.alreadyFollowing, color: '#e0a33a' },
      { label: 'Replied only', n: totals.repliedOnly, color: '#f7f1e855' },
    ].map((p) => ({ ...p, pct: Math.round((p.n / total) * 100) }));
    return { tweet: d.tweet, totals, rows, users: d.users, chart };
  });

  const statusLabel = (s: EngagementReplyRow['status']) =>
    s === 'followed' || s === 'already_following' ? 'Following you' : 'Not following';

  function asUser(r: EngagementReplyRow, users: Map<string, UserRow>): UserRow {
    return (
      users.get(r.userId) ?? {
        ownerId,
        id: r.userId,
        handle: r.handle,
        name: r.name,
        avatarUrl: r.avatarUrl,
        firstSeenAt: 0,
        lastSeenAt: 0,
        handleHistory: [],
      }
    );
  }

  async function scan() {
    busy = true;
    scanError = '';
    const r = (await browser.runtime.sendMessage({ type: 'start-engagement-scan', tweetId })) as {
      ok: boolean;
      error?: string;
    };
    busy = false;
    if (!r?.ok) scanError = r?.error ?? 'Could not start the scan.';
  }
</script>

{#if view}
  {@const v = view}
  <header class="row head">
    <div class="grow">
      <button class="back muted" onclick={goBack}>← Engagement tweets</button>
      <h2 class="ellipsis">{v.tweet.text || `Tweet ${tweetId}`}</h2>
      <p class="muted">
        <a href="https://x.com/i/status/{tweetId}" target="_blank" rel="noopener">Open on X</a>
        · Posted {timeAgo(v.tweet.postedAt)}
        {#if v.tweet.lastScannedAt} · Scanned {timeAgo(v.tweet.lastScannedAt)}{/if}
      </p>
    </div>
    <button class="primary row" onclick={scan} disabled={busy}><Icon name="scan" size={16} /> Scan</button>
  </header>
  {#if scanError}<p class="bad">{scanError}</p>{/if}

  <section class="tiles">
    <StatTile label="Replies" value={v.totals.replies} />
    <StatTile label="Followed" value={v.totals.followed} />
    <StatTile label="Already following" value={v.totals.alreadyFollowing} />
    <StatTile label="Replied only" value={v.totals.repliedOnly} />
  </section>

  {#if v.totals.replies > 0}
    <section class="card chart">
      <div class="bar">
        {#each v.chart as p}
          {#if p.n > 0}<div class="seg" style="width:{p.pct}%;background:{p.color}" title="{p.label}: {p.n}"></div>{/if}
        {/each}
      </div>
      <div class="legend">
        {#each v.chart as p}
          <span><i style="background:{p.color}"></i>{p.label} {p.n}</span>
        {/each}
      </div>
    </section>
  {/if}

  <div class="filters row">
    {#each ([['all', 'All'], ['followed', 'Followed'], ['already_following', 'Already'], ['replied_only', 'Replied only']] as const) as [id, label]}
      <button class:active={filter === id} onclick={() => (filter = id)}>{label}</button>
    {/each}
  </div>

  <div class="table">
    {#each v.rows as r}
      <div class="row line">
        <Person
          handle={r.handle}
          user={asUser(r, v.users)}
          sub={`${statusLabel(r.status)} · reply ${r.replyTweetId ?? '?'}`}
        />
      </div>
    {:else}
      <p class="muted">No replies yet. Run a scan after people comment.</p>
    {/each}
  </div>
{/if}

<style>
  .back { background: none; border: 0; padding: 0; margin-bottom: 6px; cursor: pointer; }
  .back:hover { color: var(--text); }
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .chart { display: grid; gap: 10px; padding: 14px; }
  .bar { display: flex; height: 14px; border-radius: 99px; overflow: hidden; background: #ffffff12; }
  .seg { height: 100%; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--muted); }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 99px; margin-right: 6px; }
  .filters { gap: 6px; flex-wrap: wrap; }
  .filters button { font-size: 12px; padding: 4px 10px; }
  .filters button.active { background: #e0a33a1f; color: var(--amber); border-color: #e0a33a55; }
  .table { display: grid; gap: 2px; }
  .line { padding: 10px 4px; border-bottom: 1px solid var(--line); }
  @media (max-width: 760px) {
    .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
