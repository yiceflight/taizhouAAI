import { useEffect, useRef, useState } from 'react';
import { dataQuality, defaultSettings, flightDisplay, hourTime, type WorkspaceSettings, type HourRow, type MonitorView } from '../lib/workspace';
import { DroneStatus } from './DroneStatus';
const format = (value: number | null | undefined) => value == null ? '暂无数据' : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
const dateValue = hourTime;
type ViewMode = 'chart' | 'table';
type Range = 24 | 72 | 168 | 'today';
const rangeOptions: Array<{ value: Range; label: string }> = [
  { value: 'today', label: '今天' },
  { value: 24, label: '最近 24 小时' },
  { value: 72, label: '最近 3 天' },
  { value: 168, label: '最近 7 天' },
];
const beijingDateKey = (timestamp: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(timestamp));

function RangePicker({ value, onChange }: { value: Range; onChange: (value: Range) => void }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = rangeOptions.find(option => option.value === value) ?? rangeOptions[1];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return <div className="range-picker" ref={pickerRef}>
    <span className="range-picker-label">时间范围</span>
    <button type="button" className="range-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)}>
      <span>{selected.label}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && <div className="range-picker-menu" role="listbox" aria-label="时间范围">
      {rangeOptions.map(option => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>
        {option.value === value && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}

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

type Props = { data: MonitorView | null; busy: boolean; ready: boolean; started: boolean; action: (command: string, args?: Record<string, unknown>) => Promise<boolean>; onPrepare: () => void; onFlight: () => void; onAir?: () => void; reportGenerating?: boolean };
function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <svg className={`refresh-icon${spinning ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
    <path d="M3 4v5h5" />
    <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
    <path d="M21 20v-5h-5" />
  </svg>;
}
export function MonitoringPanel({ data, busy, ready, started, action, onPrepare, onFlight, onAir, reportGenerating }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('chart');
  const [range, setRange] = useState<Range>(24);
  const latest = data?.rows[0];
  const quality = dataQuality(data);
  const settings = data?.settings ?? defaultSettings;
  const today = beijingDateKey(Date.now());
  const rows = (data?.rows || []).filter(row => {
    if (range === 'today') return row.time.slice(0, 10) === today;
    return !latest || dateValue(row.time) >= dateValue(latest.time) - (range - 1) * 3600000;
  });
  const { event: plan, records } = flightDisplay(data);
  const pending = plan && !['dismissed', 'canceled', 'completed'].includes(plan.status);
  return <div className="monitoring-workspace">
    <div className={`page-heading monitoring-heading ${quality.tone}`}><div>
      <span className="eyebrow">泰州市 · 小时监测</span>
      <h2>最新监测数据</h2>
      <div className="heading-status">
        <strong>{quality.detail}</strong>
        <span>最近成功同步：{data?.lastSuccess || '尚未同步'}{latest ? ` · 本机最新记录 ${latest.time.slice(5, 16)}` : ''}</span>
      </div>
    </div><div className="sync-action-row"><button className="icon-button" aria-label={data?.syncing ? '正在同步' : '立即同步'} title={data?.syncing ? '正在同步' : '立即同步'} disabled={!ready || !started || busy || data?.syncing} onClick={() => void action('sync_monitoring')}><RefreshIcon spinning={data?.syncing} /></button></div></div>
    <div className="metric-grid">
      <article className={latest?.potassium == null || quality.label === '数据已过期' || latest.potassium > settings.potassiumThreshold ? 'metric-warning' : ''}><span>钾离子 K⁺ <small>μg/m³</small></span><strong>{format(latest?.potassium)}</strong><small>{latest?.potassium == null ? '无法判断是否触发巡查' : `巡查触发阈值 > ${format(settings.potassiumThreshold)}`}</small></article>
      <article className={`time-metric ${quality.tone === 'warning' ? 'metric-warning' : ''}`}><span>数据所属时间</span><strong>{latest?.time.slice(0, 16) || '暂无数据'}</strong><small>{quality.label} · {latest ? '北京时间' : '等待首次读取'}</small></article>
    </div>
    {data?.error && <div className="notice warning" role="alert"><strong>最近一次同步未完成</strong><p>{data.error}</p>{!ready && <button className="text-button" onClick={onPrepare}>查看运行状态 →</button>}</div>}
    <section id="monitoring-task-details" className={`task-details ${pending ? 'task-callout' : 'data-card'}`} aria-label="巡查任务详情">
      <div className="section-heading"><h3>巡查任务</h3><button className="text-button" onClick={onFlight}>查看任务 →</button></div>
      <DroneStatus data={data} ready={ready} started={started} busy={busy} action={action} onFlight={onFlight} onAir={onAir} reportGenerating={reportGenerating} />
      {pending && <div className="task-details-copy"><p>{plan.name} · {plan.observedAt.slice(0, 16)}（北京时间）</p>
        {plan.status === 'failed' && <p>本次未发送起飞请求。请人工核验电量、设备状态和平台提示；系统回执不足以确认具体设备故障。</p>}
        {plan.status === 'restricted' && <p>{plan.error}</p>}
        {(plan.status === 'failed' || plan.status === 'uncertain' || plan.status === 'flight_error' || plan.status === 'not_flown') && plan.error && <details><summary>查看原始回执</summary><p>{plan.error}</p></details>}
      </div>}
      {plan && !plan.preview && ['ready', 'submitted', 'uncertain', 'flying', 'paused', 'completed', 'flight_error', 'not_flown'].includes(plan.status) && <div className="task-details-copy" role="status">
        {plan.statusCheckedAt ? <p>最近核查：{new Date(plan.statusCheckedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间） · {plan.statusCheckError ? '核查未完成' : plan.status === 'uncertain' ? '已读取司空任务，起飞结果仍待核查' : '已更新任务状态'}</p> : <p>尚未取得司空状态核查结果。</p>}
        {plan.statusCheckError && <p>司空核查：{plan.statusCheckError}</p>}
        {plan.status === 'uncertain' && <p>手动刷新后，若司空仍未识别到任务状态，将保留历史记录并恢复起飞入口；再次起飞前请核对平台任务。</p>}
      </div>}
      {!!records.length && <details className="task-records"><summary>最近巡查记录（{records.length}）</summary><ul>{records.map(record => <li key={record.id}><strong>{record.observedAt.slice(0, 16)}{record.resolvedAt ? ' · 已结束处理' : ''} · {record.status === 'restricted' ? '禁飞时间 · 仅记录' : record.status === 'failed' ? '起飞未完成 · 待人工核验' : record.status === 'completed' ? '巡飞已结束' : record.status === 'uncertain' ? '起飞结果未确认 · 历史记录' : '历史任务'}</strong><p>{record.name}{record.potassium != null ? ` · K⁺ ${format(record.potassium)} μg/m³` : ''}</p>{record.status === 'restricted' ? <p>{record.error}</p> : record.error && <details><summary>查看原始回执</summary><p>{record.error}</p></details>}{record.statusCheckError && <p>司空核查：{record.statusCheckError}</p>}</li>)}</ul></details>}
    </section>
    <section className="data-card"><div className="chart-toolbar"><h3>小时变化趋势</h3><div className="button-row"><RangePicker value={range} onChange={setRange} /><div className="view-switcher-buttons" role="group" aria-label="数据展示方式"><button className={viewMode === 'chart' ? 'active' : ''} aria-pressed={viewMode === 'chart'} onClick={() => setViewMode('chart')}>图表</button><button className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}>表格</button></div></div></div>
    {!rows.length ? <div className="empty-state"><h3>暂无数据</h3><p>环境就绪后将自动读取首批数据。</p><button className="secondary-button" onClick={onPrepare}>查看运行状态</button></div> : viewMode === 'chart' ? <MonitoringChart rows={rows} settings={settings} /> : <div className="hourly-table-wrap"><table className="hourly-table"><thead><tr><th>数据时间</th><th>K⁺（μg/m³）</th><th>数据状态</th></tr></thead><tbody>{rows.map((row, index) => { const older = rows[index + 1]; const gap = older ? (dateValue(row.time) - dateValue(older.time)) / 3600000 - 1 : 0; return <tr key={row.time}><td>{row.time.slice(0,16)}</td><td className={row.potassium != null && row.potassium > settings.potassiumThreshold ? 'missing-value' : ''}>{format(row.potassium)}</td><td className={row.potassium === null || gap > 0 ? 'missing-value' : ''}>{row.potassium === null ? '暂无数据' : '数据齐全'}{gap > 0 ? ` · 此前缺 ${gap} 小时` : ''}</td></tr>; })}</tbody></table></div>}
    </section>
  </div>;
}
