import { PLAN_URL } from './flight-plan.js';
import { WEATHER_URL } from './dji-weather.js';

// Every FlightHub page keeps a map, a websocket and a large SPA alive. On a
// low-spec Windows PC a few dozen of them starve the renderers the bridge
// actually reads, so pages are closed as soon as their operation is over.
const MINUTE = 60000;
export const SWEEP_ALARM = 'managed-tab-sweep';
export const SWEEP_MINUTES = 5;
export const LIMITS = {
  // A page nobody owns and nobody looked at for this long.
  unownedIdle: 10 * MINUTE,
  // The plan list a submitted draft navigated to; nothing reads it again.
  submittedGrace: 2 * MINUTE,
  // A flight page whose event the connected client no longer asks about.
  flightIdle: 30 * MINUTE,
  // An unsubmitted draft gets longer: it may be read again after a retry.
  draftIdle: 60 * MINUTE,
  monitorIdle: 30 * MINUTE,
  // One refresh per page in this window, so a slow page is not reloaded in a loop.
  reloadCooldown: 2 * MINUTE,
};
const FLIGHT_KEY = /^flight-([a-f0-9-]{36})$/;
const DRAFT_URL = `${PLAN_URL}/create-plan`;
const REPORT_TAB_PREFIX = 'flight-report-tab:';
const MONITOR_KEY = 'flight-monitor-tab';
export const MONITOR_USED_KEY = 'flight-monitor-tab-used';
const seenKey = eventId => `flight-seen-${eventId}`;

// Pages this extension opens in the background. Unowned ones are leftovers.
export function backgroundPage(url, { drafts = false } = {}) {
  if (!url) return false;
  if (url.startsWith(DRAFT_URL)) return drafts;
  return url === PLAN_URL
    || (url.startsWith('https://fh.dji.com/') && url.includes('#/media'))
    || url.startsWith(WEATHER_URL)
    || /^https:\/\/aai\.airins\.cn\/sniff\/HistoryCloud\?missionId=/.test(url);
}

