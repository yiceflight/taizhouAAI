import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {airinsReport,djiReport,validatePhotoName} from '../extension/src/flight-report.js';
const start=Date.parse('2026-09-22T07:01:20+08:00'),end=Date.parse('2026-09-22T07:22:08+08:00');
test('photo matching uses Beijing capture date and rejects another flight',()=>{
 assert.equal(validatePhotoName('DJI_20260922071701_0002_V.jpeg',start,end),Date.parse('2026-09-22T07:17:01+08:00'));
 assert.throws(()=>validatePhotoName('DJI_20260921071701_0002_V.jpeg',start,end));assert.throws(()=>validatePhotoName('photo.jpeg',start,end));
});
test('Airins reads full raw samples with no filters and preserves zero/missing',async()=>{
 const requests=[];const sandbox={location:{origin:'https://aai.airins.cn',pathname:'/sniff/HistoryCloud',href:'https://aai.airins.cn/sniff/HistoryCloud'},AbortSignal,fetch:async(url,options)=>{requests.push({url,options});return{ok:true,json:async()=>({isSuccess:true,data:{missionNum:3,positions:[[119.9,32.4],[119.8,32.3],[119.7,32.2]],missionData:{ts:[start,start+1000,start+2000],ad_9:[0,null,65],ad_6:[0.076,null,0.1],ad_4:[0,0.014,0.01],ad_5:[0,0,0],ad_10:[1,2,66],ad_7:[0.9,0.8,0.7]}}})};}};
 const result=await vm.runInNewContext(`(${airinsReport.toString()})({type:'flight-airins',missionId:123})`,sandbox);
 assert.deepEqual(JSON.parse(requests[0].options.body),{missionId:123,filteringParams:[]});assert.equal(result.points[0].pm25,0);assert.equal(result.points[1].pm25,null);assert.equal(result.points[2].pm25,65);assert.equal(result.unit,'μg/m³');assert.equal(result.points[0].longitude,119.9);assert.equal(result.channels.no2.values[0],0.076);assert.equal(result.channels.no2.values[1],null);assert.equal(result.channels.so2.values[0],0);assert.equal(result.channels.co.unit,'ppm');assert.equal(result.channels.pm10.sourceChannel,'ad_10');assert.equal(result.channels.o3,undefined);
});
test('Airins rejects inconsistent point counts and wrong origin',async()=>{
 const sandbox={location:{origin:'https://aai.airins.cn',pathname:'/sniff/HistoryCloud'},AbortSignal,fetch:async()=>({ok:true,json:async()=>({isSuccess:true,data:{missionNum:3,positions:[],missionData:{ts:[start],ad_9:[65]}}})})};
 await assert.rejects(vm.runInNewContext(`(${airinsReport.toString()})({type:'flight-airins',missionId:123})`,sandbox),/不完整/);
 sandbox.location.origin='https://evil.test';await assert.rejects(vm.runInNewContext(`(${airinsReport.toString()})({})`,sandbox),/登录/);
});
test('DJI requires exact project and Immediate-Media, refuses filtered or paginated omissions',async()=>{
 const {document}=parseHTML('<div class="ant-breadcrumb">媒体文件 每日7时 2026-09-22 07:00:05 Immediate-Media</div><table><tbody><tr><td><span>DJI_20260922071701_0002_V.jpeg</span></td></tr></tbody></table><input placeholder="按文件名称搜索">');
 for(const e of document.querySelectorAll('*'))e.getClientRects=()=>[{}];
 const location={origin:'https://fh.dji.com',pathname:'/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49',hash:'#/media?page=1',href:'https://fh.dji.com/#/media?page=1'};
 const run=()=>vm.runInNewContext(`(${djiReport.toString()})({type:'flight-dji-list'})`,{document,location,URLSearchParams});
 const result=await run();assert.equal(result.files.length,1);document.querySelector('input').value='DJI';await assert.rejects(run(),/清空/);document.querySelector('input').value='';document.body.appendChild(document.createElement('div')).className='ant-pagination-next';await assert.rejects(run(),/超过一页/);location.pathname='/other';await assert.rejects(run(),/泰州项目/);
});
for (const rootFolderId of [undefined, 123]) test(`DJI downloads full-size photos from ${rootFolderId ? 'task root' : 'Immediate-Media'}, never thumbnails`,async()=>{
 const name='DJI_20260922071701_0002_V.jpeg';
 const {document}=parseHTML(`<div id="disk-app"></div><div class="ant-breadcrumb">媒体文件 每日7时 2026-09-22 07:00:05 Immediate-Media</div><table><tbody><tr><td><span>${name}</span></td></tr></tbody></table>`);
 for(const e of document.querySelectorAll('*'))e.getClientRects=()=>[{}];
 let clicks=0,requests=0;
 document.querySelector('span').click=()=>{clicks++;document.querySelector('#disk-app')._vnode={component:{subTree:{children:[{component:{props:{previewItemProp:{name,url:'https://media.dji.example/original.jpeg',ext:{width:3840,height:2160}}}}}]}}};};
 if (rootFolderId) document.querySelector('.ant-breadcrumb').textContent = '媒体文件 每日7时 2026-09-22 07:00:05';
 const location={origin:'https://fh.dji.com',pathname:'/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49',hash:'#/media?page=1&pid=123',href:'https://fh.dji.com/#/media?page=1&pid=123'};
 let inspections=0;
 const inspectPresentation=async()=>{inspections++;return {signature:'stable',annotationCount:2};};
 const sandbox={document,location,URLSearchParams,inspectPresentation,AbortSignal,Blob,Uint8Array,setTimeout:fn=>fn(),fetch:async url=>{requests++;assert.equal(url,'https://media.dji.example/original.jpeg');return{ok:true,blob:async()=>new Blob([new Uint8Array([255,216,255,0])])};},createImageBitmap:async()=>({width:3840,height:2160,close(){}}),FileReader:class{readAsDataURL(){this.result='data:image/jpeg;base64,/9j/AA==';this.onload();}}};
 const result=await vm.runInNewContext(`(${djiReport.toString()})(${JSON.stringify({type:'flight-dji-image',name,rootFolderId})},inspectPresentation)`,sandbox);
 assert.equal(inspections,4);assert.equal(result.capturePlan.annotationCount,2);assert.equal(clicks,1);assert.equal(requests,1);assert.equal(result.kind,'司空原始照片');assert.equal(result.name,name);assert(!JSON.stringify(result).includes('media.dji.example'));
 sandbox.createImageBitmap=async()=>({width:200,height:113,close(){}});
 await assert.rejects(vm.runInNewContext(`(${djiReport.toString()})(${JSON.stringify({type:'flight-dji-image',name,rootFolderId})},inspectPresentation)`,sandbox),/缩略图/);
});

