import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { PLAN_URL, PLAN_RECIPE, validatePlanJob, validateSubmitJob, fillFlightPlan } from '../extension/src/flight-plan.js';
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
function fixture({ ambiguous=false, confirmOnly=false, changedHeight=false, baseRoute=false, submit=false, name=job.name }={}) {
  const buttons = ['普通任务','高精度 RTK','立即','返航'].map(s=>`<button>${s}</button>`).join('');
  const switches = ['多模态识别','自动断点续飞','智能规划最佳返航路线'].map(s=>`<div><span>${s}</span><button role="switch" aria-checked="true"></button></div>`).join('');
  const { window, document } = parseHTML(`<html><body><main><section id="form"><h2>新建计划</h2><label>计划名称<input placeholder="请输入计划名称" value="新建计划30"></label><span>任务类型</span>${buttons}<button>选择航线</button><div id="selected-route"></div><span>选择设备</span><button>选择设备</button><div id="selected-device"></div>${switches}<div><span>最低返航高度（相对机场）</span><input type="number" value="0" id="height"></div><span>自动返航</span><span>媒体存储位置</span><span>全部文件</span><button>编辑</button><div id="subscriber">毛慧</div><button id="confirm">确定</button></section></main></body></html>`);
  window.HTMLElement.prototype.getClientRects = function(){return [1]};
  window.HTMLElement.prototype.scrollIntoView = function(){};
  window.HTMLElement.prototype.focus = function(){};
  window.HTMLElement.prototype.blur = function(){};
  let submissions=0;
  const location = {href:PLAN_URL+'/create-plan'};
  const btn = s => [...document.querySelectorAll('button')].find(e=>e.textContent===s);
  document.querySelector('#confirm').onclick=()=>{ submissions++; if (submit) { document.body.innerHTML = `<div>${name}</div>`; location.href = PLAN_URL; } };
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
  const run=(commit)=>runInNewContext(`(${fillFlightPlan.toString()})(${JSON.stringify(PLAN_RECIPE)},${JSON.stringify(name)},${JSON.stringify(PLAN_URL)},${commit})`, { document, location, HTMLInputElement:window.HTMLInputElement, Event:window.Event, Date, setTimeout, getComputedStyle:()=>({visibility:'visible'}) });
  const execute=async()=>{const draft=await run(false); return submit?run(true):draft;};
  return {execute,commit:()=>run(true),document,submissions:()=>submissions};
}
test('video recipe fills and verifies the form without ever clicking final confirmation', async()=>{
  const f=fixture();const result=await f.execute();assert.equal(result.submitted,false);assert.equal(result.status,'ready');assert.equal(f.submissions(),0);assert.equal(f.document.querySelector('#height').value,'110');assert.equal(f.document.querySelector('input[placeholder]').value,job.name);
});
test('original route name is accepted when the platform omits its temporary copy suffix',async()=>{const f=fixture({baseRoute:true});assert.equal((await f.execute()).status,'ready');assert.equal(f.submissions(),0)});
test('ambiguous routes, submission controls and rejected height values fail closed',async()=>{
  for(const options of [{ambiguous:true},{confirmOnly:true},{changedHeight:true}]) {const f=fixture(options); await assert.rejects(f.execute());assert.equal(f.submissions(),0)}
});

test('explicit submission accepts only a real mission and clicks exactly once after validation', async () => {
  validateSubmitJob({...job,type:'dji-submit',submit:true});
  for (const change of [{submit:false}, {name:'司空填写演练-20260922-09'}, {eventId:'wrong'}, {type:'dji-prepare'}]) assert.throws(()=>validateSubmitJob({...job,type:'dji-submit',submit:true,...change}));
  const f=fixture({submit:true}); const receipt=await f.execute();
  assert.equal(f.submissions(),1); assert.equal(receipt.status,'submitted'); assert.equal(receipt.submitted,true);
});
test('manual mission can submit while previews and invalid recipes cannot', async () => {
  const name='手动巡查-20260922-09-ab123456';
  validatePlanJob({...job,name}); validateSubmitJob({...job,type:'dji-submit',submit:true,name});
  const f=fixture({submit:true,name}); assert.equal((await f.execute()).status,'submitted');
  for(const options of [{changedHeight:true},{ambiguous:true},{name:'司空填写演练-20260922-09'}]) {
    const invalid=fixture({submit:true,...options}); await assert.rejects(invalid.execute()); assert.equal(invalid.submissions(),0);
  }
});

test('submit revalidates without silently overwriting user changes to the prepared plan',async()=>{
  const f=fixture(); await f.execute();
  f.document.querySelector('#height').value='60';
  await assert.rejects(f.commit(), /返航高度/);
  assert.equal(f.document.querySelector('#height').value,'60'); assert.equal(f.submissions(),0);
});
test('extension persists a submission claim before evaluation and refuses replay after a lost receipt', async()=>{
  const { readFile }=await import('node:fs/promises');
  const worker=await readFile(new URL('../extension/src/service-worker.js',import.meta.url),'utf8');
  const source=worker.slice(worker.indexOf('async function submitFlight(job)'),worker.indexOf('async function openPreparedFlight(job)'));
  const submittedJob={...job,type:'dji-submit',submit:true};
  for(const loseReceipt of [false,true]) {
    const stored={[`flight-${job.eventId}`]:42};let evaluations=0;
    const chrome={storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,stored[k]])),set:async values=>Object.assign(stored,values)}},tabs:{get:async()=>({id:42,url:PLAN_URL+'/create-plan'}),update:async()=>{}},debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async()=>{
      assert.ok(stored[`flight-submit-${job.eventId}`]);evaluations++;
      if(loseReceipt)throw Error('receipt lost');
      return {status:'submitted',submitted:true,name:job.name,url:PLAN_URL};
    }}};
    const execute=runInNewContext(`let capturing=false; ${source}; submitFlight`,{chrome,Date,JSON,PLAN_URL,PLAN_RECIPE,validateSubmitJob,fillFlightPlan,evaluationValue:v=>v});
    if(loseReceipt)await assert.rejects(execute(submittedJob),/receipt lost/);else await execute(submittedJob);
    await assert.rejects(execute(submittedJob),/禁止重复提交/);assert.equal(evaluations,1);
  }
});
