import { weatherPasses } from '../lib/weather';
import { useState } from 'react';
import { flightSummary, dataQuality, defaultSettings, hourTime, type WorkspaceSettings, type HourRow, type MonitorView } from '../lib/workspace';
const format = (value: number | null | undefined) => value == null ? '暂无数据' : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
const dateValue = hourTime;
type ViewMode = 'chart' | 'table';
function MonitoringChart({ rows, settings }: { rows: HourRow[]; settings: WorkspaceSettings }) {
  const [activeTime, setActiveTime] = useState<number | null>(null);
  const chartRows = [...rows].sort((a, b) => dateValue(a.time) - dateValue(b.time));
  const width = 960;
  const height = 300;
  const margin = { top: 22, right: 58, bottom: 42, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const potassiumMax = Math.max(...chartRows.map((row) => row.potassium ?? 0), settings.potassiumThreshold * 1.2);
  const first = dateValue(chartRows[0].time), last = dateValue(chartRows[chartRows.length - 1].time);
  const hourCount = Math.round((last - first) / 3600000) + 1;
  const slotWidth = plotWidth / hourCount;
  const barWidth = Math.min(24, slotWidth * .6);
  const xAt = (time: number) => margin.left + ((time - first) / 3600000 + .5) * slotWidth;
  const x = (index: number) => xAt(dateValue(chartRows[index].time));
  const activeIndex = activeTime == null ? -1 : Math.round((activeTime - first) / 3600000);
  const showTooltip = activeIndex >= 0 && activeIndex < hourCount;
  const activeRow = chartRows.find(row => dateValue(row.time) === activeTime);
  const tooltipWidth = 218;
  const tooltipX = showTooltip ? Math.max(margin.left, Math.min(width - margin.right - tooltipWidth, xAt(activeTime!) + (xAt(activeTime!) > width / 2 ? -tooltipWidth - 12 : 12))) : 0;
  const tooltipTime = showTooltip ? new Date(activeTime! + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
  const y = (value: number, max: number) => margin.top + plotHeight - value / max * plotHeight;
  const labelIndexes = chartRows.length > 1 ? [0, Math.floor((chartRows.length - 1) / 2), chartRows.length - 1] : [0];
  const gridValues = [0, .25, .5, .75, 1];

  return <div className="monitor-chart" aria-label="小时监测趋势图">
    <div className="chart-header">
      <div className="chart-legend"><span className="legend-item"><i className="legend-bar potassium-line" />K⁺（μg/m³）</span></div>
      <span className="chart-range">{chartRows.length} 条小时记录</span>
    </div>
    <svg className="monitor-chart-svg" viewBox={`0 0 ${width} ${height}`} role="group" tabIndex={0} aria-labelledby="monitor-chart-title monitor-chart-desc"
      onPointerLeave={() => setActiveTime(null)} onBlur={() => setActiveTime(null)}
      onFocus={() => setActiveTime(first)} onKeyDown={event => {
        if (event.key === 'Escape') setActiveTime(null);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const next = showTooltip ? activeIndex + (event.key === 'ArrowRight' ? 1 : -1) : 0;
          setActiveTime(first + Math.max(0, Math.min(hourCount - 1, next)) * 3600000);
        }
      }}>
      <title id="monitor-chart-title">钾离子小时趋势</title>
      <desc id="monitor-chart-desc">柱状图表示钾离子，超过阈值时标红。悬停查看小时数据，也可使用左右方向键切换，按 Escape 关闭提示。</desc>
      {gridValues.map((ratio) => <g key={ratio}>
        <line x1={margin.left} x2={width - margin.right} y1={margin.top + plotHeight * (1 - ratio)} y2={margin.top + plotHeight * (1 - ratio)} className="chart-grid-line" />
        <text x={margin.left - 10} y={margin.top + plotHeight * (1 - ratio) + 4} textAnchor="end" className="chart-axis-label">{(potassiumMax * ratio).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</text>
      </g>)}
      {chartRows.map((row, index) => row.potassium != null && <rect key={row.time} x={x(index) - barWidth / 2} y={y(row.potassium, potassiumMax)} width={barWidth} height={Math.max(0, row.potassium / potassiumMax * plotHeight)} className={`potassium-bar ${row.potassium > settings.potassiumThreshold ? 'exceeded-point' : 'potassium-point'}`} />)}
      <line x1={margin.left} x2={width - margin.right} y1={y(settings.potassiumThreshold, potassiumMax)} y2={y(settings.potassiumThreshold, potassiumMax)} className="threshold-line" />
      <text x={margin.left + 8} y={y(settings.potassiumThreshold, potassiumMax) - 6} className="threshold-label">K⁺ 巡查阈值 {format(settings.potassiumThreshold)}</text>
      {labelIndexes.map((index) => <text key={index} x={x(index)} y={height - 14} textAnchor={index === 0 ? "start" : index === chartRows.length - 1 ? "end" : "middle"} className="chart-axis-label">{chartRows[index].time.slice(5, 13)}</text>)}
      <text x={margin.left - 10} y={margin.top - 8} textAnchor="end" className="chart-axis-unit">K⁺</text>
      {Array.from({ length: hourCount }, (_, index) => <rect key={index} x={margin.left + index * slotWidth} y={margin.top} width={slotWidth} height={plotHeight} fill="transparent" onPointerMove={() => setActiveTime(first + index * 3600000)} onPointerDown={() => setActiveTime(first + index * 3600000)} />)}
      {showTooltip && <g className="chart-tooltip" role="tooltip" aria-live="polite">
        <line x1={xAt(activeTime!)} x2={xAt(activeTime!)} y1={margin.top} y2={margin.top + plotHeight} className="chart-hover-line" />
        <rect x={tooltipX} y={margin.top + 8} width={tooltipWidth} height={80} rx={6} className="chart-tooltip-box" />
        <text x={tooltipX + 12} y={margin.top + 29} className="chart-tooltip-time">{tooltipTime}</text>
        <text x={tooltipX + 12} y={margin.top + 45} className="chart-tooltip-status">{activeRow ? '北京时间' : '北京时间 · 该小时无记录'}</text>
        <text x={tooltipX + 12} y={margin.top + 68} className={activeRow?.potassium != null && activeRow.potassium > settings.potassiumThreshold ? 'exceeded-point' : 'potassium-point'}>K⁺：{format(activeRow?.potassium)}{activeRow?.potassium != null ? ' μg/m³' : ''}</text>
      </g>}
    </svg>
    <p className="chart-note">柱状图表示 K⁺ 小时数据，虚线为巡查阈值；暂无数据时留空。悬停查看小时数据。</p>
  </div>;
}

type Props = { data: MonitorView | null; busy: boolean; ready: boolean; started: boolean; action: (command: string, args?: Record<string, unknown>) => Promise<boolean>; onPrepare: () => void; onFlight: () => void };
function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <svg className={`refresh-icon${spinning ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
    <path d="M3 4v5h5" />
    <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
    <path d="M21 20v-5h-5" />
  </svg>;
}
export function MonitoringPanel({ data, busy, ready, started, action, onPrepare, onFlight }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('chart');
  const [range, setRange] = useState(24);
  const latest = data?.rows[0];
  const quality = dataQuality(data);
  const settings = data?.settings ?? defaultSettings;
  const rows = (data?.rows || []).filter(row => !latest || dateValue(row.time) >= dateValue(latest.time) - (range - 1) * 3600000);
  const plan = data?.flight.event;
  const pending = plan && !['dismissed', 'canceled'].includes(plan.status);
  return <div className="monitoring-workspace">
    <div className="page-heading"><div><span className="eyebrow">泰州市 · 小时监测</span><h2>最新监测数据</h2><p>江苏大气站 · 城市混合数据 · 北京时间</p></div></div>
    <div className="metric-grid">
      <article className={latest?.potassium == null || quality.label === '数据已过期' || latest.potassium > settings.potassiumThreshold ? 'metric-warning' : ''}><span>钾离子 K⁺ <small>μg/m³</small></span><strong>{format(latest?.potassium)}</strong><small>{latest?.potassium == null ? '无法判断是否触发巡查' : `巡查触发阈值 > ${format(settings.potassiumThreshold)}`}</small></article>
      <article className={`time-metric ${quality.tone === 'warning' ? 'metric-warning' : ''}`}><span>数据所属时间</span><strong>{latest?.time.slice(0, 16) || '暂无数据'}</strong><small>{quality.label} · {latest ? '北京时间' : '等待首次读取'}</small></article>
    </div>
    <div className={`data-summary ${quality.tone}`}><strong>{quality.detail}</strong><p>最近成功同步：{data?.lastSuccess || '尚未同步'}。{latest ? `本机最新记录为 ${latest.time.slice(5,16)}。` : ''}同步成功不代表平台已经发布最新小时数据。</p></div>
    <div className="sync-action-row"><button className="icon-button" aria-label={data?.syncing ? '正在同步' : '立即同步'} title={data?.syncing ? '正在同步' : '立即同步'} disabled={!ready || !started || busy || data?.syncing} onClick={() => void action('sync_monitoring')}><RefreshIcon spinning={data?.syncing} /></button></div>
    {data?.error && <div className="notice warning" role="alert"><strong>最近一次同步未完成</strong><p>{data.error}</p>{!ready && <button className="text-button" onClick={onPrepare}>前往修复工作环境 →</button>}</div>}
    {pending && <button className="task-callout" onClick={onFlight}><span><strong>{flightSummary(data, ready && started).title}</strong><small>{plan.name}</small></span><span>查看任务 →</span></button>}
    <section className="data-card"><div className="chart-toolbar"><h3>小时变化趋势</h3><div className="button-row"><label className="range-select">时间范围 <select value={range} onChange={e => setRange(Number(e.target.value))}><option value={24}>最近 24 小时</option><option value={72}>最近 3 天</option><option value={168}>最近 7 天</option></select></label><div className="view-switcher-buttons" role="group" aria-label="数据展示方式"><button className={viewMode === 'chart' ? 'active' : ''} aria-pressed={viewMode === 'chart'} onClick={() => setViewMode('chart')}>图表</button><button className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}>表格</button></div></div></div>
    {!rows.length ? <div className="empty-state"><h3>暂无数据</h3><p>完成准备向导后读取首批数据。</p><button className="secondary-button" onClick={onPrepare}>前往准备</button></div> : viewMode === 'chart' ? <MonitoringChart rows={rows} settings={settings} /> : <div className="hourly-table-wrap"><table className="hourly-table"><thead><tr><th>数据时间</th><th>K⁺（μg/m³）</th><th>数据状态</th></tr></thead><tbody>{rows.map((row, index) => { const older = rows[index + 1]; const gap = older ? (dateValue(row.time) - dateValue(older.time)) / 3600000 - 1 : 0; return <tr key={row.time}><td>{row.time.slice(0,16)}</td><td className={row.potassium != null && row.potassium > settings.potassiumThreshold ? 'missing-value' : ''}>{format(row.potassium)}</td><td className={row.potassium === null || gap > 0 ? 'missing-value' : ''}>{row.potassium === null ? '暂无数据' : '数据齐全'}{gap > 0 ? ` · 此前缺 ${gap} 小时` : ''}</td></tr>; })}</tbody></table></div>}
    </section><p className="panel-footnote">已保存 {data?.total || 0} 条小时数据 · 保持客户端与 Chrome 运行 · 每 5 分钟检查数据</p>
  </div>;
}
export function FlightPanel({ data, busy, ready, started, action, onPrepare }: Omit<Props, 'onFlight'>) {
  const flight = data?.flight, plan = flight?.event;
  const active = plan && !['dismissed', 'canceled'].includes(plan.status);
  const blocked = !ready || !started || !data;
  const summary = flightSummary(data, !blocked);
  const weatherReady = weatherPasses(data?.weather);
  const cancelable = plan && ['countdown', 'preparing'].includes(plan.status);
  const archivable = active && !['countdown', 'preparing', 'submitting'].includes(plan.status);
  const quality = dataQuality(data);
  return <div className="flight-workspace"><div className="page-heading"><div><span className="eyebrow">无人机巡飞</span><h2>巡查任务</h2><p>自动巡飞在 K⁺ 超标后按设置准备巡查；手动起飞不受超标条件限制。</p></div></div>
    <section className="setup-card"><div className="section-heading"><div><h3>{summary.title}</h3><p>{summary.detail}</p></div><span className={`badge ${['warning', 'danger'].includes(summary.tone) ? 'warning' : 'success'}`}>{flight?.enabled ? '自动巡飞' : '手动模式'}</span></div>
      {active && <><p className="capture-help">{plan.name} · {plan.preview ? '填写演练，不起飞' : plan.source === 'manual' ? '手动发起' : `K⁺ ${format(plan.potassium)} μg/m³ · ${plan.observedAt.slice(0,16)}`}</p>{plan.error && <p className="notice warning" role="alert">{plan.error}</p>}</>}
      {!active && quality.tone === 'warning' && quality.label !== 'K⁺ 超过巡查阈值' && <p className="capture-help">等待有效监测数据：{quality.detail}。工作环境就绪后仍可手动起飞。</p>}
      <div className="button-row">
        {cancelable && <button className="secondary-button" onClick={() => void action('cancel_flight', { eventId: plan.id })}>取消任务</button>}
        {!active && <button className="primary-button" disabled={busy || blocked || !weatherReady} onClick={() => void action('launch_flight')}>手动起飞</button>}
        {active && !cancelable && <button className="secondary-button" disabled={busy} onClick={() => void action('open_prepared_flight')}>前往司空查看 ↗</button>}
        {archivable && <button className="secondary-button" disabled={busy} onClick={() => void action('dismiss_flight', { eventId: plan.id })}>已核查司空，归档任务</button>}
        {blocked && <button className="text-button" onClick={onPrepare}>完成工作准备 →</button>}
      </div>
      <p className="capture-help">提交成功仅表示巡飞计划已创建，实际起飞、飞行和返航状态以司空为准。归档不会终止正在执行的飞行。</p>
    </section>
    <section className="setup-card"><div className="section-heading"><div><h3>自动巡飞设置</h3><p>K⁺ &gt; {flight?.threshold ?? 1} μg/m³ 时{data?.settings?.requireManualConfirmation ? '直接填写计划，等待在司空人工确认。' : '启动倒计时，结束后自动提交，期间可取消任务。'}</p></div><label className="flight-auto-setting"><input type="checkbox" checked={flight?.enabled ?? false} disabled={!data || busy || (blocked && !flight?.enabled)} onChange={e => void action('set_flight_enabled', { enabled: e.target.checked })}/>自动巡飞</label></div>
      {!data?.settings?.requireManualConfirmation && <p className="flight-delay-setting">起飞延迟：<strong>{data?.settings?.takeoffDelayMinutes ?? 5} 分钟</strong> · 自动提交。可在右上角「设置」中修改。</p>}
      <p className="capture-help">连续超标只触发一次；取消后本轮不再自动触发。有效 K⁺ 恢复正常后，下一轮超标可重新触发。缺测、过期或未来数据不会自动起飞。修改延迟用于下一次任务。</p>
    </section>
    <details className="advanced-panel"><summary>航线与填写演练</summary><p>东南火点巡查航线 · 泰州环境监测 Dock 3 · Matrice 4TD · 高精度 RTK · 返航高度 110 米</p><p>手动起飞使用同一航线，不要求 K⁺ 超标；司空自身的设备、空域和飞行检查仍然有效。</p><button className="secondary-button" disabled={!data || blocked || !weatherReady || busy || !!active} onClick={() => void action('prepare_flight', { preview: true })}>演练计划填写</button></details>
  </div>;
}
