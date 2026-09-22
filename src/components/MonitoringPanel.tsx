import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

type HourRow = { time: string; potassium: number | null; pm25: number | null };
type MonitorView = { enabled: boolean; syncing: boolean; lastAttempt: string | null; lastSuccess: string | null; error: string | null; total: number; rows: HourRow[]; queryThrough: string | null; flight: FlightView };
type FlightEvent = { id: string; observedAt: string; potassium: number | null; name: string; status: "preparing" | "ready" | "failed" | "dismissed"; error: string | null; preview: boolean };
type FlightView = { enabled: boolean; threshold: number; event: FlightEvent | null };
type ViewMode = "chart" | "table";
const format = (value: number | null | undefined) => value == null ? "缺测" : value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
const dateValue = (value: string) => new Date(value.replace(" ", "T") + "+08:00").getTime();

function MonitoringChart({ rows }: { rows: HourRow[] }) {
  const chartRows = [...rows].sort((a, b) => dateValue(a.time) - dateValue(b.time));
  const width = 960;
  const height = 300;
  const margin = { top: 22, right: 58, bottom: 42, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const potassiumMax = Math.max(...chartRows.map((row) => row.potassium ?? 0), 0.1);
  const pm25Max = Math.max(...chartRows.map((row) => row.pm25 ?? 0), 1);
  const x = (index: number) => margin.left + (chartRows.length < 2 ? plotWidth / 2 : index * plotWidth / (chartRows.length - 1));
  const y = (value: number, max: number) => margin.top + plotHeight - value / max * plotHeight;
  const pathFor = (key: "potassium" | "pm25", max: number) => {
    let path = "";
    let previous = false;
    chartRows.forEach((row, index) => {
      if (row[key] == null) { previous = false; return; }
      path += `${previous ? " L" : " M"}${x(index).toFixed(1)},${y(row[key] as number, max).toFixed(1)}`;
      previous = true;
    });
    return path;
  };
  const labelIndexes = chartRows.length > 1 ? [0, Math.floor((chartRows.length - 1) / 2), chartRows.length - 1] : [0];
  const gridValues = [0, .25, .5, .75, 1];

  return <div className="monitor-chart" aria-label="小时监测趋势图">
    <div className="chart-header">
      <div className="chart-legend"><span className="legend-item"><i className="legend-line potassium-line" />K⁺（μg/m³）</span><span className="legend-item"><i className="legend-line pm25-line" />PM2.5（μg/m³）</span></div>
      <span className="chart-range">最近 {chartRows.length} 小时</span>
    </div>
    <svg className="monitor-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="monitor-chart-title monitor-chart-desc">
      <title id="monitor-chart-title">钾离子和 PM2.5 小时趋势</title>
      <desc id="monitor-chart-desc">图中绿色线表示钾离子，橙色线表示 PM2.5，缺测时段会断开。</desc>
      {gridValues.map((ratio) => <g key={ratio}>
        <line x1={margin.left} x2={width - margin.right} y1={margin.top + plotHeight * (1 - ratio)} y2={margin.top + plotHeight * (1 - ratio)} className="chart-grid-line" />
        <text x={margin.left - 10} y={margin.top + plotHeight * (1 - ratio) + 4} textAnchor="end" className="chart-axis-label">{(potassiumMax * ratio).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</text>
        <text x={width - margin.right + 10} y={margin.top + plotHeight * (1 - ratio) + 4} className="chart-axis-label">{Math.round(pm25Max * ratio)}</text>
      </g>)}
      <path d={pathFor("potassium", potassiumMax)} className="chart-line potassium-stroke" />
      <path d={pathFor("pm25", pm25Max)} className="chart-line pm25-stroke" />
      {chartRows.map((row, index) => <g key={row.time}>
        {row.potassium != null && <circle cx={x(index)} cy={y(row.potassium, potassiumMax)} r="2.2" className="chart-point potassium-point"><title>{`${row.time.slice(0, 16)} · K⁺ ${format(row.potassium)} μg/m³`}</title></circle>}
        {row.pm25 != null && <circle cx={x(index)} cy={y(row.pm25, pm25Max)} r="2.2" className="chart-point pm25-point"><title>{`${row.time.slice(0, 16)} · PM2.5 ${format(row.pm25)} μg/m³`}</title></circle>}
      </g>)}
      {labelIndexes.map((index) => <text key={index} x={x(index)} y={height - 14} textAnchor={index === 0 ? "start" : index === chartRows.length - 1 ? "end" : "middle"} className="chart-axis-label">{chartRows[index].time.slice(5, 13)}</text>)}
      <text x={margin.left - 10} y={margin.top - 8} textAnchor="end" className="chart-axis-unit">K⁺</text>
      <text x={width - margin.right + 10} y={margin.top - 8} className="chart-axis-unit">PM2.5</text>
    </svg>
    <p className="chart-note">左右刻度分别对应两项指标，悬停数据点可查看具体值。</p>
  </div>;
}

export function MonitoringPanel({ openSite }: { openSite: () => void }) {
  const [data, setData] = useState<MonitorView | null>(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("chart");
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const value = await invoke<MonitorView>("get_monitoring"); if (!cancelled) { setData(value); setError(""); } }
      catch (err) { if (!cancelled) setError(String(err)); }
      if (!cancelled) timer = setTimeout(refresh, 2000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  async function action(command: string, args?: Record<string, unknown>) {
    setActing(true); setError("");
    try { await invoke(command, args); setData(await invoke<MonitorView>("get_monitoring")); }
    catch (err) { setError(String(err)); }
    finally { setActing(false); }
  }
  const latest = data?.rows[0];
  const flight = data?.flight;
  const plan = flight?.event;
  const planActive = plan && plan.status !== "dismissed";
  const stale = latest && Date.now() - new Date(latest.time.replace(" ", "T") + "+08:00").getTime() > 3 * 3600000;
  return <div className="monitoring-workspace">
    <div className="panel-toolbar monitor-toolbar">
      <div><h2>泰州市小时监测</h2><span className="muted">江苏大气站 · 混合数据 · 城市</span></div>
      <button className="secondary-button" onClick={openSite}>打开大气站 / 登录 ↗</button>
    </div>
    <div className="metric-grid">
      <article><span>钾离子 K⁺</span><strong>{format(latest?.potassium)}</strong><small>μg/m³</small></article>
      <article><span>PM2.5</span><strong>{format(latest?.pm25)}</strong><small>μg/m³</small></article>
      <article className="time-metric"><span>最新数据时间（北京时间）</span><strong>{latest?.time.slice(0, 16) || "等待首次同步"}</strong><small>{stale ? "数据已超过 3 小时未更新" : latest ? "按平台小时数据记录" : "登录并保持时间序列页面打开"}</small></article>
    </div>
    <div className="sync-toolbar">
      <span role="status"><span className={`status-dot${data?.enabled && !data.error ? " connected" : ""}`} /> {data?.syncing ? "正在同步…" : data?.enabled ? "自动同步已开启 · 每 5 分钟检查" : data ? "自动同步已暂停" : "请在桌面客户端同步"}</span>
      <div><button className="secondary-button" disabled={!data || acting || data.syncing} onClick={() => void action("set_monitoring_enabled", { enabled: !data?.enabled })}>{data?.enabled ? "暂停自动同步" : "开启自动同步"}</button><button className="primary-button" disabled={!data || acting || data.syncing} onClick={() => void action("sync_monitoring")}>立即同步</button></div>
    </div>
    {(error || data?.error) && <p className="monitor-error" role="alert">{error || data?.error}</p>}
    <p className="capture-help">最近成功同步：{data?.lastSuccess || "尚未同步"} · 已保存 {data?.total || 0} 个小时。首次同步最近 7 天，每小时保留一条，缺测值显示为“缺测”。</p>
    <section className="flight-panel" aria-label="超标巡查计划">
      <div className="flight-heading"><div><h3>第二步 · 司空巡查计划</h3><p>K⁺ &gt; 1.0 μg/m³ 时自动打开司空并填写，停在最终确认前。</p></div>
        <button className="secondary-button" disabled={!data || acting || plan?.status === "preparing"} onClick={() => void action("set_flight_enabled", { enabled: !flight?.enabled })}>{flight?.enabled ? "暂停自动填写" : "开启自动填写"}</button>
      </div>
      <p className="flight-recipe">东南火点巡查航线（已验证） · 泰州环境监测 Dock 3 · 高精度 RTK · 立即 · 返航高度 110 米</p>
      <p className="flight-safety">仅填写，不提交计划、不触发起飞。连续超标只准备一次；旧数据和缺测不触发。</p>
      {planActive ? <div className="flight-result" role="status">
        <strong>{plan.preview ? "填写演练 · " : "超标巡查 · "}{plan.status === "preparing" ? "正在打开页面并填写…" : plan.status === "ready" ? "已填写，等待人工确认（未提交）" : "填写未完成（未提交）"}</strong>
        <span>{plan.name}{!plan.preview && ` · ${plan.observedAt.slice(0, 16)} · K⁺ ${format(plan.potassium)} μg/m³`}</span>
        {plan.error && <p className="monitor-error">{plan.error}</p>}
        <div className="flight-actions">
          {plan.status === "failed" && <button className="primary-button" disabled={acting} onClick={() => void action("prepare_flight", { preview: false })}>重试填写</button>}
          {plan.status !== "preparing" && <button className="secondary-button" disabled={acting} onClick={() => void action("dismiss_flight")}>结束本次处理</button>}
        </div>
        <small>结束处理只清除客户端待办，请在 Chrome 中保留或取消草稿。异常不会自动重复重试。</small>
      </div> : <div className="flight-actions"><span>{flight?.enabled ? "等待最新小时数据超标" : "自动填写已暂停"}</span><button className="secondary-button" disabled={!data || acting} onClick={() => void action("prepare_flight", { preview: true })}>按视频规则填写演练</button></div>}
    </section>
    <div className="view-switcher" role="group" aria-label="数据展示方式">
      <span className="view-switcher-label">展示方式</span>
      <div className="view-switcher-buttons">
        <button className={viewMode === "chart" ? "active" : ""} aria-pressed={viewMode === "chart"} onClick={() => setViewMode("chart")}>图表</button>
        <button className={viewMode === "table" ? "active" : ""} aria-pressed={viewMode === "table"} onClick={() => setViewMode("table")}>表格</button>
      </div>
    </div>
    {viewMode === "chart" && (data?.rows.length ? <MonitoringChart rows={data.rows} /> : <div className="chart-empty"><div className="empty-state"><h3>尚无小时监测数据</h3><p>连接 Chrome 插件后，登录江苏大气站并打开时间序列页面。</p><p>系统将查询泰州市 K⁺ 与 PM2.5，并保存至本机数据库。</p></div></div>)}
    {viewMode === "table" && <div className="hourly-table-wrap"><table className="hourly-table">
      <thead><tr><th>数据时间（北京时间）</th><th>K⁺（μg/m³）</th><th>PM2.5（μg/m³）</th><th>数据完整性</th></tr></thead>
      <tbody>{data?.rows.length ? data.rows.map((row, i) => {
        const older = data.rows[i + 1];
        const gap = older ? (dateValue(row.time) - dateValue(older.time)) / 3600000 - 1 : 0;
        return <tr key={row.time}><td>{row.time.slice(0, 16)}</td><td>{format(row.potassium)}</td><td>{format(row.pm25)}</td><td className={row.potassium === null || row.pm25 === null || gap > 0 ? "missing-value" : ""}>{row.potassium === null && row.pm25 === null ? "两项均缺测" : row.potassium === null || row.pm25 === null ? "部分指标缺测" : "两项齐全"}{gap > 0 ? ` · 此前缺 ${gap} 小时` : ""}</td></tr>;
      }) : <tr><td colSpan={4}><div className="empty-state"><h3>尚无小时监测数据</h3><p>连接 Chrome 插件后，登录江苏大气站并打开时间序列页面。</p><p>系统将查询泰州市 K⁺ 与 PM2.5，并保存至本机数据库。</p></div></td></tr>}</tbody>
    </table></div>}
    <div className="panel-footnote">显示最近 168 条 · 历史记录保存在本机 · 自动回查 48 小时补齐迟到数据 · 保持客户端与 Chrome 运行</div>
  </div>;
}
