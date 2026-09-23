import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, it, expect } from 'vitest';
import type { MonitorView, Readiness } from '../src/lib/workspace';
import { dataQuality, defaultSettings } from '../src/lib/workspace';
import { SetupPanel } from '../src/components/SetupPanel';
import { MonitoringPanel, FlightPanel } from '../src/components/MonitoringPanel';
import { FlightReportPanel } from '../src/components/FlightReportPanel';
import { PluginUpdateAlert } from '../src/components/PluginUpdateAlert';
import { SettingsDialog } from '../src/components/SettingsDialog';
const noop = () => {};
const action = async () => true;
const at = (age: number) => new Date(Date.now() + (8-age)*3600000).toISOString().slice(0,19).replace('T',' ');
const monitor = (age=0, potassium:number|null=0.2): MonitorView => ({ settings:{...defaultSettings},enabled:true,syncing:false,lastAttempt:at(0),lastSuccess:at(0),error:null,total:1,rows:[{time:at(age),potassium}],queryThrough:at(0),flight:{enabled:true,threshold:1,event:null} });
const readiness = (ready:boolean):Readiness => ({ pluginReady:true,pluginMessage:'connected',pluginUpdateRequired:false,minimumExtensionVersion:'0.6.0',checking:false,started:false,ready,sites:['map','dji','sniff'].map((id,i)=>({id,state:!ready&&i===1?'login_required':'ready',message:'fixture',checkedAt:at(0),session:'fixture',tabId:i,url:'https://example.test'})) });
const dom = (element: React.ReactElement) => parseHTML(renderToStaticMarkup(element)).document;
const button = (document: Document, text: string) => [...document.querySelectorAll('button')].find(b=>b.textContent===text)!;
describe('workspace readiness and data truthfulness',()=>{
  it('uses saved thresholds for monitoring warnings and chart limits',()=>{
    const data = monitor(0, 1.5);
    data.settings = { ...defaultSettings, potassiumThreshold: 2, pm25Threshold: 80 };
    expect(dataQuality(data).label).toBe('数据正常');
    const d = dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop}/>);
    expect(d.documentElement.textContent).toContain('巡查触发阈值 > 2');
    expect(d.documentElement.textContent).not.toContain('PM2.5');
    expect(d.querySelector('.potassium-bar.exceeded-point')).toBeNull();
    data.settings.pm25Threshold = 60;
    expect(dataQuality(data).label).toBe('数据正常');
    data.settings.potassiumThreshold = 1;
    expect(dataQuality(data).label).toBe('K⁺ 超过巡查阈值');
  });
  it('separates report settings and shows delay only for automatic takeoff',()=>{
    const d = dom(<SettingsDialog settings={defaultSettings} onClose={noop} onSaved={async()=>{}}/>);
    expect(d.querySelector('#potassium-threshold')?.getAttribute('value')).toBe('1.0');
    expect(d.querySelector('#pm25-threshold')?.getAttribute('value')).toBe('60');
    expect(d.querySelector('#takeoff-delay')).toBeNull();
    const automatic = dom(<SettingsDialog settings={{...defaultSettings, requireManualConfirmation:false}} onClose={noop} onSaved={async()=>{}}/>);
    expect(automatic.querySelector('#takeoff-delay')?.getAttribute('value')).toBe('5');
    expect(d.querySelector('#pm25-threshold')?.closest('fieldset')?.querySelector('legend')?.textContent).toBe('报告阈值设置');
    expect(d.documentElement.textContent).not.toContain('保存到本机');
    expect(d.documentElement.textContent).not.toContain('暂未开放');
    expect(d.documentElement.textContent).toContain('AI 巡查分析');
    expect(d.querySelector('[aria-labelledby="manual-confirmation-label"]')?.getAttribute('aria-checked')).toBe('true');
    const switches = d.querySelectorAll('.analysis-switches [role="switch"]');
    expect(switches).toHaveLength(6);
    for (const toggle of switches) { expect(toggle.hasAttribute('disabled')).toBe(true); expect(toggle.getAttribute('aria-checked')).toBe(toggle.getAttribute('aria-label') === '火点巡查分析' ? 'true' : 'false'); }
  });
  it('keeps an actionable, non-dismissible upgrade alert until the plugin is compatible',()=>{
    const state={...readiness(false),pluginReady:false,pluginUpdateRequired:true,pluginMessage:'当前 v0.5.0，需要 v0.6.0'};
    const d=dom(<PluginUpdateAlert state={state} onSetup={noop}/>);
    expect(d.querySelector('[role="alert"]')?.textContent).toContain('必须更新浏览器插件');
    expect(d.documentElement.textContent).toContain('当前 v0.5.0，需要 v0.6.0');
    expect(button(d,'打开扩展管理 ↗')).toBeDefined();
    expect(button(d,'查看插件安装指引')).toBeDefined();
    expect(d.querySelectorAll('button')).toHaveLength(2);
    expect(dom(<PluginUpdateAlert state={readiness(true)} onSetup={noop}/>).querySelector('[role="alert"]')).toBeNull();
  });
  it('blocks start until all three sites pass',()=>{
    const render=(ready:boolean)=>dom(<SetupPanel state={readiness(ready)} busy={false} onCheck={noop} onStart={noop} openSite={noop} onHistory={noop}/>);
    expect(button(render(false),'读取数据并开始监测').hasAttribute('disabled')).toBe(true);
    expect(button(render(true),'读取数据并开始监测').hasAttribute('disabled')).toBe(false);
  });
  it('shows only plugin setup at the first step and preserves history access',()=>{
    const r={...readiness(false),pluginReady:false};
    const d=dom(<SetupPanel state={r} busy={false} onCheck={noop} onStart={noop} openSite={noop} onHistory={noop}/>);
    expect(button(d,'查看历史报告 →')).toBeDefined();
    expect(button(d,'读取数据并开始监测')).toBeUndefined();
    expect(d.documentElement.textContent).not.toContain('三个网站均需验证通过');
  });
  it('does not equate recent sync with fresh or complete source data and preserves zero',()=>{
    expect(dataQuality(monitor(8)).label).toBe('数据已过期');
    expect(dataQuality(monitor(0,null)).label).toBe('暂无数据');
    expect(dataQuality(monitor(0,0)).label).toBe('数据正常');
    expect(dataQuality(monitor(0,1.1)).label).toBe('K⁺ 超过巡查阈值');
    expect(dataQuality(null).label).toBe('暂无数据');
  });
  it('blocks manual sync and a new flight when environment is broken',()=>{
    const props={data:monitor(),busy:false,ready:false,started:true,action,onPrepare:noop};
    const d=dom(<MonitoringPanel {...props} onFlight={noop}/>);
    expect(d.querySelector('[aria-label="立即同步"]')?.hasAttribute('disabled')).toBe(true);
    expect(d.querySelector('button[aria-label="立即同步"] svg.refresh-icon')).not.toBeNull();
    expect(d.documentElement.textContent).not.toContain('暂停自动同步');
    const f=dom(<FlightPanel {...props}/>);
    expect(f.documentElement.textContent).toContain('等待工作环境就绪');
    expect(button(f,'演练计划填写').hasAttribute('disabled')).toBe(true);
  });
  it('keeps old data warnings visible and never labels unavailable flight data as waiting for threshold',()=>{
    const props={data:monitor(8),busy:false,ready:true,started:true,action,onPrepare:noop};
    const d=dom(<MonitoringPanel {...props} onFlight={noop}/>);
    expect(d.documentElement.textContent).toContain('数据已过期');
    const f=dom(<FlightPanel {...props}/>);
    expect(f.documentElement.textContent).toContain('等待有效监测数据');
    expect(f.documentElement.textContent).not.toContain('等待最新小时数据超过阈值');
  });
  it('preserves report history access but requires preparation before creation',()=>{
    const d=dom(<FlightReportPanel tabs={[]} ready={false} onPrepare={noop} openMedia={noop} openAir={noop}/>);
    expect(button(d,'完成准备后新建')).toBeDefined();
    expect(d.documentElement.textContent).toContain('历史巡飞报告');
    expect(d.documentElement.textContent).not.toContain('读取并核对资料');
  });
});