function autoMediaFixture({ pages, folderPhotos = ['DJI_20260922071701_0002_V.jpeg'], immediate = true, initialFolder = false, photoPages, folderId, rootPages, rootTotal, normalizeRoute = false }) {
 const {document} = parseHTML('<html><body><div class="ant-breadcrumb"></div><table><thead><tr><th></th></tr></thead><tbody></tbody></table></body></html>');
 const project = '/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49';
 let hash = '', opened = [], taskName = '';
 const showPhotos = page => {
  show(`媒体文件 / ${taskName} / Immediate-Media`, photoPages[page - 1] || [], () => {});
  let next = document.querySelector('.ant-pagination-next');
  if (!next) { next = document.createElement('li'); next.className = 'ant-pagination-next'; document.body.appendChild(next); }
  next.setAttribute('aria-disabled', String(page >= photoPages.length));
 };
 const total = pages.reduce((count, names) => count + names.length, 0);
 const show = (folder, names, onClick) => {
  document.querySelector('.ant-breadcrumb').textContent = folder;
  document.querySelector('th').textContent = `名称 (0/${folder === '媒体文件' ? total : names.length})`;
  document.querySelector('tbody').innerHTML = names.length ? names.map(name => `<tr><td><span>${name}</span></td></tr>`).join('') : '<tr><td>暂无数据</td></tr>';
  for(const e of document.querySelectorAll('*')) e.getClientRects = () => [{}];
  for(const e of document.querySelectorAll('tbody span')) e.click = () => onClick(e.textContent);
 };
 const showRoot = (name, page) => {
  show(`媒体文件 / ${name}`, rootPages[page - 1] || [], () => {});
  document.querySelector('th').textContent = `名称 (0/${rootTotal ?? rootPages.flat().length})`;
  let next = document.querySelector('.ant-pagination-next');
  if (!next) { next = document.createElement('li'); next.className = 'ant-pagination-next'; document.body.appendChild(next); }
  next.setAttribute('aria-disabled', String(page >= rootPages.length));
 };
 const openTask = (name, page = 1) => {
  opened.push(name); hash = '#/media?page=1&size=50&pid=task';
  if (rootPages) { showRoot(name, page); return; }
  show(`媒体文件 / ${name}`, immediate ? ['Immediate-Media'] : ['video.mp4'], () => {
   hash = '#/media?page=1&size=50&pid=photos';
   taskName = name;
   if (photoPages) showPhotos(1); else show(`媒体文件 / ${name} / Immediate-Media`, folderPhotos, () => {});
  });
 };
 const location = {origin:'https://fh.dji.com',pathname:project, get href(){return this.origin+this.pathname+hash;},get hash(){return hash;},set hash(value){const params = new URLSearchParams(value.split('?')[1]); const normalized = normalizeRoute ? `#/media?${[...params.entries()].reverse().map(([key, item]) => `${key}=${item}`).join('&')}` : value; hash = normalized; const page = Number(params.get('page')); if (folderId && params.get('pid') === String(folderId)) { openTask('接口确认的航次', page); hash = normalized; } else if (params.get('pid') === 'photos' && photoPages) showPhotos(page); else show('媒体文件',pages[page-1] || [],openTask);}};
 location.hash = '#/media?page=1&size=50';
 if(initialFolder){ hash='#/media?page=1&size=50&pid=wrong'; show('媒体文件 / 旧航次 / Immediate-Media',['DJI_20260921071701_0002_V.jpeg'],()=>{}); }
 const run = () => vm.runInNewContext(`(${djiReport.toString()})(${JSON.stringify({type:'flight-dji-list',startTime:start,endTime:end,folderId})})`,{document,location,URLSearchParams,setTimeout:fn=>fn()});
 return {run,opened,document};
}
test('DJI matches the unique Beijing start time across pages and navigates from another flight', async()=>{
 const fixture=autoMediaFixture({initialFolder:true,pages:[['旧任务 2026-09-21 07:00:05 (UTC+08)'],['每日7时 2026-09-22 07:00:05 (UTC+08)']]});
 const result=await fixture.run();
 assert.deepEqual(fixture.opened,['每日7时 2026-09-22 07:00:05 (UTC+08)']);
 assert.equal(result.matchedStartTime,start);
 assert.equal(result.files.length,1);
 assert.match(result.folder,/2026-09-22 07:00:05.*Immediate-Media/);
});
test('DJI accepts hash-router query normalization while switching media pages', async()=>{
 const fixture=autoMediaFixture({initialFolder:true,normalizeRoute:true,pages:[['每日7时 2026-09-22 07:00:05 (UTC+08)']]});
 const result=await fixture.run();
 assert.equal(result.files.length,1);
 assert.match(result.folder,/Immediate-Media$/);
});
test('DJI refuses ambiguous candidates even when they occur on different pages', async()=>{
 const fixture=autoMediaFixture({pages:[['任务A 2026-09-22 07:00:05 (UTC+08)'],['任务B 2026-09-22 07:02:05 (UTC+08)']]});
 await assert.rejects(fixture.run(),/多个司空航次/);assert.equal(fixture.opened.length,0);
});
test('DJI does not choose the nearest flight outside the tolerance or infer time from creation column', async()=>{
 const fixture=autoMediaFixture({pages:[['另一天任务 2026-09-21 07:00:05 (UTC+08)']]});
 fixture.document.querySelector('tbody tr').innerHTML += '<td>2026-09-22 07:01:20</td>';
 await assert.rejects(fixture.run(),/未找到开始时间/);assert.equal(fixture.opened.length,0);
});
test('DJI distinguishes missing photo folder from a confirmed empty photo folder', async()=>{
 const pages=[['每日7时 2026-09-22 07:00:05 (UTC+08)']];
 await assert.rejects(autoMediaFixture({pages,immediate:false}).run(),/司空媒体解析失败：缺少航次目录编号/);
 assert.equal((await autoMediaFixture({pages,folderPhotos:[]}).run()).files.length, 0);
});

