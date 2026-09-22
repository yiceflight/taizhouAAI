export const SITE_PATTERNS = ["http://61.155.4.60:18080/*", "https://fh.dji.com/*", "https://aai.airins.cn/*"];
export function allowedUrl(value) {
  try { const url = new URL(value); return !url.username && !url.password && ["http://61.155.4.60:18080", "https://fh.dji.com", "https://aai.airins.cn"].includes(url.origin); }
  catch { return false; }
}
export function evaluationValue(result) {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "页面脚本执行失败");
  if (!result.result || !("value" in result.result)) throw new Error("页面未返回可序列化数据");
  return result.result.value;
}
// This function runs in the selected page. No form input values, cookies or storage are collected.
export function pageSnapshot() {
  if (!["http://61.155.4.60:18080", "https://fh.dji.com", "https://aai.airins.cn"].includes(location.origin)) throw new Error("页面已离开授权网站");
  const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const text = (document.body?.innerText || "").trim();
  const allTables = [...document.querySelectorAll("table")].filter(visible);
  let truncated = text.length > 100000 || allTables.length > 20;
  let remainingTableCharacters = 200000;
  const tables = allTables.slice(0, 20).map((table) => {
    const rows = [...table.rows].filter(visible);
    if (rows.length > 200) truncated = true;
    return rows.slice(0, 200).map((row) => {
      if (row.cells.length > 30) truncated = true;
      return [...row.cells].slice(0, 30).map((cell) => {
        if (remainingTableCharacters <= 0) { truncated = true; return ""; }
        const value = cell.innerText.trim();
        const limit = Math.min(1000, remainingTableCharacters);
        if (value.length > limit) truncated = true;
        const result = value.slice(0, limit);
        remainingTableCharacters -= result.length;
        return result;
      });
    });
  }).filter((table) => table.some((row) => row.some(Boolean)));
  return { url: location.href, title: document.title, text: text.slice(0, 100000), tables, truncated };
}
