import { useEffect, useId, useRef, useState } from 'react';
import { weatherPasses, currentWeatherText, rainfallText, type WeatherView } from '../lib/weather';
type WeatherProps = { weather?: WeatherView; busy: boolean; onRefresh: () => void };
const number = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const time = (n: number | undefined) => n == null ? '尚未获取' : new Date(n * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
// Presentation follows the platform verdict and item levels; it does not infer wind thresholds.
function weatherPresentation(weather: WeatherView | undefined) {
  const allowed = weatherPasses(weather);
  if (weather?.refreshing) return { allowed: false, label: weather.current ? '正在更新天气' : '正在获取天气', reasons: ['正在向司空获取最新天气和适飞结论，请稍候。'] };
  if (!weather?.current || weather.level === 'unknown') return { allowed: false, label: '暂无法判断', reasons: weather?.reasons.length ? weather.reasons : ['等待司空气象数据和适飞结论。'] };
  const now = Date.now() / 1000, sample = weather.current;
  if (now - sample.observedAt < -60 || now - sample.observedAt > 600 || now - sample.fetchedAt < 0 || now - sample.fetchedAt > 600) {
    return { allowed: false, label: '天气已过期', reasons: ['天气数据已过期，请刷新。'] };
  }
  const ranked = [...(sample.items ?? [])].filter(item => item.level > 1).sort((a, b) => b.level - a.level).map(item => `${item.label}：${item.value}`);
  const reasons = [...new Set([...ranked, ...weather.reasons])];
  return { allowed, label: weather.label || '暂无法判断', reasons: reasons.length ? reasons : ['司空未提供具体判定原因，请刷新。'] };
}
export function WeatherStatus(props: WeatherProps) {
  const { weather } = props;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { allowed, label, reasons } = weatherPresentation(weather);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div ref={root} className={`weather-status ${allowed ? 'weather-ok' : 'weather-blocked'}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} className="weather-status-trigger" title={reasons.join(' ')} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span className="weather-status-heading"><strong>机场天气</strong><span className={`weather-status-label ${allowed ? 'is-safe' : ''}`}>{label}</span><span className="weather-status-chevron" aria-hidden="true">⌄</span></span>
      <span className="weather-status-summary">{allowed
        ? <span>{currentWeatherText(weather?.current)} · {number(weather?.current?.forecast?.temperature ?? weather?.current?.temperature)} °C · 实测风速 {number(weather?.current?.windSpeed)} m/s</span>
        : <><span className="weather-status-reason">{reasons[0]}</span>{reasons.length > 1 && <span className="weather-status-more">另 {reasons.length - 1} 项</span>}</>}</span>
    </button>
    <div id={id} className="weather-popover" hidden={!open}><WeatherPanel {...props} /></div>
  </div>;
}
export function WeatherPanel({ weather, busy, onRefresh }: WeatherProps) {
  const s = weather?.current;
  const { allowed, label, reasons } = weatherPresentation(weather);
  const refreshing = !!weather?.refreshing;
  return <section className={`weather-card ${allowed ? 'weather-ok' : 'weather-blocked'}`} aria-label="机场天气与飞行条件">
    <div className="section-heading"><h3>机场天气</h3><span className={`badge ${allowed ? 'success' : 'warning'}`}>{label}</span></div>
    <div className="weather-decision" role="status"><strong>{allowed ? '适飞判定' : '判定说明'}</strong><ul>{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>
    <div className="weather-overview">
      <p>{currentWeatherText(s)} · {number(s?.forecast?.temperature ?? s?.temperature)} °C{s?.forecast ? '（司空预报）' : ''}</p>
      <div className="weather-refresh"><span>更新时间：{time(s?.fetchedAt)}<small>（北京时间）</small></span><button className="icon-button" disabled={busy || refreshing} onClick={onRefresh} aria-label={refreshing ? '更新天气中' : '刷新天气'} title={refreshing ? '更新天气中' : '刷新天气'} aria-busy={refreshing}>
        <svg className={`refresh-icon${refreshing ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3.9L3 9M3 4v5h5M4 13a8 8 0 0 0 14.9 3.9L21 15M21 20v-5h-5" /></svg>
      </button></div>
    </div>
    <section className="weather-metric-group" aria-label="机场实测"><h4>机场实测</h4>
      <div className="weather-metrics"><span className={(s?.items?.find(item => item.key === 'windSpeed')?.level ?? 1) > 1 ? 'weather-metric-alert' : undefined}>机场实测风速 <strong>{number(s?.windSpeed)} <small>m/s</small></strong></span><span className={(s?.items?.find(item => item.key === 'rainfall')?.level ?? 1) > 1 ? 'weather-metric-alert' : undefined}>机场实测降雨 <strong>{rainfallText(s)}</strong></span><span>机场实测气温 <strong>{number(s?.temperature)} <small>°C</small></strong></span></div>
    </section>
    {s?.items?.some(item => item.key.endsWith('Online')) ? <section className="weather-metric-group" aria-label="司空预报"><h4>司空预报</h4><div className="weather-metrics">{s.items.filter(item => item.key.endsWith('Online')).map(item => <span key={item.key} className={item.level > 1 ? 'weather-metric-alert' : undefined}>{item.label}<strong>{item.value}</strong>{item.level > 1 && <small className="weather-metric-verdict">{item.level === 3 ? '无法飞行' : '不宜飞行'}</small>}</span>)}</div></section> : null}
    <div className="weather-details"><h4>数据来源</h4><p>机场实测时刻：{time(s?.observedAt)}（北京时间）</p><p>预报时刻：{time(s?.forecast?.observedAt)}（北京时间）</p><p>位置：{weather?.longitude ?? 119.929701}° E，{weather?.latitude ?? 32.434676}° N · <a href="https://fh.dji.com/" target="_blank" rel="noreferrer">大疆司空 2</a> · 每 5 分钟更新</p><p>适飞结论采用司空当前项目的天气判定。请保持 Chrome 已登录司空；登录失效或数据过期时需重新获取。</p><p>实际起飞仍需确认现场天气及设备状态。</p></div>
  </section>;
}
