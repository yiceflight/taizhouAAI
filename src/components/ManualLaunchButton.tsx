import { useEffect, useId, useRef, useState } from 'react';
import { hourTime, noFlyPeriod, triggerReading, type MonitorView } from '../lib/workspace';
import { weatherPasses, currentWeatherText, rainfallText } from '../lib/weather';

type Props = {
  data: MonitorView | null;
  ready: boolean;
  started: boolean;
  busy: boolean;
  action: (command: string, args?: Record<string, unknown>) => Promise<boolean>;
  className: string;
};
const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '暂无数据' : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
const time = (value: number | undefined) => value == null ? '尚未获取' : new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function ManualLaunchButton({ data, ready, started, busy, action, className }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [weatherOverrideConfirmed, setWeatherOverrideConfirmed] = useState(false);
  const [retryEventId, setRetryEventId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(timer); trigger.current?.focus(); };
  }, [open]);

  const event = data?.flight.event;
  const retry = event?.status === 'failed' ? event : null;
  const active = !!event && !['dismissed', 'canceled', 'completed', 'failed', 'restricted', 'not_flown'].includes(event.status);
  const restricted = noFlyPeriod(data?.settings, open ? now : Date.now());
  const allowed = weatherPasses(data?.weather);
  const weatherUnavailable = (() => {
    const sample = data?.weather?.current;
    if (!sample || data?.weather?.level === 'unknown') return true;
    const current = Date.now() / 1000;
    return current - sample.observedAt < -60 || current - sample.observedAt > 600 || current - sample.fetchedAt < 0 || current - sample.fetchedAt > 600;
  })();
  const windRouteMode = data?.settings.routeSelectionMode === 'wind';
  const routeMissing = windRouteMode
    ? !data?.flight.routes?.length || !data?.settings.windRouteRules?.length
    : !data?.flight.selectedRoute;
  const blocked = !data || !ready || !started || busy || active || !!restricted || routeMissing || weatherUnavailable;
  const intentChanged = open && retryEventId !== (retry?.id ?? null);
  const confirmBlocked = blocked || intentChanged || (!allowed && !weatherOverrideConfirmed);
  const reading = triggerReading(data, open ? now : Date.now());
  const sample = data?.weather?.current;
  const potassiumState = reading.valid ? reading.potassiumExceeded ? '已超过预警阈值' : reading.latest?.potassium == null ? '钾离子缺测' : '未超过预警阈值'
    : !reading.latest || reading.latest.potassium == null ? '钾离子缺测，无法判断是否超标'
    : !Number.isFinite(reading.latest.potassium) ? '钾离子数值异常，无法判断是否超标'
    : now - hourTime(reading.latest.time) > 3 * 3600000 ? '钾离子数据已过期，无法判断是否超标'
    : '钾离子数据时间异常，无法判断是否超标';
  const pm25State = reading.valid ? reading.pm25Exceeded ? '已超过预警阈值' : reading.latest?.pm25 == null ? 'PM2.5 缺测' : '未超过预警阈值' : '无法判断是否超标';
  const triggerLabel = reading.potassiumExceeded && reading.pm25Exceeded ? 'K⁺ 与 PM2.5' : reading.potassiumExceeded ? '钾离子' : reading.pm25Exceeded ? 'PM2.5' : '监测数据';
  const blockedReason = !data || !ready || !started ? '浏览器或网站尚未就绪，暂不可执行任务。'
    : routeMissing ? windRouteMode ? '请先在监测设置中同步航线并配置风向规则。' : '请先在监测设置中同步并手动选择巡查航线。'
    : restricted ? `禁飞时间 ${restricted.start}–${restricted.end}（北京时间），不执行起飞。`
    : weatherUnavailable ? '气象数据不可用或已过期，请先刷新天气后再执行。'
    : active ? '已有巡查任务，请先查看当前任务。'
    : intentChanged ? '原任务已变化，请关闭后重新确认。'
    : !allowed && !weatherOverrideConfirmed ? '天气条件未通过或数据已过期；强制起飞需先完成现场复核并勾选确认。'
    : busy ? '正在处理其他操作，请稍候。' : '';

  const launch = async () => {
    if (lock.current || confirmBlocked) return;
    const override = !weatherPasses(data?.weather);
    if (override && (!open || !weatherOverrideConfirmed)) return;
    lock.current = true; setSubmitting(true); setError('');
    try {
      const args: Record<string, unknown> = {};
      if (retry) args.retryEventId = retry.id;
      if (override) args.weatherOverrideConfirmed = true;
      if (await (Object.keys(args).length ? action('launch_flight', args) : action('launch_flight'))) setOpen(false);
      else setError('巡查任务未能发起，请核查当前状态后重试。');
    } catch { setError('巡查任务未能发起，请核查当前状态后重试。'); }
    finally { lock.current = false; setSubmitting(false); }
  };
  const requestLaunch = () => {
    if (blocked || lock.current) return;
    if (!retry && weatherPasses(data?.weather) && triggerReading(data).exceeded) void launch();
    else { setError(''); setWeatherOverrideConfirmed(false); setRetryEventId(retry?.id ?? null); setNow(Date.now()); setOpen(true); }
  };
  const close = () => { if (!lock.current) setOpen(false); };

  return <>
    <button ref={trigger} className={className} disabled={blocked || submitting} title={restricted || weatherUnavailable ? blockedReason : undefined} aria-haspopup={!retry && allowed && reading.exceeded ? undefined : 'dialog'} onClick={requestLaunch}>{restricted ? '禁飞时间 · 不执行起飞' : weatherUnavailable && ready && started ? '天气数据不可用' : !allowed && ready && started ? '手动强制起飞' : retry ? '重新发起任务' : '立即执行任务'}</button>
    {open && <dialog ref={dialog} className="settings-dialog manual-launch-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); close(); }}>
      <header className="settings-header"><div><h2 id={`${id}-title`}>{!allowed ? '确认手动强制起飞' : retry ? '确认重新发起任务' : '确认执行任务'}</h2><p id={`${id}-description`}>{retry ? '原任务未发送起飞请求；确认后将创建新的手动任务，保留原失败记录，无需先归档。' : reading.valid ? reading.exceeded ? `当前${triggerLabel}已超标，请核对最新情况后确认。` : '当前钾离子未超标，仍要立即执行巡查任务吗？' : '当前无有效监测预警判断，请核对数据后确认。'}</p></div></header>
      <div className="manual-launch-body">
        {retry && <p className="notice warning">原任务回执（具体原因需人工核验）：{retry.error || '未获取到具体回执，请先核验设备与平台任务。'}</p>}
        <section aria-label="当前机场天气"><div className="section-heading"><h3>当前机场天气</h3><span className={`badge ${allowed ? 'success' : 'warning'}`}>{allowed ? '天气条件通过' : '天气条件未通过'}</span></div>
          <p className="manual-launch-weather">{currentWeatherText(sample)} · {number(sample?.forecast?.temperature ?? sample?.temperature)} °C{sample?.forecast ? '（司空预报）' : ''}</p>
          <dl className="manual-launch-metrics"><div><dt>风速</dt><dd>{number(sample?.windSpeed)} m/s</dd></div><div><dt>机场降雨</dt><dd>{rainfallText(sample)}</dd></div><div><dt>预报湿度</dt><dd>{number(sample?.forecast?.humidity)} %</dd></div></dl>
          {!!data?.weather?.reasons.length && <p className="capture-help">{data.weather.reasons.join(' ')}</p>}
          <p className="capture-help">天气时刻：{time(sample?.observedAt)}（北京时间）</p>
        </section>
        <section aria-label="当前钾离子情况"><div className="section-heading"><h3>钾离子 K⁺</h3><span className={`badge ${reading.valid && !reading.potassiumExceeded ? 'success' : 'warning'}`}>{reading.valid ? reading.potassiumExceeded ? '已超标' : '未超标' : '无法判断'}</span></div>
          <dl className="manual-launch-metrics"><div><dt>最新浓度</dt><dd>{number(reading.latest?.potassium)}{reading.latest?.potassium != null && Number.isFinite(reading.latest.potassium) ? ' μg/m³' : ''}</dd></div><div><dt>预警阈值</dt><dd>&gt; {number(reading.potassiumThreshold)} μg/m³</dd></div></dl>
          <p className="capture-help">{potassiumState}</p>
          <dl className="manual-launch-metrics"><div><dt>PM2.5</dt><dd>{number(reading.latest?.pm25)}{reading.latest?.pm25 != null && Number.isFinite(reading.latest.pm25) ? ' μg/m³' : ''}</dd></div><div><dt>预警阈值</dt><dd>&gt; {number(reading.pm25Threshold)} μg/m³</dd></div></dl>
          <p className="capture-help">{pm25State}</p><p className="capture-help">数据时间：{reading.latest?.time ?? '尚未获取'}（北京时间）</p>
        </section>
        <p className="capture-help">任务从无人机巡飞开始，返航后还需核对监测数据和照片，生成巡飞报告。执行前请确认现场天气及设备状态。</p>
        {!allowed && <div className="notice warning"><p>本次将覆盖系统天气拦截，仅对这次手动任务生效，后续自动任务仍检查天气。计划提交后如司空出现阻飞提醒，请到司空页面自行确认。</p><label className="manual-launch-override"><input type="checkbox" checked={weatherOverrideConfirmed} disabled={submitting} onChange={event => setWeatherOverrideConfirmed(event.target.checked)} />我已完成机场现场天气及设备复核，确认本次手动起飞覆盖系统天气拦截。</label></div>}
        {(blockedReason || error) && <p className="notice warning" role="alert">{blockedReason || error}</p>}
      </div>
      <footer className="settings-footer"><button type="button" className="secondary-button" autoFocus disabled={submitting} onClick={close}>取消</button><button type="button" className="primary-button" disabled={confirmBlocked || submitting} onClick={() => void launch()}>{submitting ? '正在发起…' : !allowed ? '确认强制起飞' : '确认执行任务'}</button></footer>
    </dialog>}
  </>;
}
