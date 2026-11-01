import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, it, expect } from 'vitest';
import type { MonitorView, Readiness } from '../src/lib/workspace';
import { dataQuality, defaultSettings, flightSummary, latestValidRow, triggerReading } from '../src/lib/workspace';
import { SetupPanel } from '../src/components/SetupPanel';
import { MonitoringPanel } from '../src/components/MonitoringPanel';
import { DroneStatus } from '../src/components/DroneStatus';
import { FlightReportPanel } from '../src/components/FlightReportPanel';
import { PluginUpdateAlert } from '../src/components/PluginUpdateAlert';
import { SettingsDialog } from '../src/components/SettingsDialog';
const noop = () => {};
const action = async () => true;
const at = (age: number) => new Date(Date.now() + (8-age)*3600000).toISOString().slice(0,19).replace('T',' ');
const monitor = (age=0, potassium:number|null=0.2): MonitorView => ({ settings:{...defaultSettings,noFlyPeriods:[]},enabled:true,syncing:false,lastAttempt:at(0),lastSuccess:at(0),error:null,total:1,rows:[{time:at(age),potassium,pm25:20}],queryThrough:at(0),flight:{threshold:1,event:null,selectedRoute:'测试航线'} });
const readiness = (ready:boolean):Readiness => ({ pluginReady:true,pluginMessage:'connected',pluginUpdateRequired:false,minimumExtensionVersion:'0.6.0',checking:false,started:false,ready,sites:['map','dji','sniff'].map((id,i)=>({id,state:!ready&&i===1?'login_required':'ready',message:'fixture',checkedAt:at(0),session:'fixture',tabId:i,url:'https://example.test'})) });
const dom = (element: React.ReactElement) => parseHTML(renderToStaticMarkup(element)).document;
const button = (document: Document, text: string) => [...document.querySelectorAll('button')].find(b=>b.textContent===text)!;
describe('workspace readiness and data truthfulness',()=>{
  it('removes the monitoring task banner after a verified completed flight',()=>{
    const data = monitor();
    data.flight.event = { id:'task', observedAt:at(0), potassium:null, name:'手动巡查-20260923-14-089e4413', status:'submitted', error:null, preview:false, source:'manual' };
    const render = () => dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop}/>);
    expect(render().querySelector('.task-callout')).not.toBeNull();
    data.flight.event.status = 'completed';
    expect(render().querySelector('.task-callout')).toBeNull();
  });
  it('uses saved thresholds for monitoring warnings and chart limits',()=>{
    const data = monitor(0, 1.5);
    data.settings = { ...defaultSettings,noFlyPeriods:[], potassiumThreshold: 2, pm25Threshold: 80 };
    expect(dataQuality(data).label).toBe('数据正常');
    const d = dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop}/>);
    expect(d.documentElement.textContent).toContain('巡查触发阈值 > 2');
    expect(d.documentElement.textContent).toContain('PM2.5');
    expect(d.querySelector('.potassium-bar.exceeded-point')).toBeNull();
    data.settings.pm25Threshold = 60;
    expect(dataQuality(data).label).toBe('数据正常');
    data.settings.potassiumThreshold = 1;
    expect(dataQuality(data).label).toBe('K⁺ 超过巡查阈值');
  });
  it('separates report settings and shows delay only for automatic takeoff',()=>{
    const d = dom(<SettingsDialog settings={defaultSettings} onClose={noop} onSaved={async()=>{}}/>);
    expect(d.querySelector('#potassium-threshold')?.getAttribute('value')).toBe('1.0');
    expect(d.querySelector('#pm25-threshold')?.getAttribute('value')).toBe('30');
    expect(d.querySelector('#takeoff-delay')).toBeNull();
    const automatic = dom(<SettingsDialog settings={{...defaultSettings,noFlyPeriods:[], requireManualConfirmation:false}} onClose={noop} onSaved={async()=>{}}/>);
    expect(automatic.querySelector('#takeoff-delay')?.getAttribute('value')).toBe('5');
    expect(d.querySelector('#pm25-threshold')?.closest('fieldset')?.querySelector('legend')?.textContent).toBe('监测阈值');
    expect(d.documentElement.textContent).not.toContain('保存到本机');
    expect(d.documentElement.textContent).not.toContain('暂未开放');
    expect(d.documentElement.textContent).toContain('AI 巡查分析');
    expect(d.querySelector('input[name="takeoff-execution-mode"][value="manual"]')?.hasAttribute('checked')).toBe(true);
    expect(d.querySelectorAll('input[name="takeoff-execution-mode"]')).toHaveLength(2);
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
  it('shows environment checks inside the dialog without a standalone status page',()=>{
    for (const ready of [false, true]) {
      const d=dom(<SetupPanel state={readiness(ready)} busy={false} onCheck={noop} openSite={noop}/>);
      expect(d.querySelector('.setup-steps')).toBeNull();
      expect(d.querySelectorAll('.health-row')).toHaveLength(4);
      expect(d.querySelector('.start-card')).toBeNull();
      expect(d.documentElement.textContent).not.toContain('读取数据并开始');
      expect(d.querySelector('h2')).toBeNull();
    }
  });
  it('labels an incomplete site row as verifying while the serial readiness pass is running',()=>{
    const r={...readiness(false),checking:true,sites:readiness(false).sites.map((site,i)=>i===1?{...site,state:'unchecked' as const,message:'等待验证登录与业务访问',checkedAt:null}:site)};
    const d=dom(<SetupPanel state={r} busy={false} onCheck={noop} openSite={noop}/>);
    const row=d.querySelectorAll('.health-row')[2];
    expect(row?.textContent).toContain('正在验证登录与业务访问');
    expect(row?.textContent).toContain('验证中');
    expect(row?.textContent).not.toContain('待验证');
  });
  it('keeps a previously verified site stable while the next readiness pass is running',()=>{
    const r={...readiness(true),checking:true};
    const d=dom(<SetupPanel state={r} busy={false} onCheck={noop} openSite={noop}/>);
    const row=d.querySelectorAll('.health-row')[1];
    expect(row?.textContent).toContain('已验证');
    expect(row?.textContent).not.toContain('验证中');
  });
  it('shows only plugin setup at the first step without extra status notices',()=>{
    const r={...readiness(false),pluginReady:false};
    const d=dom(<SetupPanel state={r} busy={false} onCheck={noop} openSite={noop}/>);
    expect(button(d,'查看巡查任务与报告 →')).toBeUndefined();
    expect(d.documentElement.textContent).not.toContain('测试专用环境');
    expect(button(d,'读取数据并开始监测')).toBeUndefined();
    expect(d.documentElement.textContent).not.toContain('三个网站均需验证通过');
  });
  it('does not equate recent sync with fresh or complete source data and preserves zero',()=>{
    expect(dataQuality(monitor(8)).label).toBe('数据已过期');
    expect(dataQuality(monitor(0,null)).label).toBe('数据正常');
    expect(dataQuality(monitor(0,0)).label).toBe('数据正常');
    expect(dataQuality(monitor(0,1.1)).label).toBe('K⁺ 超过巡查阈值');
    expect(dataQuality(null).label).toBe('暂无数据');
  });
  it('triggers from PM2.5 alone with a strict greater-than threshold',()=>{
    const data = monitor(0, 0.2);
    data.rows[0].pm25 = 30;
    expect(triggerReading(data).exceeded).toBe(false);
    data.rows[0].pm25 = 30.1;
    const reading = triggerReading(data);
    expect(reading.pm25Exceeded).toBe(true);
    expect(reading.potassiumExceeded).toBe(false);
    expect(flightSummary(data, true).title).toContain('PM2.5 超标');
  });
  it('shows the latest valid source hour when the newest source row is still empty',()=>{
    const data = monitor(0, null);
    data.rows[0].pm25 = null;
    data.rows.push({time:at(1),potassium:null,pm25:null},{time:at(2),potassium:2,pm25:35});
    expect(latestValidRow(data)?.time).toBe(data.rows[2].time);
    const d = dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop}/>);
    expect(d.querySelector('.metric-grid article strong')?.textContent).toBe('2');
    expect(d.querySelector('.time-metric strong')?.textContent).toBe(data.rows[2].time.slice(0,16));
    expect(d.documentElement.textContent).toContain('K⁺ 2 > 1 μg/m³');
    expect(d.documentElement.textContent).not.toContain('数据已过期');
    expect(d.querySelectorAll('.potassium-bar')).toHaveLength(1);
    expect(d.querySelector('svg[aria-labelledby="monitor-chart-title monitor-chart-desc"]')?.textContent).toContain(data.rows[0].time.slice(5,13));
    expect(triggerReading(data).valid).toBe(true);
    expect(triggerReading(data).exceeded).toBe(true);
  });
  it('anchors the summary cards and source time to K+ when PM2.5 is newer',()=>{
    const data = monitor(2, 0.23);
    data.rows = [
      { time: at(0), potassium: null, pm25: 15 },
      { time: at(2), potassium: 0.23, pm25: 16 },
    ];
    const d = dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop}/>);
    const cards = d.querySelectorAll('.metric-grid article');
    expect(cards[0]?.querySelector('strong')?.textContent).toBe('0.23');
    expect(cards[1]?.querySelector('strong')?.textContent).toBe('15');
    expect(cards[1]?.textContent).toContain('巡查触发阈值');
    expect(d.querySelector('.time-metric strong')?.textContent).toBe(at(0).slice(0, 16));
    expect(dataQuality(data).label).toBe('数据正常');
  });
  it('blocks manual sync and a new flight when environment is broken',()=>{
    const props={data:monitor(),busy:false,ready:false,started:true,action,onPrepare:noop};
    const d=dom(<MonitoringPanel {...props} onFlight={noop}/>);
    expect(d.querySelector('[aria-label="立即同步"]')?.hasAttribute('disabled')).toBe(true);
    expect(d.querySelector('button[aria-label="立即同步"] svg.refresh-icon')).not.toBeNull();
    expect(d.documentElement.textContent).not.toContain('暂停自动同步');
    const f=dom(<DroneStatus {...props} onFlight={noop}/>);
    expect(f.querySelector('.drone-status-copy')).toBeNull();
    expect(button(f,'立即执行任务').hasAttribute('disabled')).toBe(true);
  });
  it('allows range refill after data clearing before monitoring is started',()=>{
    const d=dom(<MonitoringPanel data={monitor()} busy={false} ready started={false} action={action} onPrepare={noop} onFlight={noop}/>);
    const refresh = d.querySelector('button[aria-label="立即同步"]');
    expect(refresh?.hasAttribute('disabled')).toBe(false);
    expect(refresh?.getAttribute('title')).toBe('补齐当前时间范围');
  });
  it('shows the selected route with one settings action in the patrol card heading',()=>{
    const data = monitor();
    data.flight.selectedRoute = '东南火点巡查航线-改-副本(6)';
    const d = dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop} onSettings={noop}/>);
    const route = d.querySelector<HTMLButtonElement>('.monitoring-route-summary');
    expect(d.querySelector('.task-policy-grid')?.textContent).toContain('东南火点巡查航线-改-副本(6)');
    expect(route?.textContent).toContain('去设置');
    expect(route?.getAttribute('aria-label')).toContain('去设置');
    expect(d.querySelectorAll('.task-panel-heading .monitoring-route-summary')).toHaveLength(1);
    expect(d.querySelectorAll('.task-policy-grid button')).toHaveLength(0);
    expect(d.querySelector('.task-panel-heading')?.textContent).not.toContain('查看任务');
    expect(d.querySelectorAll('.task-policy-note .text-button')).toHaveLength(0);
  });
  it('shows the selected execution mode and confirmation rules in the patrol card',()=>{
    const data = monitor();
    data.settings = { ...defaultSettings, noFlyPeriods: [{ start: '05:00', end: '08:00' }], requireManualConfirmation: false, takeoffDelayMinutes: 12 };
    const automatic = dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop}/>);
    expect(automatic.querySelector('.task-policy-grid')?.textContent).toContain('自动执行');
    expect(automatic.querySelector('.task-policy-grid')?.textContent).toContain('自动提交');
    expect(automatic.querySelector('.task-policy-note')?.textContent).toContain('延迟 12 分钟');
    expect(automatic.querySelector('.task-policy-grid')?.textContent).toContain('05:00–08:00');
    const manualOnly = dom(<MonitoringPanel data={data} busy={false} ready started action={action} onPrepare={noop} onFlight={noop}/>);
    expect(manualOnly.querySelector('.task-policy-grid')?.textContent).toContain('自动执行');
    expect(manualOnly.querySelector('.task-policy-note')?.textContent).not.toContain('仅产生提醒');
  });
  it('keeps old data warnings visible and never labels unavailable flight data as waiting for threshold',()=>{
    const props={data:monitor(8),busy:false,ready:true,started:true,action,onPrepare:noop};
    const d=dom(<MonitoringPanel {...props} onFlight={noop}/>);
    expect(d.documentElement.textContent).toContain('数据已过期');
    const f=dom(<DroneStatus {...props} onFlight={noop}/>);
    expect(f.documentElement.textContent).not.toContain('K⁺ 超标');
    expect(f.documentElement.textContent).not.toContain('等待最新小时数据超过阈值');
  });
  it('preserves report history access but requires preparation before creation',()=>{
    const d=dom(<FlightReportPanel tabs={[]} ready={false} onPrepare={noop} openMedia={noop} openAir={noop}/>);
    expect(button(d,'重新检查环境')).toBeDefined();
    expect(d.documentElement.textContent).toContain('任务列表');
    expect(d.documentElement.textContent).not.toContain('读取并核对资料');
  });
});