test('DJI inventories every photo page and records the download page without truncation', async () => {
 const names = Array.from({ length: 52 }, (_, i) => `DJI_20260922071701_${String(i).padStart(4, '0')}_V.jpeg`);
 const result = await autoMediaFixture({ pages: [['每日7时 2026-09-22 07:00:05 (UTC+08)']], photoPages: [names.slice(0, 50), names.slice(50)] }).run();
 assert.equal(result.files.length, 52);
 assert.equal(result.filePages[names[0]], 1);
 assert.equal(result.filePages[names[51]], 2);
});

test('DJI opens the API-confirmed task folder directly without scanning unrelated flights', async () => {
 const fixture=autoMediaFixture({pages:[['相近但错误的任务 2026-09-22 07:00:05 (UTC+08)']],folderId:350521756});
 const result=await fixture.run();
 assert.deepEqual(fixture.opened,['接口确认的航次']);
 assert.equal(result.matchedTaskFolderId,350521756);
 assert.equal(result.files.length,1);
});

// Optional gases must be aligned, numeric, and use the dedicated ozone channel.
test('Airins rejects corrupt gas arrays and never substitutes Ox for ozone', async()=>{
 const data={missionNum:2,positions:[[119,32],[119,32]],missionData:{ts:[start,start+1000],ad_9:[60,59],ad_80:[0.01,null]}};
 const sandbox={location:{origin:'https://aai.airins.cn',pathname:'/sniff/HistoryCloud'},AbortSignal,fetch:async()=>({ok:true,json:async()=>({isSuccess:true,data})})};
 const run=()=>vm.runInNewContext(`(${airinsReport.toString()})({missionId:123})`,sandbox);
 assert.equal((await run()).channels.o3.sourceChannel,'ad_80');
 for(const bad of [[1], [1,'2'], [1,-1], [1,Infinity]]) {data.missionData.ad_80=bad;await assert.rejects(run(),/通道数据/);}
});

