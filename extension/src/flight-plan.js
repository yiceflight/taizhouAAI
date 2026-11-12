// Fixed, video-derived recipe. Submission uses a separate, explicitly authorized job.
export const PLAN_URL = 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan';
export const PLAN_RECIPE = Object.freeze({
  device: '泰州环境监测', dock: 'Dock 3', aircraft: 'Matrice 4TD',
  precision: '高精度 RTK', strategy: '立即', returnHeight: 110,
  lostLink: '返航', completion: '自动返航', media: '全部文件',
});
export function validatePlanJob(job) {
  if (job.type !== 'dji-prepare' || job.submit !== false || !/^[a-f0-9-]{36}$/.test(job.eventId || '') ||
      typeof job.name !== 'string' || !/^((钾离子超标巡查|PM2\.5超标巡查|司空填写演练)-\d{8}-\d{2}|手动巡查-\d{8}-\d{2}-[a-f0-9]{8})$/.test(job.name) ||
      typeof job.route !== 'string' || !job.route.trim() || job.route.length > 200 ||
      !/^[a-f0-9-]{36}$/.test(job.routeId || '') ||
      !Array.isArray(job.folderPath) || !job.folderPath.length || job.folderPath.length > 50 ||
      job.folderPath.some(folder => !folder || typeof folder.id !== 'string' || !folder.id || typeof folder.name !== 'string' || !folder.name.trim())) {
    throw new Error('司空任务参数无效；只允许填写，禁止提交');
  }
}

export function validateSubmitJob(job) {
  if (job.type !== 'dji-submit' || job.submit !== true || !/^[a-f0-9-]{36}$/.test(job.eventId || '') ||
      typeof job.name !== 'string' || !/^((?:钾离子超标巡查|PM2\.5超标巡查)-\d{8}-\d{2}|手动巡查-\d{8}-\d{2}-[a-f0-9]{8})$/.test(job.name) ||
      typeof job.route !== 'string' || !job.route.trim() || job.route.length > 200 ||
      !/^[a-f0-9-]{36}$/.test(job.routeId || '') ||
      !Array.isArray(job.folderPath) || !job.folderPath.length || job.folderPath.length > 50 ||
      job.folderPath.some(folder => !folder || typeof folder.id !== 'string' || !folder.id || typeof folder.name !== 'string' || !folder.name.trim())) {
    throw new Error('起飞任务参数无效；演练任务禁止提交');
  }
}

