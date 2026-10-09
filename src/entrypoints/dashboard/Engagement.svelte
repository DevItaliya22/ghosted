<script lang="ts">
  import { liveQuery } from 'dexie';
  import { browser } from 'wxt/browser';
  import { repo } from '../../ui/repo';
  import { engagementTotals } from '../../core/engagement';
  import { timeAgo } from '../../ui/format';
  import Icon from '../../ui/Icon.svelte';
  import type { EngagementTweetRow } from '../../db/schema';

  let { ownerId, goTweet }: { ownerId: string; goTweet: (id: string) => void } = $props();

  type SortKey = 'posted' | 'scanned' | 'text' | 'replies' | 'followed' | 'alreadyFollowing' | 'repliedOnly';
  type Row = EngagementTweetRow & {
    totals: ReturnType<typeof engagementTotals>;
  };

  let dialog = $state<HTMLDialogElement | null>(null);
  let link = $state('');
  let error = $state('');
  let adding = $state(false);
  let query = $state('');
  let sort = $state<SortKey>('posted');
  let dir = $state<'asc' | 'desc'>('desc');
  let scanning = $state<string | null>(null);
  let scanError = $state('');

  const data = liveQuery(async () => {
    const [tweets, replies] = await Promise.all([
      repo.listEngagementTweets(ownerId),
      repo.db.engagementReplies.where('ownerId').equals(ownerId).toArray(),
    ]);
    const byTweet = new Map<string, typeof replies>();
    for (const r of replies) {
      const list = byTweet.get(r.tweetId) ?? [];
      list.push(r);
      byTweet.set(r.tweetId, list);
    }
    return tweets.map((t) => ({
      ...t,
      totals: engagementTotals(byTweet.get(t.tweetId) ?? []),
    }));
  });

  const rows = $derived.by((): Row[] => {
    const list = $data;
    if (!list) return [];
    const q = query.trim().toLowerCase();
    let out = q
      ? list.filter(
          (t) =>
            (t.text ?? '').toLowerCase().includes(q) ||
            t.tweetId.includes(q) ||
            `tweet ${t.tweetId}`.includes(q),
        )
      : [...list];
    const sign = dir === 'asc' ? 1 : -1;
    const num = (v: number | undefined, empty: number) => v ?? empty;
    const emptyNum = dir === 'asc' ? Number.POSITIVE_INFINITY : -1;
    out.sort((a, b) => {
      if (sort === 'text') {
        const ta = (a.text || a.tweetId).toLowerCase();
        const tb = (b.text || b.tweetId).toLowerCase();
        return sign * ta.localeCompare(tb, undefined, { sensitivity: 'base' });
      }
      if (sort === 'posted') return sign * (a.postedAt - b.postedAt);
      if (sort === 'scanned') {
        return sign * (num(a.lastScannedAt, emptyNum) - num(b.lastScannedAt, emptyNum));
      }
      if (sort === 'replies') return sign * (a.totals.replies - b.totals.replies);
      if (sort === 'followed') return sign * (a.totals.followed - b.totals.followed);
      if (sort === 'alreadyFollowing') return sign * (a.totals.alreadyFollowing - b.totals.alreadyFollowing);
      return sign * (a.totals.repliedOnly - b.totals.repliedOnly);
    });
    return out;
  });

  function tweetIdFrom(raw: string): string | null {
    const s = raw.trim();
    if (/^\d+$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (!/(^|\.)(x|twitter)\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/\/status(?:es)?\/(\d+)/);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  }

  function openAdd() {
    link = '';
    error = '';
    dialog?.showModal();
    queueMicrotask(() => dialog?.querySelector('input')?.focus());
  }

  function closeAdd() {
    dialog?.close();
  }

  async function add() {
    error = '';
    const tweetId = tweetIdFrom(link);
    if (!tweetId) {
      error = 'Paste an x.com /status/ link or tweet id.';
      return;
    }
    adding = true;
    await repo.saveEngagementTweet({ ownerId, tweetId, postedAt: Date.now() });
    adding = false;
    closeAdd();
    goTweet(tweetId);
  }

  function toggleSort(key: SortKey) {
    if (sort === key) dir = dir === 'asc' ? 'desc' : 'asc';
    else {
      sort = key;
      dir = key === 'text' ? 'asc' : 'desc';
    }
  }

  function sortMark(key: SortKey) {
    if (sort !== key) return '';
    return dir === 'asc' ? ' ↑' : ' ↓';
  }

  async function scan(tweetId: string, e?: Event) {
    e?.stopPropagation();
    scanning = tweetId;
    scanError = '';
    const r = (await browser.runtime.sendMessage({ type: 'start-engagement-scan', tweetId })) as {
      ok: boolean;
      error?: string;
    };
    scanning = null;
    if (!r?.ok) scanError = r?.error ?? 'Could not start the scan.';
  }

  function preview(t: Row) {
    const s = t.text?.trim();
    if (s) return s.length > 120 ? `${s.slice(0, 117)}…` : s;
    return `Tweet ${t.tweetId}`;
  }
</script>

<header class="row head">
  <div class="grow">
    <h2>Engagement tweets</h2>
  </div>
  <button class="primary" type="button" onclick={openAdd}>Add</button>
</header>

{#if scanError}<p class="bad">{scanError}</p>{/if}

{#if !$data}
  <!-- loading -->
{:else if $data.length === 0}
  <div class="card empty muted">No engagement tweets yet.</div>
{:else}
  <div class="filters">
    <input class="search" placeholder="Search post text or tweet id" bind:value={query} />
    <label class="field">
      <span class="muted">Sort</span>
      <select bind:value={sort}>
        <option value="posted">Posted</option>
        <option value="scanned">Last scanned</option>
        <option value="text">Post</option>
        <option value="replies">Replies</option>
        <option value="followed">Followed</option>
        <option value="alreadyFollowing">Already following</option>
        <option value="repliedOnly">Replied only</option>
      </select>
    </label>
    <button type="button" class="dir" onclick={() => (dir = dir === 'asc' ? 'desc' : 'asc')}>
      {dir === 'asc' ? 'Asc ↑' : 'Desc ↓'}
    </button>
    <span class="muted count">{rows.length} posts</span>
  </div>

  <div class="card wrap">
    <table>
      <thead>
        <tr>
          <th class="post"><button type="button" class="th" onclick={() => toggleSort('text')}>Post{sortMark('text')}</button></th>
          <th><button type="button" class="th" onclick={() => toggleSort('posted')}>Posted{sortMark('posted')}</button></th>
          <th><button type="button" class="th" onclick={() => toggleSort('scanned')}>Scanned{sortMark('scanned')}</button></th>
          <th class="num"><button type="button" class="th" onclick={() => toggleSort('replies')}>Replies{sortMark('replies')}</button></th>
          <th class="num"><button type="button" class="th" onclick={() => toggleSort('followed')}>Followed{sortMark('followed')}</button></th>
          <th class="num"><button type="button" class="th" onclick={() => toggleSort('alreadyFollowing')}>Already{sortMark('alreadyFollowing')}</button></th>
          <th class="num"><button type="button" class="th" onclick={() => toggleSort('repliedOnly')}>Replied only{sortMark('repliedOnly')}</button></th>
          <th class="actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as t (t.tweetId)}
          <tr>
            <td class="post">
              <div class="ellipsis" title={t.text || t.tweetId}>{preview(t)}</div>
              <a class="muted small" href="https://x.com/i/status/{t.tweetId}" target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>{t.tweetId}</a>
            </td>
            <td class="muted tabular">{timeAgo(t.postedAt)}</td>
            <td class="muted tabular">{t.lastScannedAt ? timeAgo(t.lastScannedAt) : '—'}</td>
            <td class="num tabular">{t.totals.replies}</td>
            <td class="num tabular">{t.totals.followed}</td>
            <td class="num tabular">{t.totals.alreadyFollowing}</td>
            <td class="num tabular">{t.totals.repliedOnly}</td>
            <td class="actions">
              <button type="button" onclick={() => goTweet(t.tweetId)}>View</button>
              <button type="button" class="row scan" disabled={scanning === t.tweetId} onclick={(e) => void scan(t.tweetId, e)}>
                <Icon name="scan" size={14} /> Scan
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<dialog
  bind:this={dialog}
  class="sheet"
  onclose={() => { link = ''; error = ''; }}
  onclick={(e) => { if (e.target === dialog) closeAdd(); }}
>
  <form method="dialog" class="panel" onsubmit={(e) => { e.preventDefault(); void add(); }}>
    <h3>Add engagement tweet</h3>
    <input placeholder="https://x.com/you/status/…" bind:value={link} autocomplete="off" />
    {#if error}<p class="bad">{error}</p>{/if}
    <div class="row actions">
      <button type="button" onclick={closeAdd}>Cancel</button>
      <button class="primary" type="submit" disabled={adding || !link.trim()}>Add</button>
    </div>
  </form>
</dialog>

<style>
  .empty { padding: 20px; }
  .filters {
    display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 10px;
  }
  .search { min-width: min(280px, 100%); flex: 1 1 200px; }
  .field { display: grid; gap: 4px; font-size: 12px; }
  .field select { min-width: 140px; }
  .dir { align-self: end; min-width: 76px; }
  .count { align-self: center; font-size: 12px; }
  .wrap { padding: 0; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 880px; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
  th { background: #ffffff06; font-weight: 600; font-size: 12px; color: var(--muted); white-space: nowrap; }
  tbody tr:hover { background: #ffffff06; }
  .th {
    all: unset; cursor: pointer; color: inherit; font: inherit; font-weight: inherit;
  }
  .th:hover { color: var(--text); }
  .post { max-width: 280px; min-width: 160px; }
  .num { text-align: right; white-space: nowrap; }
  th.num, td.num { text-align: right; }
  .actions { text-align: right; white-space: nowrap; }
  .actions button { font-size: 12px; padding: 4px 10px; margin-left: 4px; }
  .scan { display: inline-flex; align-items: center; gap: 4px; }
  .small { font-size: 11px; display: block; margin-top: 4px; }

  .sheet {
    border: 0; padding: 0; background: transparent; max-width: calc(100% - 32px);
  }
  .sheet::backdrop { background: #0a0a098f; backdrop-filter: blur(2px); }
  .panel {
    width: min(440px, 100%); margin: auto; padding: 20px; display: grid; gap: 12px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 16px 48px #000a;
  }
  .panel h3 { margin: 0; font-size: 18px; color: var(--amber); }
  .panel input { width: 100%; }
  .panel .actions { justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .bad { margin: 0; font-size: 13px; }
</style>
