import { useEffect, useRef, type ReactNode } from 'react';
import { targetSites, type TargetSite } from '../config/sites';
import type { BridgeStatus, Readiness } from '../lib/workspace';
import { SetupPanel } from './SetupPanel';

export type EnvironmentCheckProps = {
  bridge?: BridgeStatus | null;
  state: Readiness | null;
  busy: boolean;
  error?: string;
  onCheck: () => void;
  openSite: (site: TargetSite) => void;
};

export function environmentPassed(state: Readiness | null) {
  return !!state?.pluginReady && !state.pluginUpdateRequired && targetSites.every(site => state.sites.some(health => health.id === site.id && health.state === 'ready'));
}

export function RequiredSetupDialog({ environment, update }: { environment?: EnvironmentCheckProps; update?: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const blocked = !!update || (!!environment && !environmentPassed(environment.state));
  useEffect(() => {
    const element = dialog.current;
    if (blocked && element && !element.open) element.showModal();
    else if (!blocked && element?.open) element.close();
  }, [blocked]);
  if (!blocked) return null;
  const state = environment?.state;
  return <dialog ref={dialog} className="required-setup-dialog" aria-labelledby="required-setup-title" aria-describedby="required-setup-description" aria-modal="true" onCancel={event => event.preventDefault()}>
    <header className="required-setup-header">
      <span className="required-setup-icon" aria-hidden="true">!</span>
      <div className="required-setup-heading"><h2 id="required-setup-title">{update ? '请先更新客户端' : '请先完成运行环境检查'}</h2>
        <p id="required-setup-description">{update ? '发现新版本，请下载更新并重启客户端，再继续检查运行环境。' : '浏览器插件及三个网站全部验证通过后自动进入工作台 · 无法跳过'}</p></div>
      {environment && <button className="secondary-button required-setup-recheck" disabled={environment.busy || state?.checking} onClick={environment.onCheck}>{state?.checking ? '正在检查…' : '重新检查环境'}</button>}
    </header>
    <div className="required-setup-body">
      {update}
      {environment && <>
        {environment.error && <p className="notice warning" role="alert">{environment.error}</p>}
        <SetupPanel {...environment} />
      </>}
    </div>

  </dialog>;
}