// `chrome` is the managed facade, whose tabs.get() moves a tab into the App
// group. `exists` must use the raw API so a stale ID can never adopt, and then
// close, one of the user's own tabs.
// Silence only means "finished" while the client is `connected`; a closed App
// must not cost the operator a draft that is waiting for confirmation.
export function createTabJanitor(chrome, { now = Date.now, busy = () => false, transient = () => [], exists = async () => false, connected = () => true } = {}) {
  const firstSeen = new Map();
  const touched = new Map();
  const remove = keys => chrome.storage.local.remove(keys).catch(() => {});
  const close = id => chrome.tabs.remove(id).then(() => true, () => false);

  // Called for every job that names a flight event. The client polls a live
  // event every 20 seconds, so silence means the event reached a final state.
  // Bookkeeping only: it must never fail the job it accompanies.
  async function touch(name, key, owner) {
    try {
      if (now() - (touched.get(name) || 0) < MINUTE) return;
      if (owner && !Number.isInteger((await chrome.storage.local.get(owner))[owner])) return;
      touched.set(name, now());
      await chrome.storage.local.set({ [key]: now() });
    } catch { /* The next job records the activity. */ }
  }
  const touchFlight = async eventId => {
    if (/^[a-f0-9-]{36}$/.test(eventId || '')) await touch(eventId, seenKey(eventId), `flight-${eventId}`);
  };
  const touchMonitor = () => touch(MONITOR_KEY, MONITOR_USED_KEY);

  // Task sync and status polling each own one plan list. A white, frozen or
  // discarded copy fails every read identically, and nothing else reloads it.
  const reloaded = new Map();
  async function recover(type, message) {
    const key = { 'dji-tasks': 'flight-task-sync-tab', 'dji-status': MONITOR_KEY }[type];
    if (!key || !/尚未加载完成|读取超时|查询未完成|加载超时/.test(message || '')) return false;
    const id = (await chrome.storage.local.get(key))[key];
    if (!Number.isInteger(id) || now() - (reloaded.get(id) ?? -Infinity) < LIMITS.reloadCooldown) return false;
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab || (tab.pendingUrl || tab.url) !== PLAN_URL) return false;
    reloaded.set(id, now());
    await chrome.tabs.reload(id);
    return true;
  }

  // `startup` keeps the long-standing worker-start behaviour: leftovers are
  // closed without a grace period because no operation can be in flight yet.
  async function sweep({ startup = false } = {}) {
    if (busy()) return { skipped: true, closed: [] };
    const all = await chrome.storage.local.get(null).catch(() => null);
    if (!all) return { skipped: true, closed: [] };
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const listed = new Map(tabs.map(tab => [tab.id, tab]));
    // Returns the managed tab, null when the tab is gone, or undefined when it
    // still exists outside the App group and is therefore left alone.
    const find = async id => listed.get(id) || (await exists(id).catch(() => true) ? undefined : null);
    const ours = tab => (tab.pendingUrl || tab.url || '').startsWith('https://fh.dji.com/');
    const keep = new Set(transient());
    const online = connected();
    const closed = [];
    const stamps = {};
    const stale = [];

    for (const [key, value] of Object.entries(all)) {
      const eventId = key.match(FLIGHT_KEY)?.[1];
      if (!eventId || !Number.isInteger(value)) continue;
      const related = [key, `flight-review-${eventId}`, seenKey(eventId)];
      const tab = await find(value);
      if (tab === null) { stale.push(...related); continue; }
      if (!tab) continue;
      let seen = all[seenKey(eventId)];
      // Pages created by an older extension have no activity record. Start
      // their clock now instead of treating a live draft as abandoned.
      if (!Number.isFinite(seen) || !online) { seen = now(); stamps[seenKey(eventId)] = seen; }
      const claim = all[`flight-submit-${eventId}`];
      const draft = (tab.pendingUrl || tab.url) === DRAFT_URL;
      const idle = now() - seen;
      let expired;
      if (claim && !draft) {
        const age = now() - (Number.isFinite(claim.attemptedAt) ? claim.attemptedAt : 0);
        expired = age >= LIMITS.submittedGrace && (!tab.active || age >= LIMITS.flightIdle);
      } else if (draft && !claim) expired = idle >= LIMITS.draftIdle;
      else expired = idle >= LIMITS.flightIdle;
      if (!expired) { keep.add(tab.id); continue; }
      // The submit claim is never removed: it is what forbids a second
      // take-off request for the same event.
      // A saved ID that now shows another site is released, never closed.
      if (!ours(tab)) stale.push(...related);
      else if (await close(tab.id)) { closed.push(tab.id); stale.push(...related); }
      else keep.add(tab.id);
    }
    for (const key of Object.keys(all)) {
      const eventId = key.match(/^flight-(?:review|seen)-([a-f0-9-]{36})$/)?.[1];
      if (eventId && !Number.isInteger(all[`flight-${eventId}`])) stale.push(key);
    }

    const monitor = Number.isInteger(all[MONITOR_KEY]) ? await find(all[MONITOR_KEY]) : null;
    if (monitor) {
      let used = all[MONITOR_USED_KEY];
      if (!Number.isFinite(used) || !online) { used = now(); stamps[MONITOR_USED_KEY] = used; }
      if (!monitor.active && ours(monitor) && now() - used >= LIMITS.monitorIdle && await close(monitor.id)) {
        closed.push(monitor.id); stale.push(MONITOR_KEY, MONITOR_USED_KEY);
      } else keep.add(monitor.id);
    }
    for (const key of ['weatherTabId', 'flight-task-sync-tab']) if (Number.isInteger(all[key])) keep.add(all[key]);
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(REPORT_TAB_PREFIX)) continue;
      const id = Number.isInteger(value) ? value : value?.tabId;
      if (Number.isInteger(id)) keep.add(id);
    }

    // Site health reads the lowest FlightHub project tab. While none of the
    // dedicated pages exists yet, leave one plan list for it; closing it would
    // only make the next readiness pass open another.
    const dedicated = ['weatherTabId', 'flight-task-sync-tab', MONITOR_KEY]
      .some(key => Number.isInteger(all[key]) && listed.has(all[key]) && !closed.includes(all[key]));
    let spare = dedicated ? null : tabs.filter(tab => !keep.has(tab.id) && tab.url === PLAN_URL).sort((a, b) => a.id - b.id)[0]?.id;

    for (const tab of tabs) {
      if (keep.has(tab.id) || closed.includes(tab.id)) continue;
      if (!backgroundPage(tab.url, { drafts: startup })) { firstSeen.delete(tab.id); continue; }
      if (!firstSeen.has(tab.id)) firstSeen.set(tab.id, now());
      if (tab.id === spare || tab.active) continue;
      const since = Math.max(Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0, firstSeen.get(tab.id));
      if (!startup && now() - since < LIMITS.unownedIdle) continue;
      if (await close(tab.id)) { closed.push(tab.id); firstSeen.delete(tab.id); }
    }
    for (const id of [...firstSeen.keys()]) if (!listed.has(id)) firstSeen.delete(id);
    if (Object.keys(stamps).length) await chrome.storage.local.set(stamps).catch(() => {});
    if (stale.length) await remove([...new Set(stale)]);
    return { skipped: false, closed };
  }
  return { sweep, touchFlight, touchMonitor, recover };
}
