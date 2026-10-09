<script lang="ts">
  import { liveQuery } from 'dexie';
  import { repo } from '../../ui/repo';
  import type { MembershipRow, UserRow } from '../../db/schema';
  import Person from '../../ui/Person.svelte';
  import VirtualList from '../../ui/VirtualList.svelte';
  import { download, toCsv } from '../../ui/format';

  type Mode = 'not-following-back' | 'fans' | 'mutuals';
  type SortKey = 'handle' | 'name' | 'followers' | 'following' | 'firstSeen' | 'lastSeen';
  type Tri = 'any' | 'yes' | 'no';

  let { ownerId, mode }: { ownerId: string; mode: Mode } = $props();
  type Row = MembershipRow & { user?: UserRow };

  const data = $derived(
    liveQuery(async () => {
      const [following, followers] = await Promise.all([repo.listMembers(ownerId, 'following'), repo.listMembers(ownerId, 'followers')]);
      return { following, followers };
    }),
  );

  const titles: Record<Mode, string> = {
    'not-following-back': 'Not following back',
    fans: 'Fans (you do not follow back)',
    mutuals: 'Mutuals',
  };

  let query = $state('');
  let sort = $state<SortKey>('followers');
  let dir = $state<'asc' | 'desc'>('desc');
  let verified = $state<Tri>('any');
  let protectedAcc = $state<Tri>('any');
  let minFollowers = $state('');

  const rows = $derived.by((): Row[] => {
    const d = $data;
    if (!d) return [];
    const followingIds = new Set(d.following.map((r) => r.userId));
    let list: Row[];
    if (mode === 'not-following-back') list = d.following.filter((r) => r.followsYou === false);
    else if (mode === 'fans') list = d.followers.filter((r) => !followingIds.has(r.userId));
    else list = d.following.filter((r) => r.followsYou === true);

    const q = query.trim().toLowerCase().replace(/^@/, '');
    const min = Number(minFollowers);
    const minN = Number.isFinite(min) && minFollowers.trim() !== '' ? min : null;

    list = list.filter((r) => {
      if (q && !r.handle.toLowerCase().includes(q) && !(r.user?.name ?? '').toLowerCase().includes(q)) return false;
      if (verified === 'yes' && !r.user?.isVerified) return false;
      if (verified === 'no' && r.user?.isVerified) return false;
      if (protectedAcc === 'yes' && !r.user?.isProtected) return false;
      if (protectedAcc === 'no' && r.user?.isProtected) return false;
      if (minN !== null && (r.user?.followersCount ?? 0) < minN) return false;
      return true;
    });

    const sign = dir === 'asc' ? 1 : -1;
    const num = (v: number | undefined) => v ?? (dir === 'asc' ? Number.POSITIVE_INFINITY : -1);
    return [...list].sort((a, b) => {
      if (sort === 'followers') return sign * (num(a.user?.followersCount) - num(b.user?.followersCount));
      if (sort === 'following') return sign * (num(a.user?.followingCount) - num(b.user?.followingCount));
      if (sort === 'firstSeen') return sign * (num(a.user?.firstSeenAt) - num(b.user?.firstSeenAt));
      if (sort === 'lastSeen') return sign * (num(a.user?.lastSeenAt) - num(b.user?.lastSeenAt));
      if (sort === 'name') {
        return sign * (a.user?.name || a.handle).localeCompare(b.user?.name || b.handle, undefined, { sensitivity: 'base' });
      }
      return sign * a.handle.localeCompare(b.handle, undefined, { sensitivity: 'base' });
    });
  });

  const missing = $derived(mode !== 'fans' && $data && $data.following.length === 0);
  const exportCsv = () =>
    download(
      `${mode}.csv`,
      toCsv(
        rows.map((r) => ({
          id: r.userId,
          handle: r.handle,
          name: r.user?.name,
          followers: r.user?.followersCount,
          following: r.user?.followingCount,
          verified: r.user?.isVerified,
          protected: r.user?.isProtected,
        })),
      ),
      'text/csv',
    );

  function sub(r: Row): string | undefined {
    const bits: string[] = [];
    if (r.user?.followersCount !== undefined) bits.push(`${r.user.followersCount.toLocaleString()} followers`);
    if (r.user?.followingCount !== undefined) bits.push(`${r.user.followingCount.toLocaleString()} following`);
    return bits.length ? bits.join(' · ') : undefined;
  }
</script>

<header class="row head">
  <h2 class="grow">{titles[mode]}</h2>
  <button onclick={exportCsv} disabled={!rows.length}>Export CSV</button>
</header>

{#if missing}
  <p class="muted">Scan your following list first.</p>
{:else if mode === 'fans' && $data && $data.followers.length === 0}
  <p class="muted">Scan your followers list first.</p>
{:else}
  <div class="filters">
    <input class="search" placeholder="Search name or @handle" bind:value={query} />
    <label class="field">
      <span class="muted">Sort</span>
      <select bind:value={sort}>
        <option value="followers">Their followers</option>
        <option value="following">Their following</option>
        <option value="handle">Handle</option>
        <option value="name">Name</option>
        <option value="firstSeen">First seen</option>
        <option value="lastSeen">Last seen</option>
      </select>
    </label>
    <button type="button" class="dir" onclick={() => (dir = dir === 'asc' ? 'desc' : 'asc')} title={dir === 'asc' ? 'Ascending' : 'Descending'}>
      {dir === 'asc' ? 'Asc ↑' : 'Desc ↓'}
    </button>
    <label class="field">
      <span class="muted">Verified</span>
      <select bind:value={verified}>
        <option value="any">Any</option>
        <option value="yes">Only</option>
        <option value="no">Hide</option>
      </select>
    </label>
    <label class="field">
      <span class="muted">Protected</span>
      <select bind:value={protectedAcc}>
        <option value="any">Any</option>
        <option value="yes">Only</option>
        <option value="no">Hide</option>
      </select>
    </label>
    <label class="field">
      <span class="muted">Min followers</span>
      <input type="number" min="0" placeholder="0" bind:value={minFollowers} />
    </label>
    <span class="muted count">{rows.length} accounts</span>
  </div>

  {#if rows.length}
    <VirtualList items={rows} rowHeight={56} height={620}>
      {#snippet row(r)}
        <Person handle={r.handle} user={r.user} sub={sub(r)} />
      {/snippet}
    </VirtualList>
  {:else}
    <p class="muted">Nothing here.</p>
  {/if}
{/if}

<style>
  .filters {
    display: flex; flex-wrap: wrap; align-items: end; gap: 10px;
  }
  .search { min-width: min(240px, 100%); flex: 1 1 180px; }
  .field { display: grid; gap: 4px; font-size: 12px; }
  .field select, .field input[type='number'] { min-width: 120px; }
  .field input[type='number'] { width: 100px; }
  .dir { align-self: end; min-width: 76px; }
  .count { margin-left: auto; align-self: center; }
</style>
