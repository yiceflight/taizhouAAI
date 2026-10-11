import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { evaluationValue } from '../extension/src/bridge-core.js';
import { PLAN_URL, PLAN_RECIPE, validatePlanJob, validateSubmitJob, fillFlightPlan, readFlightStatus, readFlightSubmissionIssue } from '../extension/src/flight-plan.js';
const job = { type: 'dji-prepare', submit: false, eventId: '00000000-0000-4000-8000-000000000001', name: '钾离子超标巡查-20260922-09' };
test('flight status reads the actual ended tab and progress-suffixed status', async () => {
  const { window, document } = parseHTML(`<html><body><button id="open">未完成</button><button id="done">已结束</button><table><tbody></tbody></table></body></html>`);
  window.HTMLElement.prototype.getClientRects = () => [1];
  const body = document.querySelector('tbody');
  const rows = {
    open: `<tr><td><span>${job.name}</span></td><td><span>执行中</span></td></tr>`,
    done: `<tr><td><span>${job.name}</span></td><td><span>执行成功 (9/9)</span></td></tr>`,
  };
  let phase = 'open';
  const show = key => { body.innerHTML = key === phase ? rows[key] : ''; };
  document.querySelector('#open').onclick = () => show('open');
  document.querySelector('#done').onclick = () => show('done');
  const read = () => runInNewContext(`(${readFlightStatus.toString()})(${JSON.stringify(job.name)},${JSON.stringify(PLAN_URL)})`, { document, location: { href: PLAN_URL }, setTimeout: fn => fn() });
  assert.equal((await read()).status, '执行中');
  phase = 'done';
  assert.equal((await read()).status, '执行成功');
  rows.done += rows.done;
  await assert.rejects(read(), /不唯一/);
  rows.done = '';
  assert.equal((await read()).status, null);
});
test('flight task cannot enable submission or choose arbitrary recipe inputs', () => {
  validatePlanJob(job);
  for (const change of [{ submit:true }, {submit:undefined}, {type:'submit'}, {name:'任意名称'}, {eventId:'invalid'}]) assert.throws(() => validatePlanJob({...job,...change}));
});
test('active FlightHub task labels normalize to the client status without accepting unrelated text', async () => {
  const name='手动巡查-20261011-14-7393d788';
  for (const [label,expected] of [
    ['任务执行  (3/9)','执行中'], ['任务执行（3/9）','执行中'],
    ['任务执行 <span>(3/9)</span>','执行中'], ['执行中','执行中'],
    ['执行成功 (9/9)','执行成功'], ['任务执行异常',null], ['未知状态',null],
  ]) {
    const {window,document}=parseHTML(`<button role="tab">未完成</button><aside>${name} 飞行作业中</aside><table><tr><td>${name}</td><td>${label}</td></tr><tr><td>其他计划</td><td>执行失败</td></tr></table>`);
    window.HTMLElement.prototype.getClientRects=()=>[1];
    const result=await runInNewContext(`(${readFlightStatus.toString()})(${JSON.stringify(name)},${JSON.stringify(PLAN_URL)})`,{document,location:{href:PLAN_URL},setTimeout:fn=>fn()});
    assert.equal(result.status,expected,label);
  }
});
test('wrong project and login redirects fail before reading or changing the page', async () => {
  for (const url of ['https://fh.dji.com/login', PLAN_URL.replace('c7ea6bbc','aaaaaaaa'), 'https://evil.test']) {
    await assert.rejects(runInNewContext(`(${fillFlightPlan.toString()})(${JSON.stringify(PLAN_RECIPE)},${JSON.stringify(job.name)},${JSON.stringify(PLAN_URL)})`, {location:{href:url}, Date, get document(){throw Error('must not read DOM');}}), /页面不匹配/);
  }
});
function fixture({ ambiguous=false, confirmOnly=false, changedHeight=false, baseRoute=false, submit=false, name=job.name,
  libraryRoute=PLAN_RECIPE.route, selectedRoute=`${PLAN_RECIPE.route}-副本(2)`, previewRoute=null, submissionDialog=null, dialogDelay=0,
  receiptRows=1, deviceCard=false, fastClock=false }={}) {
  const buttons = ['普通任务','高精度 RTK','立即','返航'].map(s=>`<button>${s}</button>`).join('');
  const switches = ['多模态识别','自动断点续飞','智能规划最佳返航路线'].map(s=>`<div><span>${s}</span><button role="switch" aria-checked="true"></button></div>`).join('');
  const { window, document } = parseHTML(`<html><body><main><section id="form"><h2>新建计划</h2><label>计划名称<input placeholder="请输入计划名称" value="新建计划30"></label><span>任务类型</span>${buttons}<button>选择航线</button><div id="selected-route"></div><span>选择设备</span><button>选择设备</button><div id="selected-device"></div>${switches}<div><span>最低返航高度（相对机场）</span><input type="number" value="0" id="height"></div><span>自动返航</span><span>媒体存储位置</span><span>全部文件</span><button>编辑</button><div id="subscriber">毛慧</div><button id="confirm">确定</button></section></main></body></html>`);
  window.HTMLElement.prototype.getClientRects = function(){return [1]};
  window.HTMLElement.prototype.scrollIntoView = function(){};
  window.HTMLElement.prototype.focus = function(){};
  window.HTMLElement.prototype.blur = function(){};
  let submissions=0; let followupExecutions=0;
  const location = {href:PLAN_URL+'/create-plan'};
  const btn = s => [...document.querySelectorAll('button')].find(e=>e.textContent===s);
  document.querySelector('#confirm').onclick=()=>{
    submissions++;
    if (submissionDialog) {
      const show=()=>{
        const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML=submissionDialog;
        for(const button of dialog.querySelectorAll('button')) button.onclick=()=>followupExecutions++;
        document.body.append(dialog);
      };
      if (dialogDelay) setTimeout(show,dialogDelay);else show();
    } else if (submit) {
      document.body.innerHTML = `${deviceCard ? `<aside>${name}</aside>` : ''}<table>${`<tr><td><span>${name}</span></td><td>任务执行 (3/9)</td></tr>`.repeat(receiptRows)}</table>`;
      location.href = PLAN_URL;
    }
  };
  for(const label of ['普通任务','高精度 RTK','立即','返航']) btn(label).onclick=e=>e.currentTarget.className='button-primary';
  for(const el of document.querySelectorAll('[role="switch"]')) el.onclick=()=>el.setAttribute('aria-checked',el.getAttribute('aria-checked')==='true'?'false':'true');
  btn('选择航线').onclick=()=>{
    const library=document.createElement('aside'); library.innerHTML=`<h2>航线库</h2><section><div class="route"><span>${libraryRoute}</span></div>${ambiguous?`<div class="route"><span>${PLAN_RECIPE.route}-副本(99)</span></div>`:''}</section>`;document.body.append(library);
    if (previewRoute) { const preview=document.createElement('aside'); preview.textContent=previewRoute; preview.onclick=()=>{throw Error('must not click a preview title')}; document.body.append(preview); }
    library.querySelector('.route span').onclick=()=>{document.querySelector('input[placeholder]').value='新建计划30';document.querySelector('#selected-route').textContent=baseRoute?PLAN_RECIPE.route:selectedRoute;library.remove()};
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
  let clock=0;
  const run=(commit)=>runInNewContext(`(${fillFlightPlan.toString()})(${JSON.stringify(PLAN_RECIPE)},${JSON.stringify(name)},${JSON.stringify(PLAN_URL)},${commit},(${readFlightSubmissionIssue.toString()}))`, { document, location, HTMLInputElement:window.HTMLInputElement, Event:window.Event, Date:fastClock?{now:()=>clock}:Date, setTimeout:fastClock?(fn,ms)=>{clock+=ms;fn()}:setTimeout, getComputedStyle:()=>({visibility:'visible'}) });
  const execute=async()=>{const draft=await run(false); return submit?run(true):draft;};
  return {execute,prepare:()=>run(false),commit:()=>run(true),document,submissions:()=>submissions,followupExecutions:()=>followupExecutions};
}
test('video recipe fills and verifies the form without ever clicking final confirmation', async()=>{
  const f=fixture();const result=await f.execute();assert.equal(result.submitted,false);assert.equal(result.status,'ready');assert.equal(f.submissions(),0);assert.equal(f.document.querySelector('#height').value,'110');assert.equal(f.document.querySelector('input[placeholder]').value,job.name);
});
test('original route name is accepted when the platform omits its temporary copy suffix',async()=>{const f=fixture({baseRoute:true});assert.equal((await f.execute()).status,'ready');assert.equal(f.submissions(),0)});
test('route suffixes are ignored in the library, selected form and submission checks', async()=>{
  for (const suffix of ['-副本(6)', '-副本(27)', '-新版', '']) {
    const route=PLAN_RECIPE.route+suffix;
    const f=fixture({submit:true,libraryRoute:route,selectedRoute:route,previewRoute:PLAN_RECIPE.route});
    assert.equal((await f.prepare()).status,'ready');assert.equal(f.submissions(),0);
    // The platform may replace the copy number again before submission.
    f.document.querySelector('#selected-route').textContent=PLAN_RECIPE.route+'-副本(100)';
    assert.equal((await f.commit()).status,'submitted');
    assert.equal(f.submissions(),1);
  }
});
test('submission rejects other routes and ambiguous selected prefix matches',async()=>{
  for (const route of ['南侧火点巡查航线', '备份-'+PLAN_RECIPE.route, '东南火点巡查航线（未验证）']) {
    const f=fixture();await f.execute();f.document.querySelector('#selected-route').textContent=route;
    await assert.rejects(f.commit(), /指定航线已变化/);assert.equal(f.submissions(),0);
  }
  const f=fixture();await f.execute();
  f.document.querySelector('#selected-route').innerHTML=`<span>${PLAN_RECIPE.route}-副本(6)</span><span>${PLAN_RECIPE.route}-副本(7)</span>`;
  await assert.rejects(f.commit(), /已选航线不唯一/);assert.equal(f.submissions(),0);
});
test('ambiguous routes, submission controls and rejected height values fail closed',async()=>{
  for(const options of [{ambiguous:true},{confirmOnly:true},{changedHeight:true}]) {const f=fixture(options); await assert.rejects(f.execute());assert.equal(f.submissions(),0)}
});

test('explicit submission accepts only a real mission and clicks exactly once after validation', async () => {
  validateSubmitJob({...job,type:'dji-submit',submit:true});
  for (const change of [{submit:false}, {name:'司空填写演练-20260922-09'}, {eventId:'wrong'}, {type:'dji-prepare'}]) assert.throws(()=>validateSubmitJob({...job,type:'dji-submit',submit:true,...change}));
  const f=fixture({submit:true}); const receipt=await f.execute();
  assert.equal(f.submissions(),1); assert.equal(receipt.status,'submitted'); assert.equal(receipt.submitted,true);
});
test('submission receipt uses the unique plan row even when the device card repeats its name',async()=>{
  const f=fixture({submit:true,deviceCard:true,name:'手动巡查-20261011-14-7393d788'});
  assert.equal((await f.execute()).status,'submitted');
  assert.equal(f.submissions(),1);
});
test('device card alone and duplicate plan rows cannot confirm submission or cause a retry',async()=>{
  for(const receiptRows of [0,2]) {
    const f=fixture({submit:true,deviceCard:true,receiptRows,fastClock:true});
    await assert.rejects(f.execute(),/未收到可核对的计划列表回执/);
    assert.equal(f.submissions(),1);
  }
});
test('real FlightHub weather modal returns its device and wind reason without a second execution', async () => {
  for (const dialogDelay of [0, 50]) {
    const f=fixture({submit:true,dialogDelay,submissionDialog:`<div class="plan-app-ant-modal"><h2>提示</h2><div class="plan-app-ant-modal-body"><p>执行任务不满足天气阻飞设置中的作业要求，是否要继续执行</p><div>执行设备 泰州环境监测 因天气原因：<span>在线天气风速： 12.75m/s</span></div></div><footer><button>取消</button><button>执行</button></footer></div>`});
    await assert.rejects(f.execute(), error => {
      assert.match(error.message,/司空平台天气阻飞/);
      assert.match(error.message,/泰州环境监测/);
      assert.match(error.message,/在线天气风速： 12\.75m\/s/);
      assert.match(error.message,/未继续执行/);
      assert.doesNotMatch(error.message,/\n|未收到可核对/);
      return true;
    });
    assert.equal(f.submissions(),1);assert.equal(f.followupExecutions(),0);
  }
});
test('unknown follow-up confirmation reports its text without treating it as a submitted flight',async()=>{
  const f=fixture({submit:true,submissionDialog:'<div class="plan-app-ant-modal-body">设备存在告警，请核对后执行</div><button>执行</button>'});
  await assert.rejects(f.execute(),/司空平台要求人工确认：设备存在告警/);
  assert.equal(f.submissions(),1);assert.equal(f.followupExecutions(),0);
});
test('submission issue reader ignores hidden dialogs and other projects',()=>{
  const {window,document}=parseHTML('<div role="dialog" hidden><div class="plan-app-ant-modal-body">旧的天气阻飞提示</div></div><div role="dialog"><div class="plan-app-ant-modal-body">因天气原因：在线天气风速： 13.2m/s</div><button>执行</button></div>');
  window.HTMLElement.prototype.getClientRects=function(){return this.hasAttribute('hidden')?[]:[1]};
  const read=url=>runInNewContext(`(${readFlightSubmissionIssue.toString()})(${JSON.stringify(PLAN_URL)})`,{document,location:{href:url},getComputedStyle:()=>({visibility:'visible'})});
  assert.match(read(PLAN_URL+'/create-plan'),/13\.2m\/s/);
  assert.doesNotMatch(read(PLAN_URL+'/create-plan'),/旧的/);
  assert.equal(read('https://fh.dji.com/login'),null);
  assert.equal(read(PLAN_URL.replace('c7ea6bbc','aaaaaaaa')+'/create-plan'),null);
});
test('an existing weather modal stops submission before clicking the plan confirmation',async()=>{
  const f=fixture();await f.prepare();
  const dialog=f.document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<div class="plan-app-ant-modal-body">因天气原因：在线天气风速： 12.75m/s</div><button>执行</button>';
  f.document.body.append(dialog);
  await assert.rejects(f.commit(),/司空平台天气阻飞/);
  assert.equal(f.submissions(),0);
});
test('status polling recovers a matching draft weather reason without submitting or mixing another plan',async()=>{
  const {readFile}=await import('node:fs/promises');
  const worker=await readFile(new URL('../extension/src/service-worker.js',import.meta.url),'utf8');
  const source=worker.slice(worker.indexOf('async function watchFlight(job)'),worker.indexOf('async function heartbeat()'));
  for(const name of [job.name,'其他计划']) {
    const {window,document}=parseHTML(`<input placeholder="请输入计划名称" value="${name}"><div role="dialog"><div class="plan-app-ant-modal-body">执行设备 泰州环境监测 因天气原因：在线天气风速： 12.75m/s</div><button>执行</button></div>`);
    window.HTMLElement.prototype.getClientRects=()=>[1];
    for(const element of document.querySelectorAll('*')) element.click=()=>{throw Error('read-only polling must not click')};
    const stored={[`flight-${job.eventId}`]:42,[`flight-monitor-${job.eventId}`]:43};
    const calls=[];
    const chrome={storage:{local:{get:async key=>({[key]:stored[key]})}},tabs:{get:async id=>({id,status:'complete',url:id===42?PLAN_URL+'/create-plan':PLAN_URL})},debugger:{sendCommand:async(target,method,args)=>{
      calls.push(target.tabId);
      return {result:{value:target.tabId===42?runInNewContext(args.expression,{document,location:{href:PLAN_URL+'/create-plan'},getComputedStyle:()=>({visibility:'visible'})}):{url:PLAN_URL,name:job.name,status:'执行中'}}};
    }}};
    const released=[];
    const debuggerSession={acquire:async()=>true,release:async id=>released.push(id)};
    const execute=runInNewContext(`${source}; watchFlight`,{chrome,debuggerSession,Date,JSON,PLAN_URL,readFlightSubmissionIssue,readFlightStatus,evaluationValue});
    if(name===job.name) {await assert.rejects(execute(job),/在线天气风速： 12\.75m\/s/);assert.deepEqual(calls,[42]);}
    else {assert.equal((await execute(job)).status,'执行中');assert.deepEqual(calls,[42,43]);}
    assert.deepEqual(released,calls);
  }
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
    const stored={[`flight-${job.eventId}`]:42,[`flight-review-${job.eventId}`]:{tabId:42,startedAt:Date.now()-31000,canceled:false}};let evaluations=0;
    const chrome={storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,stored[k]])),set:async values=>Object.assign(stored,values)}},tabs:{get:async()=>({id:42,url:PLAN_URL+'/create-plan'}),update:async()=>{},sendMessage:async()=>({ok:true})},debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async()=>{
      assert.ok(stored[`flight-submit-${job.eventId}`]);evaluations++;
      if(loseReceipt)throw Error('receipt lost');
      return {status:'submitted',submitted:true,name:job.name,url:PLAN_URL};
    }}};
    const debuggerSession={acquire:async tabId=>{await chrome.debugger.attach({tabId},'1.3');return true},release:async(tabId,attached)=>{if(attached)await chrome.debugger.detach({tabId})}};
    const execute=runInNewContext(`let capturing=false; ${source}; submitFlight`,{chrome,debuggerSession,Date,JSON,PLAN_URL,PLAN_RECIPE,validateSubmitJob,fillFlightPlan,readFlightSubmissionIssue,evaluationValue:v=>v});
    if(loseReceipt)await assert.rejects(execute(submittedJob),/receipt lost/);else await execute(submittedJob);
    await assert.rejects(execute(submittedJob),/禁止重复提交/);assert.equal(evaluations,1);
  }
});

