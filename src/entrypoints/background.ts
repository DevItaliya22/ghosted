import { browser } from 'wxt/browser';
import { ownerIdFromTwid } from '../core/owner';
import {
  isCreateTweetOp,
  isTweetTimelineOp,
  isUnfollowUrl,
  opToKind,
  parseOperationUrl,
  parseUnfollow,
} from '../core/parse/operations';
import { parseApiErrors, parseTimelinePage } from '../core/parse/timeline';
import { createTweetIsReply, parseCreatedTweet, parseTweetPage } from '../core/parse/tweet';
import { numericPaths, parseProfile, profileResult } from '../core/parse/user';
import type { ListKind } from '../core/types';
import { Repo, migrateLegacyDb } from '../db/repo';
import type {
  BridgeReadyReply,
  CaptureReply,
  CommandReply,
  ScanFinishedReply,
  ToBackground,
} from '../messages';
import { notifyEvents, sendBrowser, testChannel } from '../notify';
import { refreshBadge } from '../notify/badge';
import { findBoomerangs, withoutRepeats } from '../core/follows';
import type { EventRow } from '../db/schema';
import { PACES, asPace, randomIn } from '../core/pace';
import {
  PROFILE_WAIT_MS,
  advanceToList,
  afterKindDone,
  answerBridgeReady,
  newAutoScan,
  stepOf,
  urlFor,
  type AutoScan,
} from '../core/autoscan';
import {
  answerEngagementBridge,
  engagementStep,
  engagementUrl,
  mergeReplies,
  newEngagementScan,
  type EngagementScan,
} from '../core/engagement-scan';

const repo = new Repo();

const AUTOSCAN_TTL_MS = 3 * 60 * 60 * 1000;
const NEXT_LIST_ALARM = 'autoscan-next-list';
const DEFAULT_REMINDER_HOURS = 24;

let queue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

async function currentOwnerId(): Promise<string | undefined> {
  for (const url of ['https://x.com', 'https://twitter.com']) {
    try {
      const cookie = await browser.cookies.get({ url, name: 'twid' });
      const id = ownerIdFromTwid(cookie?.value);
      if (id) return id;
    } catch {
      /* try the next origin */
    }
  }
  return undefined;
}

async function setHealth(patch: Record<string, unknown>) {
  const prev = await repo.getSetting<Record<string, unknown>>('health', {});
  await repo.setSetting('health', { ...prev, ...patch });
}