// Read only the exact plan row in the fixed project. Missing or ambiguous rows
// are observations of nothing, never evidence that a flight finished.
export async function readFlightStatus(name, expectedUrl) {
  if (location.href !== expectedUrl) throw new Error('司空计划列表页面不匹配');
  if (!/^((?:钾离子超标巡查|PM2\.5超标巡查)-\d{8}-\d{2}|手动巡查-\d{8}-\d{2}-[a-f0-9]{8})$/.test(name)) throw new Error('巡飞计划名称无效');
  // FlightHub labels an active mission "任务执行 (3/9)". Keep the
  // bridge's canonical status so existing clients can reconcile it.
  const states = ['待执行', '执行中', '任务执行', '已暂停', '已挂起', '部分执行', '执行成功', '执行失败', '执行终止'];
  const visible = e => e.getClientRects().length > 0;
  const label = e => (e.innerText || e.textContent || '').replace(/\s+/g, '').trim();
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  // Finish before the worker watchdog (25s), so timed-out reads do not
  // continue changing filters while the next status query is running.
  const deadline = Date.now() + 20000;
  const signature = () => all('tbody tr,tr[role="row"]').map(label).join('|');
  const wait = async (condition = () => true) => {
    let stable = 0;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (location.href !== expectedUrl) throw new Error('司空计划列表已跳转');
      if (condition() && !all('[class*="spin-spinning"],[aria-busy="true"]').length) {
        if (++stable >= 4) return;
      } else stable = 0;
    }
    throw new Error('司空状态查询未完成，请稍后重试；未推断任务结束');
  };
  const enabled = e => e && e.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(e.className);
  const flightTime = row => {
    // FlightHub renders planned and actual times side by side. Never use
    // the planned group, the request time, or the time of this observation.
    const groups = row.querySelectorAll('.duration-box .time-content');
    if (groups.length !== 2) return null;
    const start = label(groups[1].querySelector('.start-time') || groups[1]);
    const end = label(groups[1].querySelector('.end-time') || groups[1]);
    const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!clock.test(start) || !clock.test(end)) return null;
    let date = null;
    for (let previous = row.previousElementSibling; previous; previous = previous.previousElementSibling) {
      const text = label(previous);
      if (/^\d{4}-\d{2}-\d{2}(?:今天|昨天)?$/.test(text)) { date = text.slice(0, 10); break; }
    }
    if (!date) return null;
    const startTime = Date.parse(`${date}T${start}:00+08:00`);
    let endTime = Date.parse(`${date}T${end}:00+08:00`);
    if (!Number.isFinite(startTime) || new Date(startTime + 8 * 3600000).toISOString().slice(0, 10) !== date) return null;
    if (endTime < startTime) endTime += 86400000;
    const durationMs = endTime - startTime;
    if (durationMs <= 0 || durationMs >= 86400000 || endTime > Date.now()) return null;
    return { startTime, endTime, durationMs, source: 'dji-plan', precision: 'minute' };
  };
  const read = () => {
    const rows = [...document.querySelectorAll('tr,[role="row"]')].filter(visible).filter(row =>
      [...row.querySelectorAll('*')].some(e => visible(e) && !e.children.length && label(e) === name));
    if (rows.length > 1) throw new Error('同名司空计划不唯一');
    if (!rows.length) return null;
    // The finished list appends progress, e.g. "执行成功 (9/9)".
    const found = [...new Set(states.filter(state => [...rows[0].querySelectorAll('*')].some(e =>
      visible(e) && new RegExp(`^${state}(?:[（(]\\d+/\\d+[）)])?$`).test(label(e))))
      .map(state => state === '任务执行' ? '执行中' : state))];
    return found.length === 1 ? { status: found[0], flightTime: found[0] === '执行成功' ? flightTime(rows[0]) : null } : null;
  };
  const observations = [];
  for (const tabName of ['未完成', '已结束', '已完成']) {
    const tabs = [...document.querySelectorAll('[role="tab"],button')].filter(visible).filter(e => label(e) === tabName);
    if (tabs.length !== 1) continue;
    tabs[0].click();
    await wait();
    const dateInput = all('input').find(e => e.placeholder === '开始日期');
    if (dateInput?.value) {
      const clear = dateInput.closest('[class*="picker-range"],[class*="calendar-picker"]')?.querySelector('[class*="picker-clear"],[aria-label="close-circle"]');
      if (!clear) throw new Error('司空日期筛选无法清空，未能核查完整任务范围');
      clear.click(); await wait(() => !dateInput.value);
    }
    const search = all('input').find(e => /按航线或计划名搜索|航线名称\s*[/／]\s*计划名称/.test(e.placeholder));
    if (search && search.value !== name) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('司空计划搜索不可用');
      setter.call(search, name);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait();
    }
    // Return to the first page even when the dedicated tab retained old pagination.
    let previous;
    while (enabled(previous = all('[title="上一页"],[aria-label="Previous Page"]').find(e => /pagination/.test(e.className)))) {
      const before = signature();
      const first = all('[title="1"]').find(e => /pagination/.test(e.className));
      (first || previous).click(); await wait(() => signature() !== before);
    }
    const seen = new Set();
    let found = null;
    while (true) {
      const sig = signature();
      if (seen.has(sig)) throw new Error('司空状态翻页未生效，未能核查完整任务范围');
      seen.add(sig);
      const status = read();
      if (status) {
        if (found) throw new Error('同名司空计划不唯一');
        found = status;
      }
      const next = all('[title="下一页"],[aria-label="Next Page"]').find(e => /pagination/.test(e.className));
      if (!enabled(next)) break;
      next.click(); await wait(() => signature() !== sig);
    }
    if (found) observations.push(found);
  }
  // A just-finished task can briefly remain in both tabs. Accept identical
  // receipts only; conflicting states or times still require another read.
  const unique = [...new Map(observations.map(value => [JSON.stringify(value), value])).values()];
  return { url: location.href, name, status: unique.length === 1 ? unique[0].status : null, flightTime: unique.length === 1 ? unique[0].flightTime : null };
}