test('a canceled browser review cannot reach the final confirmation', async()=>{
  const { readFile }=await import('node:fs/promises');
  const worker=await readFile(new URL('../extension/src/service-worker.js',import.meta.url),'utf8');
  const source=worker.slice(worker.indexOf('async function submitFlight(job)'),worker.indexOf('async function openPreparedFlight(job)'));
  const stored={
    [`flight-${job.eventId}`]:42,
    [`flight-review-${job.eventId}`]:{tabId:42,startedAt:Date.now()-31000,canceled:true},
  };
  let evaluations=0;
  const chrome={
    storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,stored[k]])),set:async values=>Object.assign(stored,values)}},
    tabs:{get:async()=>({id:42,url:PLAN_URL+'/create-plan'}),update:async()=>{},sendMessage:async()=>({ok:true})},
    debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async()=>{evaluations++;throw Error('must not submit')}},
  };
  const debuggerSession={acquire:async tabId=>{await chrome.debugger.attach({tabId},'1.3');return true},release:async(tabId,attached)=>{if(attached)await chrome.debugger.detach({tabId})}};
  const execute=runInNewContext(`let capturing=false; ${source}; submitFlight`,{chrome,debuggerSession,Date,JSON,PLAN_URL,PLAN_RECIPE,validateSubmitJob,fillFlightPlan,readFlightSubmissionIssue,evaluationValue:v=>v});
  await assert.rejects(execute({...job,type:'dji-submit',submit:true}),/已取消/);
  assert.equal(evaluations,0);
});

