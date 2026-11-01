import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RouteSelect } from './RouteSelect';
import { defaultSettings, type FlightRoute, type WindRouteRule, type WorkspaceSettings } from '../lib/workspace';
import { windDirections, windDirectionForRule } from '../lib/windDirections';
type RoutesView = { routes: FlightRoute[]; selected?: string | null; syncedAt?: number | null };

type Props = { settings: WorkspaceSettings; flightReady?: boolean; routes?: FlightRoute[]; selectedRoute?: string; routesSyncedAt?: number | null; onClose: () => void; onSaved: () => Promise<void>; onRoutesChanged?: () => Promise<void>; onDataCleared?: () => Promise<void> };
const analyses = ['火点', '工地', '裸土', '扬尘', '河道', '人为干扰'];

function RouteRefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <svg className={`refresh-icon${spinning ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
    <path d="M3 4v5h5" />
    <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
    <path d="M21 20v-5h-5" />
  </svg>;
}

export function SettingsDialog({ settings, flightReady = false, routes: availableRoutes = [], selectedRoute = '', routesSyncedAt = null, onClose, onSaved, onRoutesChanged, onDataCleared }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [potassium, setPotassium] = useState(settings.potassiumEnabled === false ? '' : Number.isInteger(settings.potassiumThreshold) ? settings.potassiumThreshold.toFixed(1) : String(settings.potassiumThreshold));
  const [pm25, setPm25] = useState(settings.pm25Enabled === false ? '' : String(settings.pm25Threshold));
  const [delay, setDelay] = useState(String(settings.takeoffDelayMinutes));
  const [manual, setManual] = useState(settings.requireManualConfirmation);
  const [periods, setPeriods] = useState((settings.noFlyPeriods ?? defaultSettings.noFlyPeriods ?? []).map(period => ({ ...period })));
  const [windRules, setWindRules] = useState<WindRouteRule[]>((settings.windRouteRules ?? []).map(rule => ({ ...rule })));
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState('');
  const [routes, setRoutes] = useState<RoutesView | null>(availableRoutes.length || selectedRoute ? { routes: availableRoutes, selected: selectedRoute || null, syncedAt: routesSyncedAt } : null);
  const [syncingRoutes, setSyncingRoutes] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [selectingRoute, setSelectingRoute] = useState(false);
  const busy = saving || clearing || syncingRoutes || selectingRoute;
  const [error, setError] = useState('');
  const lock = useRef(false);
  const clearData = async () => {
    if (lock.current) return;
    lock.current = true; setClearing(true); setError(''); setClearMessage('');
    try {
      await invoke<{ cleared: boolean }>('clear_all_data', { confirmed: true });
      setRoutes(null); setRouteError('');
      await onDataCleared?.();
      setConfirmClear(false); setClearMessage('本地数据已清空，客户端已恢复到首次安装状态。');
    } catch (reason) { setError(`清空失败：${String(reason)}`); }
    finally { lock.current = false; setClearing(false); }
  };
  const syncRoutes = async () => {
    if (lock.current || syncingRoutes) return;
    lock.current = true; setSyncingRoutes(true); setRouteError('');
    try { setRoutes(await invoke<RoutesView>('sync_flight_routes')); await onRoutesChanged?.(); }
    catch (reason) { setRouteError(`航线同步失败：${String(reason)}`); }
    finally { lock.current = false; setSyncingRoutes(false); }
  };
  const chooseRoute = async (route: string) => {
    if (!route || lock.current) return;
    lock.current = true; setSelectingRoute(true); setRouteError('');
    try { setRoutes(await invoke<RoutesView>('set_flight_route', { route })); await onRoutesChanged?.(); }
    catch (reason) { setRouteError(`航线选择失败：${String(reason)}`); }
    finally { lock.current = false; setSelectingRoute(false); }
  };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { opener?.focus(); };
  }, []);

  const reset = () => {
    setPotassium(defaultSettings.potassiumThreshold.toFixed(1));
    setPm25(String(defaultSettings.pm25Threshold));
    setDelay(String(defaultSettings.takeoffDelayMinutes));
    setManual(defaultSettings.requireManualConfirmation);
    setPeriods((defaultSettings.noFlyPeriods ?? []).map(period => ({ ...period })));
    setWindRules((defaultSettings.windRouteRules ?? []).map(rule => ({ ...rule })));
    setError('');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current) return;
    const next: WorkspaceSettings = { potassiumEnabled: !!potassium.trim(), pm25Enabled: !!pm25.trim(), potassiumThreshold: potassium.trim() ? Number(potassium) : settings.potassiumThreshold, pm25Threshold: pm25.trim() ? Number(pm25) : settings.pm25Threshold, takeoffDelayMinutes: manual && (!delay.trim() || !Number.isInteger(Number(delay)) || Number(delay) < 0 || Number(delay) > 1440) ? settings.takeoffDelayMinutes : Number(delay), requireManualConfirmation: manual, noFlyPeriods: periods, windRouteRules: windRules };
    if (!potassium.trim() && !pm25.trim()) {
      setError("请至少设置一个监测阈值。"); return;
    }
    if ( ![next.potassiumThreshold, next.pm25Threshold].every(value => Number.isFinite(value) && value > 0)) {
      setError('请输入大于 0 的有效浓度阈值。'); return;
    }
    if (!manual && (!delay.trim() || !Number.isInteger(next.takeoffDelayMinutes) || next.takeoffDelayMinutes < 0 || next.takeoffDelayMinutes > 1440)) {
      setError('起飞延迟须为 0 至 1440 之间的整数分钟。'); return;
    }
    if (periods.some(period => !/^([01]\d|2[0-3]):[0-5]\d$/.test(period.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(period.end) || period.start === period.end)) {
      setError('请填写有效的禁飞时间，开始与结束不能相同。'); return;
    }
    if (windRules.length > 0 && !routes?.routes.some(route => route.name === routes.selected)) {
      setError('配置风向规则前，请先同步航线并选择默认航线。'); return;
    }
    if (windRules.length > 8 || windRules.some(rule => !windDirectionForRule(rule) || !routes?.routes.some(route => route.name === rule.route))) {
      setError('请为每条规则选择一个中文风向和已同步的航线，最多配置八个方向。'); return;
    }
    if (new Set(windRules.map(rule => windDirectionForRule(rule)?.id)).size !== windRules.length) {
      setError('同一风向只能配置一条规则，请删除或修改重复风向。'); return;
    }
    lock.current = true; setSaving(true); setError('');
    try {
      await invoke('save_workspace_settings', { settings: next });
      await onSaved();
      onClose();
    } catch (reason) { setError(`保存失败：${String(reason)}`); }
    finally { lock.current = false; setSaving(false); }
  };

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => void submit(event)}>
      <header className="settings-header"><div><h2 id="settings-title">监测设置</h2><p>设置监测阈值与无人机巡查策略</p></div><button type="button" className="icon-button" aria-label="关闭设置" disabled={busy} onClick={onClose}>×</button></header>
      <div className="settings-body">
        <fieldset disabled={busy} className="settings-section"><legend>监测阈值</legend><div className="settings-fields">
          <label htmlFor="potassium-threshold">钾离子 K⁺ 阈值<div className="settings-input"><input autoFocus id="potassium-threshold" type="number" step="any" min="0.000001" placeholder="留空则不参与判断" value={potassium} onChange={event => setPotassium(event.target.value)} /><span>μg/m³</span></div></label>
          <label htmlFor="pm25-threshold">PM2.5 起飞触发阈值<div className="settings-input"><input id="pm25-threshold" type="number" step="any" min="0.000001" placeholder="留空则不参与判断" value={pm25} onChange={event => setPm25(event.target.value)} /><span>μg/m³</span></div></label>
        </div><p className="settings-help">至少填写一项阈值，留空的指标不参与判断。已设置的指标分别使用最新有效数据，任一项超过阈值时触发巡查计划填写，起飞按下方策略执行。此处 PM2.5 阈值仅用于监测预警与起飞触发，不影响报告统计。</p></fieldset>
        <fieldset disabled={busy} className="settings-section"><legend>无人机起飞策略</legend>
          <div className="settings-flight-controls">
          <div className="settings-radio-row"><div><strong id="manual-confirmation-label">起飞执行方式</strong><p id="manual-confirmation-help">请选择巡查计划的执行方式</p></div><div className="settings-radio-options" role="radiogroup" aria-labelledby="manual-confirmation-label" aria-describedby="manual-confirmation-help">
            <label className={`settings-radio-option${manual ? ' is-selected' : ''}`}><input type="radio" name="takeoff-execution-mode" value="manual" checked={manual} onChange={() => setManual(true)} /><span className="settings-radio-mark" aria-hidden="true" /><span><strong>手动执行</strong><small>由工作人员确认后起飞</small></span></label>
            <label className={`settings-radio-option${!manual ? ' is-selected' : ''}`}><input type="radio" name="takeoff-execution-mode" value="automatic" checked={!manual} onChange={() => setManual(false)} /><span className="settings-radio-mark" aria-hidden="true" /><span><strong>自动执行</strong><small>按延迟策略自动起飞</small></span></label>
          </div></div>
          {!manual && <div className="settings-delay"><div className="settings-delay-copy"><label htmlFor="takeoff-delay">超标后起飞延迟</label><p id="takeoff-delay-help">K⁺ 或 PM2.5 超标后计时；0 表示不延迟，最多 1440 分钟</p></div><div className="settings-input"><input id="takeoff-delay" type="number" min="0" max="1440" step="1" required aria-describedby="takeoff-delay-help" value={delay} onChange={event => setDelay(event.target.value)} /><span>分钟</span></div></div>}
          <p className="notice settings-flight-note">K⁺ 或 PM2.5 超过阈值后自动创建巡查计划；{manual ? '由工作人员确认后起飞。' : '等待设定延迟结束后自动起飞。'}</p>
          </div>
        </fieldset>
        <fieldset disabled={busy} className="settings-section settings-route-section"><legend>巡查航线</legend>
          <p className="settings-help settings-route-intro">从司空泰州项目同步航线列表；按所选航线名称精确匹配优先；前缀匹配选择差异最小的一条，差异并列时请重新选择。</p>
          <div className="settings-route-row"><label htmlFor="flight-route">默认航线<RouteSelect id="flight-route" label="默认航线" value={routes?.selected ?? ''} routes={routes?.routes ?? []} placeholder={routes?.routes.length ? '请选择航线' : '请先同步航线列表'} disabled={busy} onValueChange={route => void chooseRoute(route)} /></label><button type="button" className="icon-button settings-route-sync" aria-label={syncingRoutes ? '正在同步航线' : '同步司空航线'} title={syncingRoutes ? '正在同步航线' : '同步司空航线'} disabled={!flightReady || busy} onClick={() => void syncRoutes()}><RouteRefreshIcon spinning={syncingRoutes} /></button></div>
          {routes?.selected && <p className="settings-help">已选：{routes.selected}{routes.syncedAt ? ` · 同步于 ${new Date(routes.syncedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : ''}</p>}
          <div className="wind-route-config">
            <p className="settings-help">风向规则（可选）优先于默认航线。按司空预报风向（风从哪里来）匹配八个方向，交界处归入顺时针一侧。未配置规则、该风向未配置航线，或预报风向缺测、过期、无效时，均使用默认航线。起飞前仍需通过天气复核。</p>
            {windRules.some(rule => !windDirectionForRule(rule)) && <p className="notice warning" role="status">存在旧版自定义角度规则，请重新选择中文风向后保存；保存前原规则保持不变。</p>}
            <div className="wind-route-rules">{windRules.map((rule, index) => <div className="wind-route-rule" key={index}>
              <label>预报风向<select aria-label={`第 ${index + 1} 条风向规则风向`} value={windDirectionForRule(rule)?.id ?? ''} onChange={event => {
                const direction = windDirections.find(item => item.id === event.target.value);
                if (direction) setWindRules(current => current.map((item, i) => i === index ? { startDegrees: direction.startDegrees, endDegrees: direction.endDegrees, route: item.route } : item));
              }}>
                {!windDirectionForRule(rule) && <option value="" disabled>请选择风向</option>}
                {windDirections.map(direction => <option key={direction.id} value={direction.id} disabled={windRules.some((other, i) => i !== index && windDirectionForRule(other)?.id === direction.id)}>{direction.label}</option>)}
              </select></label>
              <label className="wind-route-rule-route" htmlFor={`wind-route-${index}`}>匹配航线<RouteSelect id={`wind-route-${index}`} label={`第 ${index + 1} 条风向规则航线`} value={rule.route} routes={routes?.routes ?? []} placeholder={routes?.routes.length ? '请选择航线' : '请先同步航线列表'} disabled={busy} onValueChange={route => setWindRules(current => current.map((item, i) => i === index ? { ...item, route } : item))} /></label>
              <button type="button" className="text-button" aria-label={`删除第 ${index + 1} 条风向规则`} onClick={() => setWindRules(current => current.filter((_, i) => i !== index))}>删除</button>
            </div>)}</div>
            {!windRules.length && <p className="settings-help">尚未配置风向规则，将直接使用默认航线。</p>}
            <button type="button" className="secondary-button wind-route-add" disabled={windRules.length >= 8} onClick={() => setWindRules(current => {
              const direction = windDirections.find(item => !current.some(rule => windDirectionForRule(rule)?.id === item.id));
              return direction ? [...current, { startDegrees: direction.startDegrees, endDegrees: direction.endDegrees, route: routes?.routes[0]?.name ?? '' }] : current;
            })}>＋ 添加风向规则</button>
          </div>

          {routeError && <p className="notice warning settings-route-error" role="alert">{routeError}</p>}
        </fieldset>
        <fieldset disabled={busy} className="settings-section"><legend>禁飞时间（北京时间）</legend>
          <p className="settings-help no-fly-help">每天按这些时段执行，超标仅记录原因，不发起起飞；平台已有定时任务不受影响。包含开始时间，不包含结束时间；结束早于开始时跨午夜。</p>
          <div className="no-fly-periods">{periods.map((period, index) => <div className="no-fly-period" key={index}>
            <label>开始时间<input type="time" required aria-label={`第 ${index + 1} 段禁飞开始时间`} value={period.start} onChange={event => setPeriods(current => current.map((p, i) => i === index ? { ...p, start: event.target.value } : p))} /></label><span className="no-fly-separator">至</span>
            <label>结束时间<input type="time" required aria-label={`第 ${index + 1} 段禁飞结束时间`} value={period.end} onChange={event => setPeriods(current => current.map((p, i) => i === index ? { ...p, end: event.target.value } : p))} /></label>
            <button type="button" className="text-button" aria-label={`删除第 ${index + 1} 段禁飞时间`} onClick={() => setPeriods(current => current.filter((_, i) => i !== index))}>删除</button>
          </div>)}</div>
          {!periods.length && <p className="settings-help">未配置禁飞时间。</p>}
          <button type="button" className="secondary-button no-fly-add" disabled={periods.length >= 24} onClick={() => setPeriods(current => [...current, { start: '12:00', end: '13:00' }])}>＋ 添加时段</button>
        </fieldset>
        <fieldset className="settings-section"><legend>AI 巡查分析</legend><div className="analysis-switches">{analyses.map(name => <div key={name} className="analysis-switch-row"><span>{name}巡查分析</span><button type="button" role="switch" aria-label={`${name}巡查分析`} aria-checked={name === '火点'} disabled className="settings-switch"><span /></button></div>)}</div></fieldset>
        <fieldset disabled={busy} className="settings-section"><legend>数据管理</legend>
          <div className="task-clear-content">
          <p className="settings-help">清空本机数据库、运行日志、报告和同步下载文件，恢复到首次安装状态。</p>
          {confirmClear ? <div className="notice warning task-clear-confirm" role="group" aria-labelledby="task-clear-title">
            <strong id="task-clear-title">确认清空全部本地数据？</strong>
            <p>将清空监测数据库（含设置、任务、小时数据和同步进度）、运行日志、已生成报告及同步下载文件。应用程序和浏览器插件不会删除；清空后无法恢复；有未结束或待核查任务，或正在同步、采集、保存报告时，不能清空。</p>
            <div className="task-clear-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setConfirmClear(false)}>暂不清空</button><button type="button" className="secondary-button task-clear-button" onClick={() => void clearData()}>{clearing ? '正在清空…' : '确认清空数据'}</button></div>
          </div> : <button type="button" className="secondary-button task-clear-button" onClick={() => { setConfirmClear(true); setClearMessage(''); setError(''); }}>清空数据</button>}
          {clearMessage && <p className="notice success" role="status">{clearMessage}</p>}
          </div>
        </fieldset>
        {error && <p className="notice warning" role="alert">{error}</p>}
      </div>
      <footer className="settings-footer"><button type="button" className="text-button" disabled={busy} onClick={reset}>恢复默认</button><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{saving ? '正在保存…' : '保存设置'}</button></footer>
    </form>
  </dialog>;
}