const rootPhoto = 'DJI_20260922071701_0002_V.jpeg';
const rootVideo = 'DJI_20260922071701_0001_V.mp4';
const rootFixture = options => autoMediaFixture({pages: [[]], folderId: 359292376, immediate: false, ...options});
test('DJI reads direct task-root photos mixed with videos and preserves folder identity', async () => {
 const result = await rootFixture({rootPages: [[rootPhoto, rootVideo]]}).run();
 assert.deepEqual([...result.files], [rootPhoto]);
 assert.equal(result.rootFolderId, 359292376);
 assert.equal(result.matchedTaskFolderId, 359292376);
});
test('DJI proves video-only only after a complete multipage inventory', async () => {
 const videos = Array.from({length: 52}, (_, i) => `DJI_20260922071701_${String(i).padStart(4, '0')}_V.mp4`);
 const empty = await rootFixture({rootPages: [videos.slice(0, 50), videos.slice(50)]}).run();
 assert.equal(empty.files.length, 0);
 assert.equal(empty.rootFolderId, 359292376);
 const result = await rootFixture({rootPages: [videos.slice(0, 50), [rootPhoto]]}).run();
 assert.deepEqual([...result.files], [rootPhoto]);
 assert.equal(result.filePages[rootPhoto], 2);
});
test('DJI never treats missing, unknown, duplicated or incomplete root media as no photos', async () => {
 for (const options of [
  {rootPages: [[rootVideo]], rootTotal: 2},
  {rootPages: [[rootVideo, 'Other-Photos']]},
  {rootPages: [[rootVideo, 'picture.jpeg']]},
  {rootPages: [[rootVideo], [rootVideo]]},
  {rootPages: [[]], rootTotal: 1},
 ]) await assert.rejects(rootFixture(options).run(), /司空媒体解析失败/);
});

test('DJI accepts a confirmed empty task root for a zero-issue report', async () => {
 const result = await rootFixture({rootPages: [[]]}).run();
 assert.equal(result.files.length, 0);
 assert.equal(result.rootFolderId, 359292376);
});
