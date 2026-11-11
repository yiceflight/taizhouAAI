import { useEffect, useRef, useState } from 'react';
import { dataQuality, defaultSettings, flightDisplay, hourTime, isCurrentFlightEvent, triggerReading, type WorkspaceSettings, type HourRow, type MonitorView } from '../lib/workspace';
import { DroneStatus } from './DroneStatus';
import { windDirectionForRule } from '../lib/windDirections';
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
  const potassiumMax = Math.max(...chartRows.map((row) => row.potassium ?? 0), settings.potassiumThreshold * 1.2, 0.1);
  const pm25Max = Math.max(...chartRows.map((row) => row.pm25 ?? 0), settings.pm25Threshold * 1.2, 1);
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
  const pathFor = (key: 'potassium' | 'pm25', max: number) => {
    let path = '';
    let previous = false;
    chartRows.forEach(row => {
      const value = row[key];
      if (value == null) { previous = false; return; }
      path += `${previous ? ' L' : ' M'}${xAt(dateValue(row.time)).toFixed(1)},${y(value, max).toFixed(1)}`;
      previous = true;
    });
    return path;
  };
  const labelIndexes = chartRows.length > 1 ? [0, Math.floor((chartRows.length - 1) / 2), chartRows.length - 1] : [0];
  const gridValues = [0, .25, .5, .75, 1];

  return <div className="monitor-chart" aria-label="小时监测趋势图">
    <div className="chart-header">
      <div className="chart-legend"><span className="legend-item"><i className="legend-bar potassium-line" />K⁺（μg/m³）</span><span className="legend-item"><i className="legend-line pm25-line" />PM2.5（μg/m³）</span></div>
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
      <title id="monitor-chart-title">钾离子和 PM2.5 小时趋势</title>
      <desc id="monitor-chart-desc">柱状图表示钾离子，超过阈值时标红；黄色折线表示右轴 PM2.5。悬停查看小时数据，也可使用左右方向键切换，按 Escape 关闭提示。</desc>
      {gridValues.map((ratio) => <g key={ratio}>
        <line x1={margin.left} x2={width - margin.right} y1={margin.top + plotHeight * (1 - ratio)} y2={margin.top + plotHeight * (1 - ratio)} className="chart-grid-line" />
        <text x={margin.left - 10} y={margin.top + plotHeight * (1 - ratio) + 4} textAnchor="end" className="chart-axis-label">{(potassiumMax * ratio).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</text>
        <text x={width - margin.right + 10} y={margin.top + plotHeight * (1 - ratio) + 4} className="chart-axis-label pm25-axis-label">{(pm25Max * ratio).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}</text>
      </g>)}
      {chartRows.map((row, index) => row.potassium != null && <rect key={row.time} x={x(index) - barWidth / 2} y={y(row.potassium, potassiumMax)} width={barWidth} height={Math.max(0, row.potassium / potassiumMax * plotHeight)} className={`potassium-bar ${settings.potassiumEnabled !== false && row.potassium > settings.potassiumThreshold ? 'exceeded-point' : 'potassium-point'}`} />)}
      <path d={pathFor('pm25', pm25Max)} className="chart-line pm25-stroke" />
      {chartRows.map((row) => row.pm25 != null && <circle key={`pm25-${row.time}`} cx={xAt(dateValue(row.time))} cy={y(row.pm25, pm25Max)} r={settings.pm25Enabled !== false && row.pm25 > settings.pm25Threshold ? 5 : 2.4} className={`chart-point ${settings.pm25Enabled !== false && row.pm25 > settings.pm25Threshold ? 'exceeded-point' : 'pm25-point'}`}><title>{`${row.time.slice(0, 16)} · PM2.5 ${format(row.pm25)} μg/m³`}</title></circle>)}
      {settings.potassiumEnabled !== false && <><line x1={margin.left} x2={width - margin.right} y1={y(settings.potassiumThreshold, potassiumMax)} y2={y(settings.potassiumThreshold, potassiumMax)} className="threshold-line" />
      <text x={margin.left + 8} y={y(settings.potassiumThreshold, potassiumMax) - 6} className="threshold-label">K⁺ 巡查阈值 {format(settings.potassiumThreshold)}</text></>}
      {labelIndexes.map((index) => <text key={index} x={x(index)} y={height - 14} textAnchor={index === 0 ? "start" : index === chartRows.length - 1 ? "end" : "middle"} className="chart-axis-label">{chartRows[index].time.slice(5, 13)}</text>)}
      <text x={margin.left - 10} y={margin.top - 8} textAnchor="end" className="chart-axis-unit">K⁺</text>
      <text x={width - margin.right + 10} y={margin.top - 8} className="chart-axis-unit pm25-axis-label">PM2.5</text>
      {Array.from({ length: hourCount }, (_, index) => <rect key={index} x={margin.left + index * slotWidth} y={margin.top} width={slotWidth} height={plotHeight} fill="transparent" onPointerMove={() => setActiveTime(first + index * 3600000)} onPointerDown={() => setActiveTime(first + index * 3600000)} />)}
      {showTooltip && <g className="chart-tooltip" role="tooltip" aria-live="polite">
        <line x1={xAt(activeTime!)} x2={xAt(activeTime!)} y1={margin.top} y2={margin.top + plotHeight} className="chart-hover-line" />
        <rect x={tooltipX} y={margin.top + 8} width={tooltipWidth} height={100} rx={6} className="chart-tooltip-box" />
        <text x={tooltipX + 12} y={margin.top + 29} className="chart-tooltip-time">{tooltipTime}</text>
        <text x={tooltipX + 12} y={margin.top + 45} className="chart-tooltip-status">{activeRow ? '北京时间' : '北京时间 · 该小时无记录'}</text>
        <text x={tooltipX + 12} y={margin.top + 68} className={activeRow?.potassium != null && settings.potassiumEnabled !== false && activeRow.potassium > settings.potassiumThreshold ? 'exceeded-point' : 'potassium-point'}>K⁺：{format(activeRow?.potassium)}{activeRow?.potassium != null ? ' μg/m³' : ''}</text>
        <text x={tooltipX + 12} y={margin.top + 87} className="pm25-axis-label">PM2.5：{format(activeRow?.pm25)}{activeRow?.pm25 != null ? ' μg/m³' : ''}</text>
      </g>}
    </svg>
    <p className="chart-note">柱状图表示 K⁺ 小时数据，虚线为巡查阈值；黄色折线使用右轴表示 PM2.5。暂无数据时留空。</p>
  </div>;
}

