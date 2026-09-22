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
 const requests=[];const sandbox={location:{origin:'https://aai.airins.cn',pathname:'/sniff/HistoryCloud',href:'https://aai.airins.cn/sniff/HistoryCloud'},AbortSignal,fetch:async(url,options)=>{requests.push({url,options});return{ok:true,json:async()=>({isSuccess:true,data:{missionNum:3,positions:[[119.9,32.4],[119.8,32.3],[119.7,32.2]],missionData:{ts:[start,start+1000,start+2000],ad_9:[0,null,65],ad_6:[0.076,0.079,0.1]}}})};}};
 const result=await vm.runInNewContext(`(${airinsReport.toString()})({type:'flight-airins',missionId:123})`,sandbox);
 assert.deepEqual(JSON.parse(requests[0].options.body),{missionId:123,filteringParams:[]});assert.equal(result.points[0].pm25,0);assert.equal(result.points[1].pm25,null);assert.equal(result.points[2].pm25,65);assert.equal(result.unit,'μg/m³');assert.equal(result.points[0].longitude,119.9);assert(!JSON.stringify(result).includes('0.076'));
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
 const run=()=>vm.runInNewContext(`(${djiReport.toString()})({type:'flight-dji-list'})`,{document,location});
 const result=await run();assert.equal(result.files.length,1);document.querySelector('input').value='DJI';await assert.rejects(run(),/清空/);document.querySelector('input').value='';document.body.appendChild(document.createElement('div')).className='ant-pagination-next';await assert.rejects(run(),/超过一页/);location.pathname='/other';await assert.rejects(run(),/泰州项目/);
});
test('DJI opens the selected photo with click and downloads its full-size record, never a thumbnail',async()=>{
 const name='DJI_20260922071701_0002_V.jpeg';
 const {document}=parseHTML(`<div id="disk-app"></div><div class="ant-breadcrumb">媒体文件 每日7时 2026-09-22 07:00:05 Immediate-Media</div><table><tbody><tr><td><span>${name}</span></td></tr></tbody></table>`);
 for(const e of document.querySelectorAll('*'))e.getClientRects=()=>[{}];
 let clicks=0,requests=0;
 document.querySelector('span').click=()=>{clicks++;document.querySelector('#disk-app')._vnode={component:{subTree:{children:[{component:{props:{previewItemProp:{name,url:'https://media.dji.example/original.jpeg',ext:{width:3840,height:2160}}}}}]}}};};
 const location={origin:'https://fh.dji.com',pathname:'/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49',hash:'#/media?page=1',href:'https://fh.dji.com/#/media?page=1'};
 const sandbox={document,location,AbortSignal,Blob,Uint8Array,setTimeout:fn=>fn(),fetch:async url=>{requests++;assert.equal(url,'https://media.dji.example/original.jpeg');return{ok:true,blob:async()=>new Blob([new Uint8Array([255,216,255,0])])};},createImageBitmap:async()=>({width:3840,height:2160,close(){}}),FileReader:class{readAsDataURL(){this.result='data:image/jpeg;base64,/9j/AA==';this.onload();}}};
 const result=await vm.runInNewContext(`(${djiReport.toString()})(${JSON.stringify({type:'flight-dji-image',name})})`,sandbox);
 assert.equal(clicks,1);assert.equal(requests,1);assert.equal(result.kind,'司空原始照片');assert.equal(result.name,name);assert(!JSON.stringify(result).includes('media.dji.example'));
 sandbox.createImageBitmap=async()=>({width:200,height:113,close(){}});
 await assert.rejects(vm.runInNewContext(`(${djiReport.toString()})(${JSON.stringify({type:'flight-dji-image',name})})`,sandbox),/缩略图/);
});
