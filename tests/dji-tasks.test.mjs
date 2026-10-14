import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readDjiTasks } from '../extension/src/dji-tasks.js';
import { PLAN_URL } from '../extension/src/flight-plan.js';
const project = 'c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
const row = (id, extra = {}) => ({ uuid: `00000000-0000-4000-8000-${String(id).padStart(12,'0')}`, prj_uuid: project, sn: 'AHRXNBN00A029A', name: `巡查-${id}`, status: 5,
  begin_at: '2026-09-22T01:00:00Z', run_at: '2026-09-22T01:00:08Z', completed_at: '2026-09-22T01:25:01Z', folder_id: id + 100, folder_info: { expected_file_count: 4, uploaded_file_count: 4 }, media_upload_status: 2, ...extra });
function fixture({ total = 476, map = x => x, failurePage = 0, code = 0, token = 'fixture-user', auth = 'fixture-auth' } = {}) {
  const requests = [];
  const location = new URL(PLAN_URL.replace('#/plan', '#/team'));
  const context = { location, URLSearchParams, AbortSignal, localStorage: {getItem:k=>k==='x-user-token'?token:auth}, fetch: async (url, options) => {
    const u = new URL(url), page = Number(u.searchParams.get('page'));
    requests.push({url,options,page});
    assert.equal(u.origin, 'https://es-flight-api-cn.djigate.com');
    assert.equal(u.pathname, `/task/api/v2/workspaces/${project}/flight-tasks`);
    assert.equal(u.searchParams.get('page_size'), '50');
    assert.equal(u.searchParams.get('flight_task_status'), '2');
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    if (page === failurePage) throw Error('untrusted upstream text');
    return {ok:true,json:async()=>({code,data: {list:Array.from({length:Math.max(0,Math.min(50,total-(page-1)*50))},(_,i)=>map(row((page-1)*50+i+1))),pagination:{page,page_size:50,total}}})};
  }};
  return { requests, location, run: options => vm.runInNewContext(`(${readDjiTasks.toString()})(${JSON.stringify(location.href)}, ${JSON.stringify(options || {})})`, context) };
}
test('reads all 476 records over bounded API pages without a DOM or navigation', async () => {
  const f = fixture(); const before = f.location.href; const tasks = new Map(); let cursor = null, rounds = 0;
  do {
    const result = await f.run({cursor,includeHistory:true});
    for(const task of result.tasks)tasks.set(task.taskId,task);
    cursor=result.cursor;rounds++;
    assert.equal(result.historyError,null); assert.equal(result.skipped,0);
    if(!cursor)assert.equal(result.historyComplete,true);
  } while(cursor && rounds<10);
  assert.equal(rounds,2);assert.equal(tasks.size,476);assert.equal(f.location.href,before);
  assert.deepEqual(f.requests.map(r=>r.page),[1,2,3,4,5,6,1,7,8,9,10]);
  assert.equal([...tasks.values()][0].mission.startTime,Date.parse('2026-09-22T01:00:00Z'));
});
test('refreshes latest tasks independently and upgrades an old DOM cursor safely', async () => {
  const f=fixture(); const r=await f.run({includeHistory:false,cursor:null});
  assert.equal(f.requests.length,1);assert.equal(r.historyComplete,false);
  await f.run({includeHistory:true,cursor:{after:'old-page-signature'}});
  assert.equal(f.requests[2].page,2);
});
test('failed history keeps the uncommitted page for retry and retains fresh data',async()=>{
  const f=fixture({failurePage:3});const r=await f.run();
  assert.equal(r.tasks.length,100);assert.equal(r.cursor.page,3);assert.equal(r.historyComplete,false);
  assert.match(r.historyError,/接口暂时无法连接/);assert.doesNotMatch(r.historyError,/untrusted/);
});
test('retains failed flights without fabricating their actual finish time or generating reports',async()=>{
  const f=fixture({total:1,map:r=>({...r,status:1,completed_at:null,folder_id:0,folder_info:null,media_upload_status:0})});
  const r=await f.run();assert.equal(r.tasks.length,1);const t=r.tasks[0];
  assert.equal(t.actualTimeMissing,true);assert.equal(t.mission.endTime,0);assert.equal(t.mediaReady,false);assert.equal(t.noMedia,true);
  assert.equal(t.status,'执行失败');assert.ok(t.plannedStartTime>0);assert.equal(r.skipped,0);
});
test('requires real media readiness and supports fixed auth fallback',async()=>{
  const f=fixture({total:1,token:null,map:r=>({...r,media_upload_status:1,folder_info:{expected_file_count:10,uploaded_file_count:2}})});
  const r=await f.run();assert.equal(r.tasks[0].mediaReady,false);assert.equal(r.tasks[0].mediaFolderId,101);
  assert.equal(f.requests[0].options.headers['X-Auth-Token'],'fixture-auth');
  assert.equal(JSON.stringify(r).includes('fixture-auth'),false);
});
test('rejects wrong project, missing login, invalid task identity and failed business receipts',async()=>{
  const bad=fixture();bad.location.pathname='/wrong-project';await assert.rejects(bad.run(),/项目不匹配/);assert.equal(bad.requests.length,0);
  await assert.rejects(fixture({token:null,auth:null}).run(),/登录/);
  await assert.rejects(fixture({code:200401}).run(),/登录已过期/);
  await assert.rejects(fixture({total:1,map:r=>({...r,prj_uuid:'other'})}).run(),/身份/);
});
test('worker reuses existing project and media tabs without opening/reloading history pages',async()=>{
  const source=await readFile(new URL('../extension/src/service-worker.js',import.meta.url),'utf8');
  const sync=source.slice(source.indexOf('async function syncDjiTasks('),source.indexOf('async function bridgeTabs('));
  const tabs=[{id:1,url:PLAN_URL.replace('#/plan','#/team'),status:'complete',active:true},{id:2,url:PLAN_URL.replace('#/plan','#/media?page=1&size=50'),status:'complete'},{id:3,url:PLAN_URL,status:'complete',active:false},{id:4,url:PLAN_URL,status:'complete',active:true}];
  const stored={'flight-task-history-tab':3,'flight-task-sync-tab':4};const removed=[];let creates=0;
  const context=vm.createContext({PLAN_URL,readDjiTasks, evaluationValue:r=>r.result.value,debuggerSession:{acquire:async()=>true,release:async()=>{}},chrome:{debugger:{sendCommand:async()=>({result:{value:{url:PLAN_URL,tasks:[],cursor:null}}})},tabs:{query:async()=>tabs,get:async id=>tabs.find(t=>t.id===id),create:async()=>{creates++;throw Error('unexpected tab')},remove:async ids=>removed.push(...ids)},storage:{local:{get:async()=>stored,set:async v=>Object.assign(stored,v),remove:async keys=>keys.forEach(k=>delete stored[k])}}}});
  vm.runInContext(sync,context);for(let i=0;i<3;i++)await vm.runInContext('syncDjiTasks({includeHistory:true,cursor:null})',context);
  assert.equal(creates,0);assert.deepEqual(removed,[3]);assert.equal(stored['flight-report-media-tab'],2);
});

test('restarts history if new executions shift the pagination total', async()=>{
 const f=fixture({total:477});const r=await f.run({includeHistory:true,cursor:{apiVersion:1,page:7,total:476}});
 assert.equal(f.requests[1].page,2);assert.equal(r.cursor.total,477);
});
