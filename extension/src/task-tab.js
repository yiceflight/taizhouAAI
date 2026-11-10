import { PLAN_URL } from './flight-plan.js';

// tabs.status only covers document loading, not FlightHub's async plan table.
export async function waitForTaskList(expectedUrl) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (location.href !== expectedUrl) throw new Error('司空任务列表发生跳转，请检查登录状态后刷新任务');
    if (!localStorage.getItem('x-user-token') && !localStorage.getItem('x-auth-token')) throw new Error('请在 Chrome 登录司空后同步任务');
    const empty = document.querySelector('.plan-app-ant-empty, .ant-empty');
    const rows = [...(document.querySelectorAll?.('tbody tr, tr[role="row"]') || [])];
    // FlightHub renders a date separator row before it renders the actual
    // task rows. The separator also has data-row-key, so merely waiting for
    // any table row races the async row contents and loses DOM-only fields
    // such as the route name.
    const taskRow = rows.some(row => row.querySelector?.('.duration-box, .plan-name-wrapper, .action-box')
      || row.querySelectorAll?.('.duration-box .time-content')?.length);
    const loading = document.querySelector('.plan-app-ant-spin-spinning, .ant-spin-spinning');
    if ((taskRow || empty) && !loading) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('司空任务列表尚未加载完成，请稍后刷新任务');
}

// Only reuse a tab owned by task sync; never navigate a user's page.
export function createTaskTabManager(chrome, { now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), key = 'flight-task-sync-tab' } = {}) {
  let pending;
  const loginPage = url => /[/#](login|signin)([/?#]|$)/i.test(url || '');
  async function acquire() {
    const saved = await chrome.storage.local.get(key);
    let tab = Number.isInteger(saved[key]) ? await chrome.tabs.get(saved[key]).catch(() => null) : null;
    // Retry the same redirected tab: login may have recovered in another tab.
    // Never create one new login tab per background retry.
    if (tab && loginPage(tab.pendingUrl || tab.url)) {
      tab = await chrome.tabs.update(tab.id, { url: PLAN_URL });
    }
    else if (!tab || (tab.pendingUrl || tab.url) !== PLAN_URL) {
      tab = await chrome.tabs.create({ url: PLAN_URL, active: false });
      await chrome.storage.local.set({ [key]: tab.id });
    }
    const deadline = now() + 20000;
    while (now() < deadline) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current) throw new Error('任务同步页面已关闭，请刷新任务，系统会自动重新打开');
      const target = current.pendingUrl || current.url;
      if (loginPage(target)) throw new Error('司空登录已失效，请在 Chrome 完成登录后刷新任务');
      if (target && target !== 'about:blank' && target !== PLAN_URL) throw new Error('任务同步页面已跳转，请刷新任务，系统会自动恢复专用页面');
      if (current.status === 'complete' && current.url === PLAN_URL && !current.pendingUrl) return current;
      await pause(200);
    }
    throw new Error('司空任务列表加载超时，请检查网络后刷新任务');
  }
  return () => {
    if (!pending) pending = acquire().finally(() => { pending = null; });
    return pending;
  };
}
