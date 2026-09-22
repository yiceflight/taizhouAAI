// Fixed, video-derived preparation recipe. There is deliberately no submit operation.
export const PLAN_URL = 'https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan';
export const PLAN_RECIPE = Object.freeze({
  route: '东南火点巡查航线（已验证）',
  selectedRoute: '东南火点巡查航线（已验证）-副本(2)',
  device: '泰州环境监测', dock: 'Dock 3', aircraft: 'Matrice 4TD',
  precision: '高精度 RTK', strategy: '立即', returnHeight: 110,
  lostLink: '返航', completion: '自动返航', media: '全部文件', subscriber: '运维',
});
export function validatePlanJob(job) {
  if (job.type !== 'dji-prepare' || job.submit !== false || !/^[a-f0-9-]{36}$/.test(job.eventId || '') ||
      typeof job.name !== 'string' || !/^(钾离子超标巡查|司空填写演练)-\d{8}-\d{2}$/.test(job.name)) {
    throw new Error('司空任务参数无效；只允许填写，禁止提交');
  }
}

// Executed only by our fixed extension task, on a dedicated plan tab. No API mutation,
// cookie access, arbitrary selectors/scripts from jobs, or final confirmation clicks.
export async function fillFlightPlan(recipe, name, expectedUrl) {
  const deadline = Date.now() + 55000;
  const check = () => {
    if (![expectedUrl, `${expectedUrl}/create-plan`].includes(location.href)) throw new Error('司空页面不匹配，请登录后重试');
    if (Date.now() >= deadline) throw new Error('司空填写超时；已停止，请检查页面');
  };
  check();
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
  if (!nameInputs().length) {
    await wait(() => leaves('新建计划').length === 1, '新建计划入口'); choose('新建计划');
    await wait(() => nameInputs().length === 1, '计划表单');
  }
  const nameInput = unique(nameInputs(), '计划名称');
  if (nameInput.value && !/^新建计划\d*$/.test(nameInput.value) && nameInput.value !== name) throw new Error('页面存在其他计划草稿，未覆盖');
  let form = nameInput.parentElement;
  while (form && !(leaves('任务类型', form).length && leaves('媒体存储位置', form).length)) form = form.parentElement;
  if (!form || form === document.body || form === document.documentElement) throw new Error('未能限定新建计划表单范围');
  choose('普通任务', form);
  const routeSelected = () => leaves(recipe.selectedRoute, form).length === 1 || leaves(recipe.route, form).length === 1;
  if (!routeSelected()) {
    choose('选择航线', form);
    await wait(() => leaves(recipe.route).length || leaves(recipe.selectedRoute).length, '指定航线');
    // Prefer the library name shown in the video, never use the first route.
    const candidates = leaves(recipe.route).length ? leaves(recipe.route) : leaves(recipe.selectedRoute).filter(e => !form.contains(e));
    click(unique(candidates, '视频指定航线'));
    await wait(routeSelected, '选中航线');
  }
  const deviceCards = root => {
    // Smallest visible card containing both model and exact device label.
    return all('*', root).filter(e => text(e).includes(norm(recipe.dock)) && text(e).includes(norm(recipe.device)) && text(e).includes(norm(recipe.aircraft)))
      .filter(e => ![...e.children].some(c => text(c).includes(norm(recipe.dock)) && text(c).includes(norm(recipe.device)) && text(c).includes(norm(recipe.aircraft))));
  };
  if (!deviceCards(form).length) {
    choose('选择设备', form);
    await wait(() => deviceCards(document).filter(e => !form.contains(e)).length, '指定设备');
    click(unique(deviceCards(document).filter(e => !form.contains(e)), '泰州环境监测 Dock 3'));
    await wait(() => deviceCards(form).length === 1, '选中设备');
  }
  for (const label of ['多模态识别', '自动断点续飞', '智能规划最佳返航路线']) toggle(field(label, '[role="switch"],input[type="checkbox"]', form), false, label);
  for (const label of [recipe.precision, recipe.strategy, recipe.lostLink]) choose(label, form);
  const height = field('最低返航高度（相对机场）', 'input', form);
  setInput(height, recipe.returnHeight);
  choose('编辑', form);
  const notice = await wait(() => {
    const titles = leaves('告警通知设置'); if (titles.length !== 1) return null;
    let e = titles[0].parentElement;
    while (e && e !== document.body) { if (leaves('订阅人员', e).length && all('input[type="checkbox"],[role="checkbox"]', e).length) return e; e = e.parentElement; }
    return null;
  }, '告警通知设置');
  const channels = [['站内通知', true], ['短信', false], ['邮件', false]].map(([label, value]) => {
    const controls = all('input[type="checkbox"],[role="checkbox"]', notice).filter(e => text(e.closest('label') || e.parentElement) === norm(label));
    const input = unique(controls, label); toggle(input, value, label); return { input, value, label };
  });
  const frequencyInputs = all('input', notice).filter(e => e.type !== 'checkbox' && !['搜索', '请输入'].some(s => (e.placeholder || '').includes(s)));
  const frequency = unique(frequencyInputs, '告警频率'); setInput(frequency, 0);
  const subscriberRow = unique(all('tr,[role="row"]', notice).filter(e => leaves(recipe.subscriber, e).length), '订阅人员运维');
  const rows = all('tr,[role="row"]', notice).filter(e => all('td,[role="cell"]', e).length);
  for (const row of rows) {
    const controls = all('input[type="checkbox"]', row).length ? all('input[type="checkbox"]', row) : all('[role="checkbox"]', row);
    if (controls.length) toggle(unique(controls, '订阅人员勾选框'), row === subscriberRow, '订阅人员');
  }
  // Route/device selection may asynchronously replace the platform's default
  // name. Fill the name last, after all dependent selections have settled.
  await new Promise(resolve => setTimeout(resolve, 300)); check();
  const finalNameInput = unique(nameInputs(), '计划名称');
  setInput(finalNameInput, name);
  // Verify after reactive updates. Selected button styles alone are not enough to
  // infer a submitted task: success here always means an unsubmitted form only.
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
    [finalNameInput.value === name, '计划名称'], [Number(height.value) === recipe.returnHeight, '返航高度'],
    [Number(frequency.value) === 0, '告警频率'],
    ...[recipe.precision, recipe.strategy, recipe.lostLink, '普通任务'].map(label => [selected(label), label]),
    [routeSelected(), '执行航线'], [deviceCards(form).length === 1, '选择设备'],
    [leaves(recipe.completion, form).length === 1, '完成动作'], [leaves(recipe.media, form).length === 1, '媒体存储位置'],
    [leaves(recipe.subscriber, form).length === 1, '订阅人员'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length) throw new Error(`填写核对未通过：${failed.join('、')}；未点击确定`);
  for (const label of ['多模态识别', '自动断点续飞', '智能规划最佳返航路线']) if (checked(field(label, '[role="switch"],input[type="checkbox"]', form)) !== false) throw new Error(`${label}未关闭`);
  for (const { input, value, label } of channels) if (checked(input) !== value) throw new Error(`${label}未通过核对`);
  for (const row of rows) {
    const controls = all('input[type="checkbox"]', row).length ? all('input[type="checkbox"]', row) : all('[role="checkbox"]', row);
    if (controls.length && checked(controls[0]) !== (row === subscriberRow)) throw new Error('订阅人员未通过核对');
  }
  let footer = form;
  while (footer && !leaves('确定', footer).length) footer = footer.parentElement;
  unique(leaves('确定', footer || form), '最终确定按钮');
  return { status: 'ready', submitted: false, name, url: location.href, recipe };
}