type Props = { data: MonitorView | null; busy: boolean; ready: boolean; flightReady?: boolean; started: boolean; action: (command: string, args?: Record<string, unknown>) => Promise<boolean>; onPrepare: () => void; onFlight: () => void; onSettings?: () => void; };
function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <svg className={`refresh-icon${spinning ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
    <path d="M3 4v5h5" />
    <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
    <path d="M21 20v-5h-5" />
  </svg>;
}
export function MonitoringPanel({ data, busy, ready, flightReady = ready, started, action, onPrepare, onFlight, onSettings = () => {} }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('chart');
  const [range, setRange] = useState<Range>(24);
  const trigger = triggerReading(data);
  const latest = trigger.latest;
  const latestPotassium = trigger.potassium;
  const latestPm25 = trigger.pm25;
  const quality = dataQuality(data);
  const settings = data?.settings ?? defaultSettings;
  const today = beijingDateKey(Date.now());
  const rows = (data?.rows || []).filter(row => {
    if (range === 'today') return row.time.slice(0, 10) === today;
    return !latest || dateValue(row.time) >= dateValue(latest.time) - (range - 1) * 3600000;
  });
  const { event: plan } = flightDisplay(data);
  const pending = isCurrentFlightEvent(plan);
  const syncRange = range === 'today' ? 'today' : String(range);
  const manualConfirmation = settings.requireManualConfirmation;
  const noFlyPeriods = settings.noFlyPeriods ?? [];
  const noFlySummary = noFlyPeriods.length
    ? noFlyPeriods.map(period => `${period.start}–${period.end}`).join('、')
    : '未设置禁飞时段';
  const executionValue = manualConfirmation ? '手动执行' : '自动执行';
  const executionDetail = manualConfirmation
    ? '计划填写完成后，由工作人员确认起飞'
    : `计划填写完成后，延迟 ${settings.takeoffDelayMinutes} 分钟自动提交`;
  const windRules = settings.windRouteRules ?? [];
  const hasWindRules = windRules.length > 0;
  const defaultRoute = data?.flight.selectedRoute;
  return <div className="monitoring-workspace">
    <div className={`page-heading monitoring-heading ${quality.tone}`}><div>
      <span className="eyebrow">泰州市 · 小时监测</span>
      <h2>最新监测数据</h2>
      <div className="heading-status">
        <strong>{quality.detail}</strong>
        <span>最近成功同步：{data?.lastSuccess || '尚未同步'}</span>
      </div>
    </div><div className="sync-action-row"><button className="icon-button" aria-label={data?.syncing ? '正在同步' : '立即同步'} title={data?.syncing ? '正在补齐数据' : '补齐当前时间范围'} disabled={!ready || busy || data?.syncing} onClick={() => void action('sync_monitoring', { range: syncRange })}><RefreshIcon spinning={data?.syncing} /></button></div></div>
    <div className="metric-grid">
      <article className={settings.potassiumEnabled !== false && (!trigger.potassiumValid || trigger.potassiumExceeded) ? 'metric-warning' : ''}><span>钾离子 K⁺ <small>μg/m³</small></span><strong>{format(latestPotassium?.potassium)}</strong><small>{settings.potassiumEnabled === false ? '未设置阈值 · 不参与触发' : !trigger.potassiumValid ? '暂无有效数据，不参与本次判断' : `巡查触发阈值 > ${format(settings.potassiumThreshold)}`}<br />{latestPotassium?.time.slice(0, 16) || '暂无数据'}（北京时间）</small></article>
      <article className={settings.pm25Enabled !== false && (!trigger.pm25Valid || trigger.pm25Exceeded) ? 'metric-warning' : ''}><span>PM2.5 <small>μg/m³</small></span><strong>{format(latestPm25?.pm25)}</strong><small>{settings.pm25Enabled === false ? '未设置阈值 · 不参与触发' : !trigger.pm25Valid ? '暂无有效数据，不参与本次判断' : `巡查触发阈值 > ${format(settings.pm25Threshold)}`}<br />{latestPm25?.time.slice(0, 16) || '暂无数据'}（北京时间）</small></article>
      <article className={`time-metric ${quality.tone === 'warning' ? 'metric-warning' : ''}`}><span>参与判断的最新数据时间</span><strong>{latest?.time.slice(0, 16) || '暂无数据'}</strong><small>{quality.label} · {latest ? '北京时间' : '等待首次读取'}</small></article>
    </div>
    {data?.error && <div className="notice warning" role="alert"><strong>最近一次同步未完成</strong><p>{data.error}</p>{!ready && <button className="text-button" onClick={onPrepare}>重新检查环境</button>}</div>}
    <section id="monitoring-task-details" className={`task-details ${pending ? 'task-callout' : 'data-card'}`} aria-label="巡查任务详情">
      <div className="task-panel-heading"><div><h3>巡查任务</h3><p>当前策略、触发条件和执行状态</p></div><button type="button" className="text-button monitoring-route-summary" onClick={onSettings} aria-label="去设置：巡查策略">去设置 →</button></div>
      <DroneStatus data={data} ready={flightReady} started={started} busy={busy} action={action} onFlight={onFlight} />
      <div className="task-policy-grid" role="table" aria-label="巡查策略">
        <div className="task-policy-row task-policy-header" role="row">
          <span role="columnheader">规则项</span>
          <span role="columnheader">当前值</span>
          <span role="columnheader">说明</span>
        </div>
        <div className={`task-policy-row task-route-row${!defaultRoute ? ' is-warning' : ''}`} role="row">
          <span className="task-policy-key" role="rowheader">航线设置</span>
          <div className="task-route-config" role="cell">
            <span className="task-route-default"><span>默认航线</span><strong>{defaultRoute || '尚未选择，请先设置'}</strong></span>
          </div>
          <div className="task-policy-detail task-route-detail" role="cell">
            <p>{hasWindRules ? '起飞前按司空预报风向匹配；缺少有效风向或该风向未配置航线时，使用默认航线。' : '未配置风向规则，起飞时直接使用默认航线。'}</p>
            {!defaultRoute && <p className="task-route-warning">请先同步并选择默认航线，完成后才能起飞。</p>}
            {hasWindRules && <details className="task-route-rules">
              <summary>查看风向规则（{windRules.length} 条）</summary>
              <dl>{windRules.map((rule, index) => <div key={index}>
                <dt>{windDirectionForRule(rule)?.label ?? `${rule.startDegrees}°–${rule.endDegrees}°`}</dt>
                <dd>{rule.route}</dd>
              </div>)}</dl>
            </details>}
          </div>
        </div>
        <div className={`task-policy-row ${manualConfirmation ? 'is-warning' : 'is-active'}`} role="row">
          <span className="task-policy-key" role="rowheader">起飞执行方式</span>
          <strong className="task-policy-value" role="cell">{executionValue}</strong>
          <small className="task-policy-detail" role="cell">{executionDetail}</small>
        </div>
        <div className="task-policy-row" role="row">
          <span className="task-policy-key" role="rowheader">触发条件</span>
          <strong className="task-policy-value" role="cell">{[settings.potassiumEnabled !== false ? `K⁺ > ${format(settings.potassiumThreshold)}` : '', settings.pm25Enabled !== false ? `PM2.5 > ${format(settings.pm25Threshold)}` : ''].filter(Boolean).join(' 或 ')} μg/m³</strong>
          <small className="task-policy-detail" role="cell">已配置指标分别取最新有效数据，任一项超标后填写巡查计划；后到数据会重新判断</small>
        </div>
        <div className="task-policy-row" role="row">
          <span className="task-policy-key" role="rowheader">天气用途</span>
          <strong className="task-policy-value" role="cell">记录天气与风向选线</strong>
          <small className="task-policy-detail" role="cell">是否允许起飞由大疆后台决定</small>
        </div>
        <div className="task-policy-row" role="row">
          <span className="task-policy-key" role="rowheader">禁飞时段</span>
          <strong className="task-policy-value" role="cell">{noFlySummary}</strong>
          <small className="task-policy-detail" role="cell">禁飞时段内仅记录，不发起起飞</small>
        </div>
      </div>
      <div className="task-policy-note"><span aria-hidden="true">i</span><p>{manualConfirmation ? '执行流程：已配置指标任一项超过阈值 → 填写巡查计划 → 工作人员确认 → 执行起飞。' : `执行流程：已配置指标任一项超过阈值 → 填写巡查计划 → 延迟 ${settings.takeoffDelayMinutes} 分钟 → 自动起飞。`} 天气用于任务记录和风向选线，是否允许起飞由大疆后台决定；禁飞时段不提交起飞请求。</p></div>
      {pending && plan && <div className="task-details-copy"><p>{plan.name} · {plan.observedAt.slice(0, 16)}（北京时间）</p>{plan.sourceHour && <p>绑定小时数据：{plan.sourceHour.slice(0, 16)}（北京时间）</p>}
        {plan.status === 'uncertain' && plan.error && <details><summary>查看原始回执</summary><p>{plan.error}</p></details>}
      </div>}
      {pending && plan && !plan.preview && ['ready', 'submitted', 'uncertain', 'flying', 'paused'].includes(plan.status) && <div className="task-details-copy" role="status">
        {plan.statusCheckedAt ? <p>最近核查：{new Date(plan.statusCheckedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间） · {plan.statusCheckError ? '核查未完成' : plan.status === 'uncertain' ? '已读取司空任务，起飞结果仍待核查' : '已更新任务状态'}</p> : <p>尚未取得司空状态核查结果。</p>}
        {plan.statusCheckError && <p>司空核查：{plan.statusCheckError}</p>}
        {plan.status === 'uncertain' && <p>手动刷新后，若司空仍未识别到任务状态，将保留历史记录并恢复起飞入口；再次起飞前请核对平台任务。</p>}
      </div>}
    </section>
    <section className="data-card"><div className="chart-toolbar"><h3>小时变化趋势</h3><div className="button-row"><RangePicker value={range} onChange={setRange} /><div className="view-switcher-buttons" role="group" aria-label="数据展示方式"><button className={viewMode === 'chart' ? 'active' : ''} aria-pressed={viewMode === 'chart'} onClick={() => setViewMode('chart')}>图表</button><button className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}>表格</button></div></div></div>
    {!rows.length ? <div className="empty-state"><h3>暂无数据</h3><p>环境就绪后将自动读取首批数据。</p><button className="secondary-button" onClick={onPrepare}>重新检查环境</button></div> : viewMode === 'chart' ? <MonitoringChart rows={rows} settings={settings} /> : <div className="hourly-table-wrap"><table className="hourly-table"><thead><tr><th>数据时间</th><th>K⁺（μg/m³）</th><th>PM2.5（μg/m³）</th></tr></thead><tbody>{rows.map(row => <tr key={row.time}><td>{row.time.slice(0,16)}</td><td className={row.potassium != null && settings.potassiumEnabled !== false && row.potassium > settings.potassiumThreshold ? 'missing-value' : ''}>{format(row.potassium)}</td><td>{format(row.pm25)}</td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
