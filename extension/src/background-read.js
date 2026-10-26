// Only for reads: a timed-out page promise may still finish, so never use this
// wrapper for plan preparation/submission or other side-effectful commands.
// The watchdog lives in the extension worker, outside the hidden page's timers.
export async function evaluateBackgroundRead(api, tabId, parameters, timeoutMs = 25000) {
  const target = { tabId };
  const bounded = async (operation, ms) => {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('后台页面读取超时，请检查网站或网络后重试')), ms);
        }),
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    // Emulate page visibility without activating the tab or focusing Chrome.
    await bounded(() => api.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }), 2000);
    return await bounded(() => api.sendCommand(target, 'Runtime.evaluate', parameters), timeoutMs);
  } finally {
    // Also bound cleanup: a lost CDP response must not hold the serial queue.
    await bounded(() => api.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: false }), 2000).catch(() => {});
  }
}
