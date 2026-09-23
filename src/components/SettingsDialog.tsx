import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { defaultSettings, type WorkspaceSettings } from '../lib/workspace';

type Props = { settings: WorkspaceSettings; onClose: () => void; onSaved: () => Promise<void> };
const analyses = ['火点', '工地', '裸土', '扬尘', '河道', '人为干扰'];

export function SettingsDialog({ settings, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [potassium, setPotassium] = useState(Number.isInteger(settings.potassiumThreshold) ? settings.potassiumThreshold.toFixed(1) : String(settings.potassiumThreshold));
  const [pm25, setPm25] = useState(String(settings.pm25Threshold));
  const [delay, setDelay] = useState(String(settings.takeoffDelayMinutes));
  const [manual, setManual] = useState(settings.requireManualConfirmation);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);

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
    setError('');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current) return;
    const next: WorkspaceSettings = { potassiumThreshold: Number(potassium), pm25Threshold: Number(pm25), takeoffDelayMinutes: manual && (!delay.trim() || !Number.isInteger(Number(delay)) || Number(delay) < 0 || Number(delay) > 1440) ? settings.takeoffDelayMinutes : Number(delay), requireManualConfirmation: manual };
    if (!potassium.trim() || !pm25.trim() || ![next.potassiumThreshold, next.pm25Threshold].every(value => Number.isFinite(value) && value > 0)) {
      setError('请输入大于 0 的有效浓度阈值。'); return;
    }
    if (!manual && (!delay.trim() || !Number.isInteger(next.takeoffDelayMinutes) || next.takeoffDelayMinutes < 0 || next.takeoffDelayMinutes > 1440)) {
      setError('起飞延迟须为 0 至 1440 之间的整数分钟。'); return;
    }
    lock.current = true; setSaving(true); setError('');
    try {
      await invoke('save_workspace_settings', { settings: next });
      await onSaved();
      onClose();
    } catch (reason) { setError(`保存失败：${String(reason)}`); }
    finally { lock.current = false; setSaving(false); }
  };

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={event => void submit(event)}>
      <header className="settings-header"><div><h2 id="settings-title">监测设置</h2><p>设置监测阈值与无人机巡查策略</p></div><button type="button" className="icon-button" aria-label="关闭设置" disabled={saving} onClick={onClose}>×</button></header>
      <div className="settings-body">
        <fieldset disabled={saving} className="settings-section"><legend>监测阈值</legend><div className="settings-fields">
          <label htmlFor="potassium-threshold">钾离子 K⁺ 阈值<div className="settings-input"><input autoFocus id="potassium-threshold" type="number" step="any" min="0.000001" required value={potassium} onChange={event => setPotassium(event.target.value)} /><span>μg/m³</span></div></label>
        </div><p className="settings-help">钾离子超过阈值时触发巡查计划填写。</p></fieldset>
        <fieldset disabled={saving} className="settings-section"><legend>无人机起飞策略</legend>
          <div className="settings-switch-row"><div><strong id="manual-confirmation-label">起飞前人工确认</strong><p id="manual-confirmation-help">{manual ? '开启：由工作人员确认后起飞' : '关闭：按策略自动执行起飞'}</p></div><button type="button" role="switch" aria-checked={manual} aria-labelledby="manual-confirmation-label" aria-describedby="manual-confirmation-help" className="settings-switch" onClick={() => setManual(value => !value)}><span /></button></div>
          {!manual && <label className="settings-delay" htmlFor="takeoff-delay">钾离子超标后延迟<div className="settings-input"><input id="takeoff-delay" type="number" min="0" max="1440" step="1" required value={delay} onChange={event => setDelay(event.target.value)} /><span>分钟</span></div><small>0 表示不延迟，最多 1440 分钟</small></label>}
          <p className="notice settings-flight-note">{manual ? '钾离子超标后直接填写计划，等待人工确认起飞。' : '钾离子超标后开始计时，延迟结束后自动起飞。延迟调整用于后续新任务。'}</p>
        </fieldset>
        <fieldset disabled={saving} className="settings-section"><legend>报告阈值设置</legend><div className="settings-fields">
          <label htmlFor="pm25-threshold">PM2.5 报告阈值<div className="settings-input"><input id="pm25-threshold" type="number" step="any" min="0.000001" required value={pm25} onChange={event => setPm25(event.target.value)} /><span>μg/m³</span></div></label>
        </div><p className="settings-help">用于巡飞报告中可飞 PM2.5 数据的阈值判定。</p></fieldset>
        <fieldset className="settings-section"><legend>AI 巡查分析</legend><div className="analysis-switches">{analyses.map(name => <div key={name} className="analysis-switch-row"><span>{name}巡查分析</span><button type="button" role="switch" aria-label={`${name}巡查分析`} aria-checked={name === '火点'} disabled className="settings-switch"><span /></button></div>)}</div></fieldset>
        {error && <p className="notice warning" role="alert">{error}</p>}
      </div>
      <footer className="settings-footer"><button type="button" className="text-button" disabled={saving} onClick={reset}>恢复默认</button><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? '正在保存…' : '保存设置'}</button></footer>
    </form>
  </dialog>;
}
