import { useEffect, useId, useRef, useState } from 'react';
import { weatherPasses, weatherText, type WeatherView } from '../lib/weather';
type WeatherProps = { weather?: WeatherView; busy: boolean; onRefresh: () => void };
const number = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const time = (n: number | undefined) => n == null ? '尚未获取' : new Date(n * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export function WeatherStatus(props: WeatherProps) {
  const { weather } = props;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const allowed = weatherPasses(weather);
  const label = weather?.allowed && !allowed ? '天气已过期' : weather?.label || '暂无法判断';
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div ref={root} className={`weather-status ${allowed ? 'weather-ok' : 'weather-blocked'}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} className="weather-status-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span className="weather-status-heading"><strong>机场天气</strong><span className="weather-status-condition">{weatherText(weather?.current?.weatherCode)} · {number(weather?.current?.temperature)} °C</span></span>
      <span className="weather-status-summary"><span className={`weather-status-label ${allowed ? 'is-safe' : ''}`}>{label}</span><span>风 {number(weather?.current?.windSpeed)} m/s</span></span>
    </button>
    <div id={id} className="weather-popover" hidden={!open}><WeatherPanel {...props} /></div>
  </div>;
}
export function WeatherPanel({ weather, busy, onRefresh }: WeatherProps) {
  const s = weather?.current, allowed = weatherPasses(weather);
  const expired = weather?.allowed && !allowed;
  const refreshing = !!weather?.refreshing;
  const dir = s?.windDirection == null ? '' : ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(s.windDirection / 45) % 8];
  return <section className={`weather-card ${allowed ? 'weather-ok' : 'weather-blocked'}`} aria-label="机场天气与飞行条件">
    <div className="section-heading"><h3>机场天气</h3><span className={`badge ${allowed ? 'success' : 'warning'}`}>{expired ? '天气已过期' : weather?.label || '暂无法判断'}</span></div>
    <div className="weather-overview">
      <p>{weatherText(s?.weatherCode)} · {number(s?.temperature)} °C</p>
      <div className="weather-refresh"><span>更新时间：{time(s?.fetchedAt)}<small>（北京时间）</small></span><button className="icon-button" disabled={busy || refreshing} onClick={onRefresh} aria-label={refreshing ? '更新天气中' : '刷新天气'} title={refreshing ? '更新天气中' : '刷新天气'} aria-busy={refreshing}>
        <svg className={`refresh-icon${refreshing ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3.9L3 9M3 4v5h5M4 13a8 8 0 0 0 14.9 3.9L21 15M21 20v-5h-5" /></svg>
      </button></div>
    </div>
    <div className="weather-metrics"><span>降水 <strong>{number(s?.precipitation)} <small>mm</small></strong></span><span>{dir}风 <strong>{number(s?.windSpeed)} <small>m/s</small></strong></span><span>阵风 <strong>{number(s?.windGusts)} <small>m/s</small></strong></span></div>
    <p className="weather-decision" role="status">{expired ? '天气数据已过期，请刷新；暂不准备巡查计划。' : weather?.reasons.join(' ') || '正在获取机场天气，暂不准备巡查计划。'}</p>
    <div className="weather-details"><h4>数据时间与判断规则</h4><p>数据时刻：{time(s?.observedAt)}（北京时间）</p><p>位置：{weather?.longitude ?? 119.92992}° E，{weather?.latitude ?? 32.434525}° N · <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> 模型天气 · 每 5 分钟更新</p><p>无降水且风速、阵风均 ≤ 6 m/s 时通过；超过 6 m/s 暂停并复核，超过 10 m/s 不宜起飞。有雾、雨雪、雷暴或数据缺失/过期时不通过。降水为当前时段累计量。</p><p>模型天气不替代机场现场检查；实际起飞仍需确认现场天气及设备状态。</p></div>
  </section>;
}
