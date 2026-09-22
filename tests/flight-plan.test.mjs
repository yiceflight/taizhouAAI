import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { PLAN_URL, PLAN_RECIPE, validatePlanJob, fillFlightPlan } from '../extension/src/flight-plan.js';
const job = { type: 'dji-prepare', submit: false, eventId: '00000000-0000-4000-8000-000000000001', name: '钾离子超标巡查-20260922-09' };
test('flight task cannot enable submission or choose arbitrary recipe inputs', () => {
  validatePlanJob(job);
  for (const change of [{ submit:true }, {submit:undefined}, {type:'submit'}, {name:'任意名称'}, {eventId:'invalid'}]) assert.throws(() => validatePlanJob({...job,...change}));
});
test('wrong project and login redirects fail before reading or changing the page', async () => {
  for (const url of ['https://fh.dji.com/login', PLAN_URL.replace('c7ea6bbc','aaaaaaaa'), 'https://evil.test']) {
    await assert.rejects(runInNewContext(`(${fillFlightPlan.toString()})(${JSON.stringify(PLAN_RECIPE)},${JSON.stringify(job.name)},${JSON.stringify(PLAN_URL)})`, {location:{href:url}, Date, get document(){throw Error('must not read DOM');}}), /页面不匹配/);
  }
});
function fixture({ ambiguous=false, confirmOnly=false, changedHeight=false, baseRoute=false }={}) {
  const buttons = ['普通任务','高精度 RTK','立即','返航'].map(s=>`<button>${s}</button>`).join('');
  const switches = ['多模态识别','自动断点续飞','智能规划最佳返航路线'].map(s=>`<div><span>${s}</span><button role="switch" aria-checked="true"></button></div>`).join('');
  const { window, document } = parseHTML(`<html><body><main><section id="form"><h2>新建计划</h2><label>计划名称<input placeholder="请输入计划名称" value="新建计划30"></label><span>任务类型</span>${buttons}<button>选择航线</button><div id="selected-route"></div><span>选择设备</span><button>选择设备</button><div id="selected-device"></div>${switches}<div><span>最低返航高度（相对机场）</span><input type="number" value="0" id="height"></div><span>自动返航</span><span>媒体存储位置</span><span>全部文件</span><button>编辑</button><div id="subscriber">毛慧</div><button id="confirm">确定</button></section></main></body></html>`);
  window.HTMLElement.prototype.getClientRects = function(){return [1]};
  window.HTMLElement.prototype.scrollIntoView = function(){};
  window.HTMLElement.prototype.focus = function(){};
  window.HTMLElement.prototype.blur = function(){};
  let submissions=0;
  const btn = s => [...document.querySelectorAll('button')].find(e=>e.textContent===s);
  document.querySelector('#confirm').onclick=()=>submissions++;
  for(const label of ['普通任务','高精度 RTK','立即','返航']) btn(label).onclick=e=>e.currentTarget.className='button-primary';
  for(const el of document.querySelectorAll('[role="switch"]')) el.onclick=()=>el.setAttribute('aria-checked',el.getAttribute('aria-checked')==='true'?'false':'true');
  btn('选择航线').onclick=()=>{
    const library=document.createElement('aside'); library.innerHTML=`<div>${PLAN_RECIPE.route}</div>${ambiguous?`<div>${PLAN_RECIPE.route}</div>`:''}`;document.body.append(library);
    library.firstElementChild.onclick=()=>{document.querySelector('input[placeholder]').value='新建计划30';document.querySelector('#selected-route').textContent=baseRoute?PLAN_RECIPE.route:PLAN_RECIPE.selectedRoute;library.remove()};
  };
  btn('选择设备').onclick=()=>{
    const devices=document.createElement('aside');devices.innerHTML=`<div><span>Dock 3</span><span>泰州环境监测</span><span>Matrice 4TD</span></div>`;document.body.append(devices);
    devices.firstElementChild.onclick=()=>{document.querySelector('#selected-device').append(devices.firstElementChild);devices.remove()};
  };
  btn('编辑').onclick=()=>{
    const notice=document.createElement('aside');notice.innerHTML=`<h2>告警通知设置</h2><div><label><input type="checkbox">站内通知</label><label><input type="checkbox">短信</label><label><input type="checkbox">邮件</label></div><div><span>告警频率 (分钟)</span><input type="number" value="9"></div><span>订阅人员</span><input placeholder="搜索"><table><tr><td>毛慧</td><td><input type="checkbox"></td></tr><tr><td>运维</td><td><input type="checkbox"></td></tr></table>`;document.body.append(notice);
    for(const input of notice.querySelectorAll('[type="checkbox"]')) {input.checked = input.closest('tr')?.textContent==='毛慧'; input.onclick=()=>{input.checked=!input.checked;document.querySelector('#subscriber').textContent='运维'}};
  };
  if(confirmOnly) btn('普通任务').setAttribute('type','submit');
  if(changedHeight) document.querySelector('#height').addEventListener('change',e=>e.target.value='60');
  const execute=()=>runInNewContext(`(${fillFlightPlan.toString()})(${JSON.stringify(PLAN_RECIPE)},${JSON.stringify(job.name)},${JSON.stringify(PLAN_URL)})`, { document, location:{href:PLAN_URL+'/create-plan'}, HTMLInputElement:window.HTMLInputElement, Event:window.Event, Date, setTimeout, getComputedStyle:()=>({visibility:'visible'}) });
  return {execute,document,submissions:()=>submissions};
}
test('video recipe fills and verifies the form without ever clicking final confirmation', async()=>{
  const f=fixture();const result=await f.execute();assert.equal(result.submitted,false);assert.equal(result.status,'ready');assert.equal(f.submissions(),0);assert.equal(f.document.querySelector('#height').value,'110');assert.equal(f.document.querySelector('input[placeholder]').value,job.name);
});
test('original route name is accepted when the platform omits its temporary copy suffix',async()=>{const f=fixture({baseRoute:true});assert.equal((await f.execute()).status,'ready');assert.equal(f.submissions(),0)});
test('ambiguous routes, submission controls and rejected height values fail closed',async()=>{
  for(const options of [{ambiguous:true},{confirmOnly:true},{changedHeight:true}]) {const f=fixture(options); await assert.rejects(f.execute());assert.equal(f.submissions(),0)}
});
