import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { defaultSettings, type WorkspaceSettings } from '../lib/workspace';

type Props = { settings: WorkspaceSettings; flightEnabled?: boolean; canEnableFlight?: boolean; onClose: () => void; onSaved: () => Promise<void>; onTasksCleared?: () => Promise<void> };
const analyses = ['火点', '工地', '裸土', '扬尘', '河道', '人为干扰'];

export function SettingsDialog({ settings, flightEnabled = false, canEnableFlight = false, onClose, onSaved, onTasksCleared }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [potassium, setPotassium] = useState(Number.isInteger(settings.potassiumThreshold) ? settings.potassiumThreshold.toFixed(1) : String(settings.potassiumThreshold));
  const [pm25, setPm25] = useState(String(settings.pm25Threshold));
  const [delay, setDelay] = useState(String(settings.takeoffDelayMinutes));
  const [manual, setManual] = useState(settings.requireManualConfirmation);
  const [automatic, setAutomatic] = useState(flightEnabled);
  const [periods, setPeriods] = useState((settings.noFlyPeriods ?? defaultSettings.noFlyPeriods ?? []).map(period => ({ ...period })));
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState('');
  const busy = saving || clearing;
  const [error, setError] = useState('');
  const lock = useRef(false);
  const clearTasks = async () => {
    if (lock.current) return;
    lock.current = true; setClearing(true); setError(''); setClearMessage('');
    try {
      const result = await invoke<{ preservedCurrentTask: boolean }>('clear_task_list', { confirmed: true });
      await onTasksCleared?.();
      setConfirmClear(false); setClearMessage(result.preservedCurrentTask ? '历史任务已清空。当前正在执行或待核查的任务已保留，请继续处理。' : '任务列表已清空。后续新任务会正常显示。');
    } catch (reason) { setError(`清空失败：${String(reason)}`); }
    finally { lock.current = false; setClearing(false); }
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
    setAutomatic(false);
    setPeriods((defaultSettings.noFlyPeriods ?? []).map(period => ({ ...period })));
    setError('');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current) return;
    const next: WorkspaceSettings = { potassiumThreshold: Number(potassium), pm25Threshold: Number(pm25), takeoffDelayMinutes: manual && (!delay.trim() || !Number.isInteger(Number(delay)) || Number(delay) < 0 || Number(delay) > 1440) ? settings.takeoffDelayMinutes : Number(delay), requireManualConfirmation: manual, noFlyPeriods: periods };
    if (!potassium.trim() || !pm25.trim() || ![next.potassiumThreshold, next.pm25Threshold].every(value => Number.isFinite(value) && value > 0)) {
      setError('请输入大于 0 的有效浓度阈值。'); return;
    }
    if (!manual && (!delay.trim() || !Number.isInteger(next.takeoffDelayMinutes) || next.takeoffDelayMinutes < 0 || next.takeoffDelayMinutes > 1440)) {
      setError('起飞延迟须为 0 至 1440 之间的整数分钟。'); return;
    }
    if (periods.some(period => !/^([01]\d|2[0-3]):[0-5]\d$/.test(period.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(period.end) || period.start === period.end)) {
      setError('请填写有效的禁飞时间，开始与结束不能相同。'); return;
    }
    lock.current = true; setSaving(true); setError('');
    try {
      if (!automatic && flightEnabled) await invoke('set_flight_enabled', { enabled: false });
      await invoke('save_workspace_settings', { settings: next });
      if (automatic && !flightEnabled) await invoke('set_flight_enabled', { enabled: true });
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
          <label htmlFor="potassium-threshold">钾离子 K⁺ 阈值<div className="settings-input"><input autoFocus id="potassium-threshold" type="number" step="any" min="0.000001" required value={potassium} onChange={event => setPotassium(event.target.value)} /><span>μg/m³</span></div></label>
        </div><p className="settings-help">钾离子超过阈值时触发巡查计划填写。</p></fieldset>
        <fieldset disabled={busy} className="settings-section"><legend>无人机起飞策略</legend>
          <div className="settings-flight-controls">
          <div className="settings-switch-row"><div><strong id="automatic-patrol-label">超标自动巡查</strong><p id="automatic-patrol-help">{automatic ? '开启：有效 K⁺ 超标且运行条件通过时创建巡查任务' : '关闭：超标仅提示，需点击立即执行任务'}</p></div><button type="button" role="switch" aria-checked={automatic} aria-labelledby="automatic-patrol-label" aria-describedby="automatic-patrol-help" className="settings-switch" disabled={!canEnableFlight && !automatic} onClick={() => setAutomatic(value => !value)}><span /></button></div>
          {!canEnableFlight && !automatic && <p className="settings-help">完成工作准备后可开启自动巡查。</p>}
          <div className="settings-switch-row"><div><strong id="manual-confirmation-label">起飞前人工确认</strong><p id="manual-confirmation-help">{manual ? '开启：由工作人员确认后起飞' : '关闭：按策略自动执行起飞'}</p></div><button type="button" role="switch" aria-checked={manual} aria-labelledby="manual-confirmation-label" aria-describedby="manual-confirmation-help" className="settings-switch" onClick={() => setManual(value => !value)}><span /></button></div>
          {!manual && <div className="settings-delay"><div className="settings-delay-copy"><label htmlFor="takeoff-delay">钾离子超标后延迟</label><p id="takeoff-delay-help">0 表示不延迟，最多 1440 分钟</p></div><div className="settings-input"><input id="takeoff-delay" type="number" min="0" max="1440" step="1" required aria-describedby="takeoff-delay-help" value={delay} onChange={event => setDelay(event.target.value)} /><span>分钟</span></div></div>}
          <p className="notice settings-flight-note">{!automatic ? '自动巡查尚未开启，以下起飞策略在开启后生效。' : manual ? '钾离子超标后直接填写计划，等待人工确认起飞。' : '钾离子超标后开始计时，延迟结束后自动起飞。延迟调整用于后续新任务。'}</p>
          </div>
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
        <fieldset disabled={busy} className="settings-section"><legend>报告阈值设置</legend><div className="settings-fields">
          <label htmlFor="pm25-threshold">PM2.5 报告阈值<div className="settings-input"><input id="pm25-threshold" type="number" step="any" min="0.000001" required value={pm25} onChange={event => setPm25(event.target.value)} /><span>μg/m³</span></div></label>
        </div><p className="settings-help">用于巡飞报告中可飞 PM2.5 数据的阈值判定。</p></fieldset>
        <fieldset className="settings-section"><legend>AI 巡查分析</legend><div className="analysis-switches">{analyses.map(name => <div key={name} className="analysis-switch-row"><span>{name}巡查分析</span><button type="button" role="switch" aria-label={`${name}巡查分析`} aria-checked={name === '火点'} disabled className="settings-switch"><span /></button></div>)}</div></fieldset>
        <fieldset disabled={busy} className="settings-section"><legend>任务列表</legend>
          <div className="task-clear-content">
          <p className="settings-help">清空本机显示的历史任务，保留已保存的 Word 报告和平台原始记录。</p>
          {confirmClear ? <div className="notice warning task-clear-confirm" role="group" aria-labelledby="task-clear-title">
            <strong id="task-clear-title">确认清空任务列表？</strong>
            <p>清空后，历史任务及未提交起飞请求的失败任务将不再显示，刷新或重启也不会恢复。当前正在执行或待核查的任务会保留。此操作不会取消司空平台任务，也不会修改监测设置。</p>
            <div className="task-clear-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setConfirmClear(false)}>暂不清空</button><button type="button" className="secondary-button task-clear-button" onClick={() => void clearTasks()}>{clearing ? '正在清空…' : '确认清空'}</button></div>
          </div> : <button type="button" className="secondary-button task-clear-button" onClick={() => { setConfirmClear(true); setClearMessage(''); setError(''); }}>清空任务列表</button>}
          {clearMessage && <p className="notice success" role="status">{clearMessage}</p>}
          </div>
        </fieldset>
        {error && <p className="notice warning" role="alert">{error}</p>}
      </div>
      <footer className="settings-footer"><button type="button" className="text-button" disabled={busy} onClick={reset}>恢复默认</button><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{saving ? '正在保存…' : '保存设置'}</button></footer>
    </form>
  </dialog>;
}
