chrome.runtime.sendMessage({
  type: "page.ready",
  url: window.location.href,
  title: document.title,
});

let review;
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'flight.review.start') {
    review?.remove();
    review = flightReview(message);
    respond({ ok: true });
  } else if (message?.type === 'flight.review.verified') {
    if (review?.eventId !== message.eventId) { respond({ ok: false }); return; }
    review.verify(message.verified);
    respond({ ok: true });
  } else if (message?.type === 'flight.review.close') {
    if (review?.eventId === message.eventId) { review.remove(); review = null; }
    respond({ ok: true });
  } else if (message?.type === 'flight.review.check') {
    respond({ ok: review?.eventId === message.eventId && review.verified });
  }
});

function flightReview({ eventId, name, fields, autoSubmit }) {
  const host = document.createElement('div');
  host.id = 'taizhou-flight-review';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial} *{box-sizing:border-box}
    aside{position:fixed;z-index:2147483647;top:24px;right:24px;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#fff;color:#18302c;border:1px solid #b8c9c4;border-radius:6px;box-shadow:0 12px 40px #172b2b38;font:14px/1.5 system-ui,-apple-system,sans-serif;padding:18px}
    h2{font-size:17px;margin:0 0 4px} p{margin:0 0 12px;color:#52645f;overflow-wrap:anywhere}
    ul{list-style:none;margin:0;padding:0;display:grid;gap:3px} li{display:flex;gap:8px;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eef1ef}
    li span:last-child{text-align:right;color:#5d6865} li.ok{color:#147c4c} li.ok span:last-child{color:#147c4c}
    .footer{position:sticky;bottom:-18px;background:#fff;padding-top:12px;margin-top:10px;border-top:1px solid #dce5e1}
    .timer{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;margin-bottom:10px}
    button{width:100%;min-height:38px;border:1px solid #b43b32;border-radius:4px;background:#fff;color:#a3342c;font:600 14px system-ui;cursor:pointer}
    button:disabled{opacity:.55;cursor:default} .error{color:#a3342c;margin-top:8px}
  `;
  const aside = document.createElement('aside');
  aside.setAttribute('role', 'status');
  const title = document.createElement('h2'); title.textContent = '司空计划核对';
  const subtitle = document.createElement('p'); subtitle.textContent = name;
  const list = document.createElement('ul');
  const items = new Map();
  for (const { label, value, check } of fields) {
    const row = document.createElement('li');
    const left = document.createElement('span'); left.textContent = label;
    const right = document.createElement('span'); right.textContent = value;
    row.append(left, right); list.append(row); items.set(check || label, row);
  }
  const footer = document.createElement('div'); footer.className = 'footer';
  const timer = document.createElement('div'); timer.className = 'timer'; timer.textContent = '正在填写并核对…';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消本次作业';
  const error = document.createElement('div'); error.className = 'error';
  cancel.addEventListener('click', () => {
    cancel.disabled = true;
    chrome.runtime.sendMessage({ type: 'flight.review.cancel', eventId }, response => {
      if (response?.ok) { api.remove(); review = null; return; }
      error.textContent = response?.error || '取消未完成，请在客户端核查任务状态';
      cancel.disabled = false;
    });
  });
  footer.append(timer, cancel, error); aside.append(title, subtitle, list, footer); shadow.append(style, aside);
  document.documentElement.append(host);
  let interval;
  const api = {
    eventId,
    verified: false,
    verify(labels) {
      for (const label of labels) items.get(label)?.classList.add('ok');
      this.verified = items.size > 0 && [...items.values()].every(item => item.classList.contains('ok'));
      if (!this.verified) return;
      if (!autoSubmit) { timer.textContent = '已核对 · 等待人工确认'; return; }
      const until = Date.now() + 30000;
      const render = () => {
        const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        timer.textContent = remaining ? `${remaining} 秒后自动确认` : '正在等待客户端确认';
        if (!remaining) clearInterval(interval);
      };
      render(); interval = setInterval(render, 200);
    },
    remove() { clearInterval(interval); host.remove(); },
  };
  return api;
}