async function autoScanIsStale(scan: AutoScan): Promise<boolean> {
  if (Date.now() - scan.startedAt > AUTOSCAN_TTL_MS) return true;
  try {
    const tab = await browser.tabs.get(scan.tabId);
    if (!tab.url || !/^https:\/\/(x|twitter)\.com\//.test(tab.url)) return true;
    const path = new URL(tab.url).pathname.toLowerCase().replace(/\/+$/, '');
    const want = new URL(urlFor(scan)).pathname.toLowerCase().replace(/\/+$/, '');
    return path !== want && Date.now() - scan.startedAt > 15_000;
  } catch {
    return true;
  }
}

async function getAutoScan(): Promise<AutoScan | undefined> {
  const { autoscan } = await browser.storage.session.get('autoscan');
  const scan = autoscan as AutoScan | undefined;
  if (!scan) return undefined;
  if (await autoScanIsStale(scan)) {
    await browser.storage.session.remove('autoscan');
    return undefined;
  }
  return scan;
}

async function engagementScanIsStale(scan: EngagementScan): Promise<boolean> {
  if (Date.now() - scan.startedAt > AUTOSCAN_TTL_MS) return true;
  try {
    const tab = await browser.tabs.get(scan.tabId);
    if (!tab.url || !/^https:\/\/(x|twitter)\.com\//.test(tab.url)) return true;
    const path = new URL(tab.url).pathname.toLowerCase().replace(/\/+$/, '');
    const want = new URL(engagementUrl(scan)).pathname.toLowerCase().replace(/\/+$/, '');
    return path !== want && Date.now() - scan.startedAt > 15_000;
  } catch {
    return true;
  }
}

async function getEngagementScan(): Promise<EngagementScan | undefined> {
  const { engagementScan } = await browser.storage.session.get('engagementScan');
  const scan = engagementScan as EngagementScan | undefined;
  if (!scan) return undefined;
  if (await engagementScanIsStale(scan)) {
    await browser.storage.session.remove('engagementScan');
    return undefined;
  }
  return scan;
}

async function setEngagementScan(scan: EngagementScan | null) {
  if (scan) await browser.storage.session.set({ engagementScan: scan });
  else await browser.storage.session.remove('engagementScan');
}

async function handleCapture(msg: Extract<ToBackground, { type: 'capture' }>, tabId?: number): Promise<CaptureReply> {
  const now = Date.now();
  const info = parseOperationUrl(msg.url);
  const unfollow = !info && isUnfollowUrl(msg.url);
  if (!info && !unfollow) return { handled: false, ignored: 'irrelevant' };

  const ownerId = await currentOwnerId();
  if (!ownerId) return { handled: false, ignored: 'unknown-owner' };
  if ((await repo.getSetting('ownerId', undefined)) !== ownerId) await repo.setSetting('ownerId', ownerId);

  if (unfollow) {
    const userId = msg.status >= 200 && msg.status < 300 ? parseUnfollow(msg.url, msg.requestBody, msg.body) : null;
    if (userId) await repo.recordMyUnfollow(ownerId, userId, now);
    return { handled: false, ignored: 'irrelevant' };
  }
  if (!info) return { handled: false, ignored: 'irrelevant' };

  if (isCreateTweetOp(info.op)) {
    if (msg.status < 200 || msg.status >= 300 || !msg.body) return { handled: true, ignored: 'irrelevant' };
    const { engagementMark } = await browser.storage.session.get('engagementMark');
    if (!engagementMark || createTweetIsReply(msg.requestBody)) return { handled: true, ignored: 'irrelevant' };
    const created = parseCreatedTweet(msg.body);
    if (created) {
      await repo.saveEngagementTweet({
        ownerId,
        tweetId: created.tweetId,
        text: created.text,
        postedAt: now,
      });
      await browser.storage.session.remove('engagementMark');
    }
    return { handled: true, ignored: 'irrelevant' };
  }

  if (isTweetTimelineOp(info.op)) {
    const eng = await getEngagementScan();
    if (!eng || (tabId !== undefined && tabId !== eng.tabId)) {
      return { handled: false, ignored: 'irrelevant' };
    }
    if (info.tweetId && info.tweetId !== eng.tweetId) return { handled: false, ignored: 'irrelevant' };

    if (msg.status === 429 || msg.status === 403) {
      return { handled: true, kind: 'replies', status: 'error', reason: `HTTP ${msg.status}`, rateLimited: true };
    }
    const apiError = parseApiErrors(msg.body);
    const page = msg.status >= 200 && msg.status < 300 && msg.body ? parseTweetPage(msg.body, eng.tweetId) : null;
    if (!page && apiError) {
      return {
        handled: true,
        kind: 'replies',
        status: 'error',
        reason: apiError.message,
        rateLimited: apiError.rateLimited,
      };
    }
    if (!page) return { handled: true, kind: 'replies', status: 'collecting', collected: Object.keys(eng.replies).length };

    const next = mergeReplies(eng, page.replies, ownerId);
    await setEngagementScan(next);
    const collected = Object.keys(next.replies).length;
    const end = !page.bottomCursor || page.bottomCursor.startsWith('0|');
    return {
      handled: true,
      kind: 'replies',
      status: end ? 'committed' : 'collecting',
      collected,
    };
  }

  if (info.op === 'UserByScreenName') {
    const profile = msg.body ? parseProfile(msg.body) : null;
    if (profile && profile.id === ownerId) {
      await repo.setProfileCounts(ownerId, profile.followersCount, profile.followingCount, now);
      await repo.setSetting('ownerHandle', profile.handle);
      const missing = profile.followersCount === undefined || profile.followingCount === undefined;
      await setHealth({ profileShape: missing ? numericPaths(profileResult(msg.body)) : null });
      await moveToList(tabId);
    }
    return { handled: true, ignored: 'irrelevant' };
  }

  const kind = opToKind(info.op);
  if (!kind) return { handled: false, ignored: 'irrelevant' };
  if (info.userId !== ownerId) return { handled: false, ignored: 'not-owner' };

  const expected = await repo.expectedCount(ownerId, kind, now);

  if (msg.status === 429 || msg.status === 403) {
    await repo.failCurrentScan(ownerId, kind, `HTTP ${msg.status} from X`, now);
    await setHealth({ lastRateLimitAt: now });
    return { handled: true, kind, status: 'error', reason: `HTTP ${msg.status}`, rateLimited: true, expected };
  }

  const apiError = parseApiErrors(msg.body);
  const page = msg.status >= 200 && msg.status < 300 && msg.body ? parseTimelinePage(msg.body) : null;
  if (!page && apiError) {
    await repo.failCurrentScan(ownerId, kind, `X error: ${apiError.message}`, now);
    if (apiError.rateLimited) await setHealth({ lastRateLimitAt: now });
    return { handled: true, kind, status: 'error', reason: apiError.message, rateLimited: apiError.rateLimited, expected };
  }
  if (!page) {
    await repo.failCurrentScan(ownerId, kind, 'unrecognised response shape', now);
    await setHealth({ lastParseError: { at: now, op: info.op, status: msg.status } });
    return { handled: true, kind, status: 'error', reason: 'unrecognised response shape', expected };
  }

  const result = await repo.ingestPage({ ownerId, kind, requestCursor: info.cursor, page, now });
  await setHealth({ lastCaptureAt: now, lastParseError: null });
  if (result.committed?.events.length) {
    await refreshBadge(repo);
    notifyCommitted(ownerId, result.committed.events);
  }
  return {
    handled: true,
    kind,
    status: result.status,
    reason: result.reason,
    collected: result.collected,
    expected,
    ...(result.committed?.baseline ? { baseline: true } : {}),
  };
}

function notifyCommitted(ownerId: string, events: EventRow[]): void {
  void (async () => {
    const history = await repo.allEvents(ownerId);
    await notifyEvents(withoutRepeats(events, history), {
      account: await repo.getSetting<string | undefined>('ownerHandle', undefined),
      boomerangs: new Map(findBoomerangs(history).map((b) => [b.userId, b.cycles])),
    });
  })().catch(() => {});
}

async function startScan(kinds: ListKind[]): Promise<CommandReply> {
  const handle = await repo.getSetting<string | undefined>('ownerHandle', undefined);
  if (!handle) return { ok: false, error: 'Open x.com once while logged in so the extension can learn your handle.' };

  const session = await browser.storage.session.get(['autoscan', 'engagementScan']);
  const priorAuto = session.autoscan as AutoScan | undefined;
  const priorEng = session.engagementScan as EngagementScan | undefined;
  await browser.storage.session.remove('autoscan');
  await setEngagementScan(null);

  const draft = newAutoScan(-1, kinds, handle, Date.now());
  const url = urlFor(draft);
  let tab: Awaited<ReturnType<typeof browser.tabs.update>> | undefined;
  const reuseTab = priorAuto?.tabId ?? priorEng?.tabId;
  if (reuseTab !== undefined) {
    tab = await browser.tabs.update(reuseTab, { url, active: true }).catch(() => undefined);
  }
  if (tab?.id === undefined) {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const onX = active?.id !== undefined && /^https:\/\/(x|twitter)\.com\//.test(active.url ?? '');
    tab = onX ? await browser.tabs.update(active.id!, { url, active: true }) : await browser.tabs.create({ url, active: true });
  }
  if (tab?.id === undefined) return { ok: false, error: 'Could not open a tab.' };
  await browser.storage.session.set({ autoscan: { ...draft, tabId: tab.id } });
  return { ok: true };
}

async function startEngagementScan(tweetId: string): Promise<CommandReply> {
  const ownerId = await currentOwnerId();
  const handle = await repo.getSetting<string | undefined>('ownerHandle', undefined);
  if (!ownerId || !handle) {
    return { ok: false, error: 'Open x.com once while logged in so the extension can learn your handle.' };
  }
  const tweet = await repo.getEngagementTweet(ownerId, tweetId);
  if (!tweet) return { ok: false, error: 'Unknown engagement tweet.' };

  const session = await browser.storage.session.get(['engagementScan', 'autoscan']);
  const priorEng = session.engagementScan as EngagementScan | undefined;
  const priorAuto = session.autoscan as AutoScan | undefined;
  await setEngagementScan(null);
  await browser.storage.session.remove('autoscan');

  const draft = newEngagementScan(-1, ownerId, handle, tweetId, Date.now());
  const url = engagementUrl(draft);
  let tab: Awaited<ReturnType<typeof browser.tabs.update>> | undefined;
  const reuseTab = priorEng?.tabId ?? priorAuto?.tabId;
  if (reuseTab !== undefined) {
    tab = await browser.tabs.update(reuseTab, { url, active: true }).catch(() => undefined);
  }
  if (tab?.id === undefined) {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const onX = active?.id !== undefined && /^https:\/\/(x|twitter)\.com\//.test(active.url ?? '');
    tab = onX ? await browser.tabs.update(active.id!, { url, active: true }) : await browser.tabs.create({ url, active: true });
  }
  const tabId = tab?.id;
  if (tabId === undefined) return { ok: false, error: 'Could not open a tab.' };
  await setEngagementScan({ ...draft, tabId });
  return { ok: true };
}

async function moveToList(tabId?: number, step?: number) {
  const next = advanceToList(await getAutoScan(), tabId, Date.now(), step);
  if (!next) return;
  await browser.storage.session.set({ autoscan: next });
  await browser.tabs.update(next.tabId, { url: urlFor(next) }).catch(() => {});
}

async function finishEngagementAfterReplies() {
  const eng = await getEngagementScan();
  if (!eng) return;
  await repo.finishEngagementScan(eng.ownerId, eng.tweetId, Object.values(eng.replies), Date.now());
  await setEngagementScan(null);
}

async function handleBridgeReady(msg: { path: string }, tabId: number | undefined): Promise<BridgeReadyReply> {
  const eng = await getEngagementScan();
  const engAnswer = answerEngagementBridge(eng, tabId, msg.path);
  if (eng && engAnswer.autoscroll) {
    return {
      autoscroll: engAnswer.autoscroll,
      pace: asPace(await repo.getSetting('pace', undefined)),
      step: engagementStep(eng),
    };
  }

  const scan = await getAutoScan();
  const answer = answerBridgeReady(scan, tabId, msg.path);
  if (answer.waitForProfile && scan) {
    const step = scan.startedAt;
    setTimeout(() => void moveToList(tabId, step), PROFILE_WAIT_MS);
  }
  return {
    autoscroll: answer.autoscroll,
    pace: asPace(await repo.getSetting('pace', undefined)),
    ...(answer.autoscroll && scan ? { step: stepOf(scan) } : {}),
  };
}

async function handleScanFinished(msg: Extract<ToBackground, { type: 'scan-finished' }>): Promise<ScanFinishedReply> {
  const eng = await getEngagementScan();
  if (eng && msg.kind === 'replies') {
    if (msg.outcome === 'stopped' || msg.outcome === 'rate-limited') {
      await setEngagementScan(null);
      if (msg.outcome === 'rate-limited') {
        await sendBrowser(
          'Ghosted',
          'X is limiting requests, so the engagement scan stopped. Try again in about 15 minutes.',
        );
      }
      return { ok: true };
    }
    await finishEngagementAfterReplies();
    return { ok: true };
  }

  const scan = await getAutoScan();
  if (!scan) return { ok: true };
  const aborted = msg.outcome === 'stopped' || msg.outcome === 'rate-limited' || msg.outcome === 'timeout';
  const next = aborted ? null : afterKindDone(scan, Date.now());
  if (next) {
    await browser.storage.session.set({ autoscan: next });
    const wait = randomIn(PACES[asPace(await repo.getSetting('pace', undefined))].betweenListsMs);
    if (wait >= 30_000) browser.alarms.create(NEXT_LIST_ALARM, { when: Date.now() + wait });
    else setTimeout(() => void openNextList(), wait);
    return { ok: true, next: { kind: next.kinds[0], inMs: wait } };
  }
  await browser.storage.session.remove('autoscan');
  if (msg.outcome === 'rate-limited')
    await sendBrowser(
      'Ghosted',
      'X is limiting requests, so the check stopped. Try again in about 15 minutes, or choose a slower check speed in Settings.',
    );
  return { ok: true };
}

async function openNextList() {
  const scan = await getAutoScan();
  if (scan) await browser.tabs.update(scan.tabId, { url: urlFor(scan) }).catch(() => {});
}

async function openNextEngagement() {
  const scan = await getEngagementScan();
  if (scan) await browser.tabs.update(scan.tabId, { url: engagementUrl(scan) }).catch(() => {});
}

async function checkScanDue() {
  const ownerId = await repo.getSetting<string | undefined>('ownerId', undefined);
  if (!ownerId) return;
  const hours = await repo.getSetting('reminderHours', DEFAULT_REMINDER_HOURS);
  if (!hours) return;
  const last = await repo.lastCommit(ownerId, 'following');
  const stale = !last || Date.now() - (last.endedAt ?? 0) > hours * 3_600_000;
  const snoozedUntil = await repo.getSetting('snoozedUntil', 0);
  if (stale && Date.now() > snoozedUntil) {
    await sendBrowser('Ghosted', 'Time for a check. Click to see who unfollowed you.', 'scan-due');
    await repo.setSetting('snoozedUntil', Date.now() + (hours * 3_600_000) / 2);
  }
}

export default defineBackground(() => {
  void migrateLegacyDb(repo.db)
    .catch(() => {})
    .then(() => refreshBadge(repo))
    .catch(() => {});

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const msg = raw as ToBackground;
    const respond = (p: Promise<unknown>) => {
      p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
      return true;
    };
    switch (msg?.type) {
      case 'capture':
        return respond(enqueue(() => handleCapture(msg, sender.tab?.id)));
      case 'bridge-ready':
        return respond(handleBridgeReady(msg, sender.tab?.id));
      case 'owner-handle':
        return respond(repo.setSetting('ownerHandle', msg.handle).then(() => ({ ok: true })));
      case 'scan-finished':
        return respond(handleScanFinished(msg));
      case 'start-scan':
        return respond(startScan(msg.kinds));
      case 'start-engagement-scan':
        return respond(startEngagementScan(msg.tweetId));
      case 'set-engagement-mark':
        return respond(
          (msg.on ? browser.storage.session.set({ engagementMark: true }) : browser.storage.session.remove('engagementMark')).then(
            () => ({ ok: true }),
          ),
        );
      case 'resolve-review':
        return respond(
          enqueue(async () => {
            const r = await repo.resolveReview(msg.scanId, msg.accept);
            if (r?.events.length) {
              await refreshBadge(repo);
              notifyCommitted(r.events[0].ownerId, r.events);
            }
            return { ok: true };
          }),
        );
      case 'test-notify':
        return respond(
          repo.getSetting<string | undefined>('ownerHandle', undefined).then((h) => testChannel(msg.channel, h)).then(() => ({ ok: true })),
        );
      default:
        return false;
    }
  });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') });
  });

  browser.alarms.create('stale-sessions', { periodInMinutes: 5 });
  browser.alarms.create('scan-due', { periodInMinutes: 60 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'stale-sessions') void enqueue(() => repo.abandonStale(Date.now()));
    if (alarm.name === 'scan-due') void checkScanDue();
    if (alarm.name === NEXT_LIST_ALARM) {
      void openNextList();
      void openNextEngagement();
    }
  });

  browser.notifications.onClicked.addListener((id) => {
    if (id === 'scan-due') void startScan(['following', 'followers']);
    browser.notifications.clear(id);
  });
});