// Read-only: FlightHub uses a prefixed Ant modal for weather blocking and other
// follow-up confirmations. Never activate its execute/confirm buttons.
export function readFlightSubmissionIssue(expectedUrl, expectedName) {
  if (![expectedUrl, `${expectedUrl}/create-plan`].includes(location.href)) return null;
  if (expectedName !== undefined) {
    const inputs = [...document.querySelectorAll('input[placeholder="请输入计划名称"]')];
    if (location.href !== `${expectedUrl}/create-plan` || inputs.length !== 1 || inputs[0].value !== expectedName) return null;
  }
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible);
  for (const dialog of dialogs) {
    const body = dialog.querySelector('[class*="-modal-body"]') || dialog;
    const message = (body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim();
    if (!message) continue;
    const weather = /天气阻飞|因天气原因|在线天气风速/.test(message);
    return `司空平台${weather ? '天气阻飞' : '要求人工确认'}：${message.slice(0, 220)}；未继续执行`;
  }
  return null;
}

// Fixed project/recipe only. Preview always leaves the final confirmation intact.
// Errors carry whether the sole submit click may have happened (`sent`), so a
// caller can tell "nothing was submitted" from "the plan might exist".
const stepError = (message, sent = false) => Object.assign(new Error(message), { sent });
export { stepError };
// The function is serialised into the page, so helpers it closes over cannot
// resolve to the extension's module scope. They travel as an explicit
// parameter instead of through globals the page does not have.
export async function fillFlightPlan(recipe, name, expectedUrl, submit = false, readSubmissionIssue, helpers = {}) {
  const stepError = helpers.stepError || ((message, sent = false) => Object.assign(new Error(message), { sent }));
  // Declared here, not on the function object, so the call site only needs
  // the function itself after serialisation.
  let clicked = false;
  // Every wait shares one budget inside a step. Splitting the slow FlightHub
  // page into steps keeps one sluggish panel from consuming the whole run: a
  // timeout now names the step instead of ending as an unexplained failure.
  let deadline = Date.now() + 20000;
  let step = '准备司空计划页';
  const begin = (label, ms) => { step = label; deadline = Date.now() + ms; };
  const check = () => {
    if (![expectedUrl, `${expectedUrl}/create-plan`].includes(location.href)) throw new Error('司空页面不匹配，请登录后重试');
    if (Date.now() >= deadline) throw stepError(`${step}超时；已停止，请检查页面`);
  };
  try {
  check();
  if (submit) {
    if (typeof readSubmissionIssue !== 'function') throw new Error('司空提交提示读取不可用，未点击确定');
    const issue = readSubmissionIssue(expectedUrl);
    if (issue) throw stepError(issue, false);
  }
  if (submit && !/^((?:钾离子超标巡查|PM2\.5超标巡查)-\d{8}-\d{2}|手动巡查-\d{8}-\d{2}-[a-f0-9]{8})$/.test(name)) throw new Error('演练或未知计划禁止提交');
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, '').trim();
  const norm = s => s.replace(/\s+/g, '');
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const leaves = (value, root = document) => all('*', root).filter(e => text(e) === norm(value) && ![...e.children].some(c => visible(c) && text(c) === norm(value)));
  const unique = (items, label) => { if (items.length !== 1) throw new Error(`${label}未唯一定位，已停止填写`); return items[0]; };
  const wait = async (fn, label) => {
    while (true) { check(); const result = fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 150)); if (Date.now() >= deadline) throw new Error(`等待${label}超时，已停止填写`); }
  };
  const forbidden = /^(确定|确认|提交|保存|起飞|执行任务|立即执行|开始任务|创建航线)$/;
  const click = e => {
    check();
    const button = e.closest('button,[role="button"]') || e;
    if (forbidden.test(text(button)) || button.matches('[type="submit"]') || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('禁止触发提交或不可用控件');
    button.scrollIntoView({ block: 'nearest' }); button.click();
  };
  const choose = (label, root) => {
    const buttons = all('button,[role="button"]', root).filter(e => text(e) === norm(label));
    click(unique(buttons.length ? buttons : leaves(label, root), label));
  };
  const setInput = (input, value) => {
    check(); if (input.disabled || input.readOnly) throw new Error('输入框不可填写');
    input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur();
  };
  const field = (label, selector, root) => {
    let e = unique(leaves(label, root), label).parentElement;
    while (e && e !== root) { const controls = all(selector, e); if (controls.length === 1) return controls[0]; if (controls.length > 1) break; e = e.parentElement; }
    throw new Error(`${label}控件未唯一定位`);
  };
  const checked = e => e.matches('input') ? e.checked : e.getAttribute('aria-checked') === 'true' ? true : e.getAttribute('aria-checked') === 'false' ? false : null;
  const toggle = (e, value, label) => { const state = checked(e); if (state === null) throw new Error(`无法核对${label}状态`); if (state !== value) click(e); };
  const nameInputs = () => all('input[placeholder="请输入计划名称"]');
  begin('打开计划表单', 20000);
  if (!nameInputs().length) {
    if (submit) throw new Error('原计划表单已关闭，未提交');
    await wait(() => leaves('新建计划').length === 1, '新建计划入口'); choose('新建计划');
    await wait(() => nameInputs().length === 1, '计划表单');
  }
  const nameInput = unique(nameInputs(), '计划名称');
  if (nameInput.value && !/^新建计划\d*$/.test(nameInput.value) && nameInput.value !== name) throw new Error('页面存在其他计划草稿，未覆盖');
  let form = nameInput.parentElement;
  while (form && !(leaves('任务类型', form).length && leaves('媒体存储位置', form).length)) form = form.parentElement;
  if (!form || form === document.body || form === document.documentElement) throw new Error('未能限定新建计划表单范围');
  begin('选择任务类型', 10000);
  if (!submit) choose('普通任务', form);
  // FlightHub creates a route copy when selecting it; its suffix is variable.
  // Match the configured prefix, keeping the library and selected form separate.
  const routePrefix = norm(recipe.route);
  if (!routePrefix) throw new Error('指定航线为空，已停止填写');
  const routeNames = root => all('*', root).filter(e => text(e).startsWith(routePrefix)
    && ![...e.children].some(c => visible(c) && text(c).startsWith(routePrefix)));
  let observedRoutes = [];
  const libraryIdentity = (element, library) => {
    const card = element.closest('.component-plan-app-wayline-item');
    // The prepared form also renders a route card; it is not a library row.
    const cards = all('.component-plan-app-wayline-item', library);
    const index = cards.indexOf(card);
    // Match the entire rendered list after the response, not just a same-name card.
    if (cards.length !== observedRoutes.length || cards.some((c, i) =>
      !leaves(observedRoutes[i].name, c).length)) return null;
    return observedRoutes[index] ?? null;
  };
  const routeSelected = () => {
    const matches = routeNames(form);
    if (matches.length > 1) throw new Error('已选航线不唯一，已停止填写');
    return matches.length === 1;
  };
  if (!routeSelected() || (!submit && recipe.folderPath?.length)) {
    if (submit) throw new Error('指定航线已变化，未提交');
    begin('选择执行航线', 30000);
    const originalOpen = globalThis.XMLHttpRequest?.prototype.open;
    const originalFetch = globalThis.fetch;
    const observe = (url, result) => {
      try {
        const request = new URL(url, location.href);
        const target = recipe.folderPath?.at(-1)?.id;
        if (!target || !request.pathname.endsWith('/web-waylines') || request.searchParams.get('file_type') !== '5' || request.searchParams.get('parent_id') !== target || result.code !== 0) return;
        const data = result.data?.data ?? result.data;
        if (!Array.isArray(data?.list)) return;
        const page = Number(request.searchParams.get('page') || 1);
        if (page === 1) observedRoutes = data.list;
        else if (observedRoutes.length === (page - 1) * 20) observedRoutes = observedRoutes.concat(data.list);
      } catch { /* Unknown responses never establish route identity. */ }
    };
    if (recipe.folderPath?.length && originalOpen) {
      globalThis.XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (String(method).toUpperCase() === 'GET') this.addEventListener('load', () => {
          try { observe(String(url), this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {}
        }, { once: true });
        return originalOpen.call(this, method, url, ...args);
      };
    }
    if (recipe.folderPath?.length && originalFetch) globalThis.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try { observe(typeof args[0] === 'string' ? args[0] : args[0].url, await response.clone().json()); } catch {}
      return response;
    };
    try {
    choose('选择航线', form);
    const library = await wait(() => {
      const titles = leaves('航线库');
      if (!titles.length) return null;
      let root = unique(titles, '航线库').parentElement;
      while (root && root !== document.body && !root.contains(form)) {
        if (all('.wayline-folder-tree', root).length || (!recipe.folderPath?.length && routeNames(root).length)) return root;
        root = root.parentElement;
      }
      return null;
    }, '航线库内的指定航线');
    if (recipe.folderPath?.length) {
      const tree = unique(all('.wayline-folder-tree', library), '航线文件夹');
      const findFolder = folder => all('[data-id]', tree).filter(e => e.getAttribute('data-id') === folder.id);
      for (let index = 0; index < recipe.folderPath.length; index += 1) {
        const folder = recipe.folderPath[index];
        const row = unique(await wait(() => findFolder(folder).length ? findFolder(folder) : null, '航线文件夹'), '航线文件夹');
        const label = unique(leaves(folder.name, row), '航线文件夹名称');
        if (index === recipe.folderPath.length - 1 && (row.classList.contains('uranus-tree-item-selected') || row.classList.contains('folder-item-highlight')) && !observedRoutes.length) {
          const other = all('[data-id]', tree).find(e => e !== row);
          if (other) {
            click(unique(all('.uranus-tree-node-name', other), '其他航线文件夹'));
            await new Promise(resolve => setTimeout(resolve, 150));
          } else {
            await wait(() => observedRoutes.length, '当前目录航线响应（若未加载请关闭航线库后重试）');
          }
        }
        click(label);
        await wait(() => row.classList.contains('uranus-tree-item-selected') || row.classList.contains('folder-item-highlight'), '文件夹选中状态');
        const next = recipe.folderPath[index + 1];
        if (next && !findFolder(next).length) {
          const icon = row.querySelector('.uranus-tree-node-content > :first-child');
          if (!icon) throw new Error('无法展开航线文件夹');
          click(icon);
        }
      }
      // Verify the rendered card's actual API identity. A folder highlight or
      // a same-name stale card is not proof that the asynchronous list loaded.
      await wait(() => {
        if (all('.icon-loading', library).length) return false;
        const found = routeNames(library).some(e => {
          const item = libraryIdentity(e, library);
          return item?.id === recipe.routeId && item.parent_id === recipe.folderPath.at(-1).id;
        });
        if (!found && !all('[class*="spin-spinning"],[aria-busy="true"]', library).length) {
          for (const element of all('*', library)) {
            if (!tree.contains(element) && element.scrollHeight > element.clientHeight && element.clientHeight > 0) element.scrollTop = element.scrollHeight;
          }
        }
        return found;
      }, '目标文件夹内的航线身份');
    }
    const candidates = routeNames(library).filter(e => {
      if (!recipe.folderPath?.length) return true;
      const item = libraryIdentity(e, library);
      return text(e) === routePrefix && item?.id === recipe.routeId && item.parent_id === recipe.folderPath.at(-1).id;
    });
    const distance = e => [...text(e)].length - [...routePrefix].length;
    const minimum = Math.min(...candidates.map(distance));
    click(unique(candidates.filter(e => distance(e) === minimum), '差异最小的指定航线'));
    await wait(routeSelected, '选中航线');
    if (recipe.folderPath?.length) form.dataset.aaiRouteIdentity = JSON.stringify([recipe.routeId, recipe.folderPath]);
    } finally {
      if (recipe.folderPath?.length && originalOpen) globalThis.XMLHttpRequest.prototype.open = originalOpen;
      if (recipe.folderPath?.length && originalFetch) globalThis.fetch = originalFetch;
    }
  }
  if (recipe.folderPath?.length && form.dataset.aaiRouteIdentity !== JSON.stringify([recipe.routeId, recipe.folderPath])) throw new Error('航线文件夹选择凭据已失效，请重新准备计划');
  const deviceCards = root => {
    // Smallest visible card containing both model and exact device label.
    return all('*', root).filter(e => text(e).includes(norm(recipe.dock)) && text(e).includes(norm(recipe.device)) && text(e).includes(norm(recipe.aircraft)))
      .filter(e => ![...e.children].some(c => text(c).includes(norm(recipe.dock)) && text(c).includes(norm(recipe.device)) && text(c).includes(norm(recipe.aircraft))));
  };
  if (!deviceCards(form).length) {
    if (submit) throw new Error('指定机场已变化，未提交');
    begin('选择设备', 20000);
    choose('选择设备', form);
    await wait(() => deviceCards(document).filter(e => !form.contains(e)).length, '指定设备');
    click(unique(deviceCards(document).filter(e => !form.contains(e)), '泰州环境监测 Dock 3'));
    await wait(() => deviceCards(form).length === 1, '选中设备');
  }
  begin('填写任务参数', 15000);
  if (!submit) for (const label of ['多模态识别', '自动断点续飞', '智能规划最佳返航路线']) toggle(field(label, '[role="switch"],input[type="checkbox"]', form), false, label);
  if (!submit) for (const label of [recipe.precision, recipe.strategy, recipe.lostLink]) choose(label, form);
  const height = field('最低返航高度（相对机场）', 'input', form);
  if (!submit) setInput(height, recipe.returnHeight);
  // Notification channels, frequency and subscribers are left to FlightHub.
  // Route/device selection may asynchronously replace the platform's default
  // name. Fill the name last, after all dependent selections have settled.
  await new Promise(resolve => setTimeout(resolve, 300)); check();
  const finalNameInput = unique(nameInputs(), '计划名称');
  if (!submit) setInput(finalNameInput, name);
  // Verify after reactive updates. Selected button styles alone are not enough to
  // infer a submitted task: success here always means an unsubmitted form only.
  begin('核对填写结果', 12000);
  await new Promise(resolve => setTimeout(resolve, 300)); check();
  const selected = label => {
    const leaf = unique(leaves(label, form), label);
    let e = leaf;
    while (e && e !== form) {
      if (e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-checked') === 'true' || /(^|[\s_-])(active|selected|checked|primary)([\s_-]|$)/i.test(e.className || '')) return true;
      e = e.parentElement;
    }
    return false;
  };
  const checks = [
    [finalNameInput.value === name, '计划名称'], [Number(height.value) === recipe.returnHeight, '最低返航高度（相对机场）'],
    ...[recipe.precision, recipe.strategy, recipe.lostLink, '普通任务'].map(label => [selected(label), label]),
    [routeSelected(), '执行航线'], [deviceCards(form).length === 1, '选择设备'],
    [leaves(recipe.completion, form).length === 1, '完成动作'], [leaves(recipe.media, form).length === 1, '媒体存储位置'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length) throw new Error(`填写核对未通过：${failed.join('、')}；未点击确定`);
  for (const label of ['多模态识别', '自动断点续飞', '智能规划最佳返航路线']) {
    if (checked(field(label, '[role="switch"],input[type="checkbox"]', form)) !== false) throw new Error(`${label}未关闭`);
    checks.push([true, label]);
  }
  let footer = form;
  while (footer && !leaves('确定', footer).length) footer = footer.parentElement;
  const confirmation = unique(leaves('确定', footer || form), '最终确定按钮');
  if (!submit) return { status: 'ready', submitted: false, name, url: location.href, verified: checks.map(([, label]) => label) };
  if (!/^((?:钾离子超标巡查|PM2\.5超标巡查)-\d{8}-\d{2}|手动巡查-\d{8}-\d{2}-[a-f0-9]{8})$/.test(name)) throw new Error('演练或未知计划禁止提交');
  check();
  const button = confirmation.closest('button,[role="button"]');
  if (!button || text(button) !== '确定' || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('最终确定按钮不可用，未提交');
  // This is the sole flight mutation. Never click a follow-up dialog or retry.
  // If Chrome tears the page down during the click, the caller must not be
  // told nothing was sent: the flag is set immediately before the mutation.
  if (clicked) throw stepError('已点击计划确定，禁止重复提交', true);
  clicked = true;
  button.click();
  const receiptDeadline = Date.now() + 8000;
  while (Date.now() < receiptDeadline) {
    const issue = readSubmissionIssue(expectedUrl);
    if (issue) throw stepError(issue, true);
    if (location.href === expectedUrl && !nameInputs().length) {
      // The same name appears in both the active-device card and plan list.
      // Only the unique plan row is a receipt; a device card alone is not.
      const rows = all('tr,[role="row"]').filter(row => leaves(name, row).length > 0);
      if (rows.length === 1) return { status: 'submitted', submitted: true, name, url: location.href, clicked: true };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw stepError('已点击计划确定，但未收到可核对的计划列表回执', true);
  } catch (error) {
    // Only this function knows whether the confirmation was clicked.
    if (error && typeof error === 'object' && !error.sent) error.sent = clicked;
    throw error;
  }
}