test('a missing review panel cannot reach the final confirmation', async()=>{
  const { readFile }=await import('node:fs/promises');
  const worker=await readFile(new URL('../extension/src/service-worker.js',import.meta.url),'utf8');
  const source=worker.slice(worker.indexOf('async function submitFlight(job)'),worker.indexOf('async function openPreparedFlight(job)'));
  const stored={
    [`flight-${job.eventId}`]:42,
    [`flight-review-${job.eventId}`]:{tabId:42,startedAt:Date.now()-31000,canceled:false},
  };
  let evaluations=0;
  const chrome={
    storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,stored[k]])),set:async values=>Object.assign(stored,values)}},
    tabs:{get:async()=>({id:42,url:PLAN_URL+'/create-plan'}),update:async()=>{},sendMessage:async(_tab,message)=>({ok:message.type==='flight.review.close'})},
    debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async()=>{evaluations++;throw Error('must not submit')}},
  };
  const debuggerSession={acquire:async tabId=>{await chrome.debugger.attach({tabId},'1.3');return true},release:async(tabId,attached)=>{if(attached)await chrome.debugger.detach({tabId})}};
  const execute=runInNewContext(`let capturing=false; ${source}; submitFlight`,{chrome,debuggerSession,Date,JSON,PLAN_URL,PLAN_RECIPE,validateSubmitJob,fillFlightPlan,readFlightSubmissionIssue,evaluationValue:v=>v});
  await assert.rejects(execute({...job,type:'dji-submit',submit:true}),/面板已消失/);
  assert.equal(evaluations,0);
  assert.equal(stored[`flight-submit-${job.eventId}`],undefined);
});
