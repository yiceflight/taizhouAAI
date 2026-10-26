import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { djiPhotoPresentation, captureDjiPresentation, normalizeDjiCapture } from '../extension/src/dji-photo-presentation.js';

const name = 'DJI_20261025171044_0005_T.jpeg';
const job = { name, width: 1280, height: 1024 };
const uuid = () => 'd42e09b1-8080-4bcd-9345-1a52018da631';
const box = (x, y, width, height) => ({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height});
function fixture() {
  const { document } = parseHTML(`<html><body><div class="banner">promotion</div><main><div class="show-area"><div class="detail-content"><div class="photo-name">${name.replace('.jpeg','')}</div><div class="view"><div class="photo-wrapper"><div class="viewer-js-container"><div class="viewer-canvas"><img src="https://assets.example/photo.jpeg"></div><div class="viewer-footer">controls</div></div><div class="doodle-mark-operations">buttons</div><div class="doodle-list-container"><div class="wrapper"><div class="point-icon"></div><div class="text">最高温度: 76.7℃</div></div><div class="wrapper"><div class="point-icon"></div><div class="text">最低温度: -2.5℃</div></div></div><div class="hotspot-wrapper"><div class="uranus-hot-spot-container-wrapper"></div></div></div></div></div><aside class="detail-desc-tag-row"><span class="tag-sum">2</span></aside></div></main></body></html>`);
  const baseBoxes = new Map();
  const transformed = rect => {
    const m=document.querySelector('.photo-wrapper').style.transform?.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/);
    if(!m)return rect;
    return box(Number(m[1])+rect.x*Number(m[3]),Number(m[2])+rect.y*Number(m[3]),rect.width*Number(m[3]),rect.height*Number(m[3]));
  };
  const setBox = (el, rect) => {baseBoxes.set(el,rect);el.getBoundingClientRect=()=>transformed(baseBoxes.get(el));};
  for (const el of document.querySelectorAll('*')) {
    el.getClientRects = () => [{}];
    setBox(el,box(120,20,20,20));
    // linkedom has no CSS priority API.
    el.style.getPropertyPriority = () => '';
  }
  const img = document.querySelector('img');
  Object.assign(img, { complete:true, naturalWidth:1280, naturalHeight:1024 });
  setBox(img,box(100,0,1000,800));
  setBox(document.querySelector('.photo-wrapper'),box(0,0,1200,800));
  const getComputedStyle = el => ({ display:el.style.display || 'block', visibility:el.style.visibility || 'visible', opacity:el.style.opacity || '1', color:'black' });
  const context = vm.createContext({document,getComputedStyle,innerWidth:1600,innerHeight:900,scrollX:0,scrollY:0,devicePixelRatio:2,TextEncoder,crypto:webcrypto});
  const run = override => vm.runInContext(`(${djiPhotoPresentation.toString()})(${JSON.stringify({...job,...override})})`,context);
  return {document, img, run, context, setBox};
}
function png(width=1280,height=1024) {
  const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a0000000d49484452','hex').copy(bytes);
  bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes.toString('base64');
}
test('binds exact full photo, retains temperatures and leaves pixel-ratio calibration to the screenshot', async () => {
  const f=fixture(), plan=await f.run();
  assert.equal(plan.annotationCount,2);
  assert.deepEqual([...plan.labels],['最高温度: 76.7℃','最低温度: -2.5℃']);
  assert.equal(plan.clip.scale,1);
  assert(!JSON.stringify(plan).includes('assets.example'));
  f.document.querySelector('.photo-name').textContent='other';
  await assert.rejects(f.run(),/当前文件/);
});
test('rejects missing counts, hidden markers and unloaded or zoomed images', async () => {
  for (const [change, error] of [
    [f=>f.document.querySelector('.detail-desc-tag-row').remove(),/标注数量/],
    [f=>f.document.querySelector('.tag-sum').textContent='3',/数量/],
    [f=>f.document.querySelector('.wrapper').style.opacity='0',/数量/],
    [f=>f.document.querySelector('.doodle-list-container').style.visibility='hidden',/数量|隐藏/],
    [f=>f.img.naturalWidth=200,/完整尺寸/],
    [f=>f.img.complete=false,/加载/],
    [f=>f.img.getBoundingClientRect=()=>box(-100,0,1000,800),/裁切/],
  ]) { const f=fixture(); change(f); await assert.rejects(f.run(),error); }
});
test('preparation hides overlapping UI, preserves every annotation and restores original visibility', async () => {
  const f=fixture(), plan=await f.run(), banner=f.document.querySelector('.banner');
  banner.style.visibility='visible';
  await f.run({...plan,phase:'prepare',captureId:uuid()});
  assert.equal(banner.style.visibility,'hidden');
  assert.equal(f.document.querySelector('.photo-name').style.visibility,'hidden');
  assert.equal(f.document.querySelector('.viewer-footer').style.visibility,'hidden');
  assert.equal((await f.run({...plan,phase:'inspect'})).signature,plan.signature);
  await f.run({phase:'restore',captureId:uuid()});
  assert.equal(banner.style.visibility,'visible');
  assert.equal(f.document.querySelectorAll('[data-taizhou-photo-capture]').length,0);
});
async function captureFixture({screenshot=png(),fail=false,change=false,hang=false,normalize,configure}={}) {
  const f=fixture();configure?.(f);const plan=await f.run(), calls=[], clips=[];
  const api={sendCommand:async (_target,method,params)=>{
    calls.push(method);
    if(method==='Runtime.evaluate') {
      try {return {result:{value:await vm.runInContext(params.expression,f.context)}};}
      catch(e){return {exceptionDetails:{exception:{description:e.message}}};}
    }
    if(method==='Page.captureScreenshot') {
      clips.push(params.clip);
      if(hang)return new Promise(()=>{});
      if(fail)throw Error('capture failed');
      if(change)f.document.querySelector('.text').textContent='最高温度: 99℃';
      return {data:typeof screenshot==='function'?screenshot({plan}):Array.isArray(screenshot)?screenshot.shift():screenshot};
    }
    return {};
  }};
  return {f, plan, calls, clips, run:()=>captureDjiPresentation(api,1,job,plan,djiPhotoPresentation,uuid,30,normalize)};
}
test('worker captures exact PNG and restores UI on success', async () => {
  const c=await captureFixture(), result=await c.run();
  assert.equal(result.dataUrl,`data:image/png;base64,${png()}`);
  assert.equal(result.annotationCount,2);
  assert.equal(c.f.document.querySelectorAll('[data-taizhou-photo-capture]').length,0);
});
test('capture, geometry, changing annotations and timeout failures never fall back to raw image', async () => {
  for(const opts of [{fail:true},{screenshot:png(640,512)},{change:true},{hang:true},{screenshot:'bad'}]) {
    const c=await captureFixture(opts);
    await assert.rejects(c.run());
    assert.equal(c.f.document.querySelectorAll('[data-taizhou-photo-capture]').length,0);
    assert.equal(c.calls.at(-1),'Emulation.setFocusEmulationEnabled');
  }
});
test('confirmed zero annotations retains raw photo and records successful inspection', async () => {
  const f=fixture();f.document.querySelector('.doodle-list-container').innerHTML='';f.document.querySelector('.detail-desc-tag-row').innerHTML='<!----><!---->';
  const plan=await f.run();const calls=[];
  const api={sendCommand:async (_t,method,params)=>{calls.push(method);return method==='Runtime.evaluate'?{result:{value:await vm.runInContext(params.expression,f.context)}}:{};}};
  const result=await captureDjiPresentation(api,1,job,plan,djiPhotoPresentation,uuid);
  assert.equal(result.annotationCount,0);assert.equal(result.dataUrl,null);assert(!calls.includes('Page.captureScreenshot'));
});

test('calibrates Retina, browser zoom and fractional CSS rounding from actual screenshot dimensions', async () => {
  for (const [width,height] of [[1000,800],[2000,1600],[640,512],[1279,1024]]) {
    const c=await captureFixture({screenshot:[png(width,height),png()]});
    assert.equal((await c.run()).dataUrl,`data:image/png;base64,${png()}`);
    assert.equal(c.clips[0].scale,1);
    assert.equal(c.clips[1].scale,1280/width);
    assert.equal(c.clips[0].x,c.clips[1].x);
    assert.equal(c.clips[0].width,c.clips[1].width);
  }
});
test('normalizes at most two pixels after calibration without accepting a clipped image', async () => {
  let normalized=0;
  const normalize=async(data,width,height)=>{normalized++;assert.equal(data,png(1280,1025));assert.deepEqual([width,height],[1280,1024]);return png();};
  const c=await captureFixture({screenshot:[png(1279,1024),png(1280,1025)],normalize});
  assert.equal((await c.run()).dataUrl,`data:image/png;base64,${png()}`);
  assert.equal(normalized,1);
  for(const screenshot of [[png(1000,800),png(1280,1027)],[png(1000,700)]]) {
    const bad=await captureFixture({screenshot,normalize});
    await assert.rejects(bad.run(),/尺寸|比例/);
  }
  assert.equal(normalized,1);
});
test('canvas correction draws the entire capture and closes decoded bitmap even on failure', async () => {
  for(const fail of [false,true]) {
    let closed=false,drawn=false;
    const bitmap={width:1280,height:1025,close(){closed=true;}};
    const sandbox={Uint8Array,Blob,atob,btoa,String,createImageBitmap:async()=>bitmap,
      OffscreenCanvas:class{
        constructor(w,h){assert.deepEqual([w,h],[1280,1024]);}
        getContext(kind){assert.equal(kind,'2d');return{drawImage(...args){assert.deepEqual(args,[bitmap,0,0,1280,1024]);drawn=true;}};}
        async convertToBlob(){if(fail)throw Error('encode');return new Blob([Buffer.from(png(),'base64')]);}
      }};
    const result=vm.runInNewContext(`(${normalizeDjiCapture.toString()})(${JSON.stringify(png(1280,1025))},1280,1024)`,sandbox);
    if(fail)await assert.rejects(result,/encode/);else assert.equal(await result,png());
    assert(closed && drawn);
  }
});

test('pads the actual edge SVG, excluding its oversized empty point container', async () => {
  const f=fixture(), icon=f.document.querySelector('.point-icon');
  icon.innerHTML='<svg></svg>';
  const svg=icon.querySelector('svg');svg.getClientRects=()=>[{}];
  f.setBox(icon,box(300,-5.3,24,24));f.setBox(svg,box(300,-0.9,16,16));
  const plan=await f.run();
  assert.equal(plan.imageRect.y,4);assert.equal(plan.height,1028);
  const ready=await f.run({phase:'prepare',signature:plan.signature,captureId:uuid()});
  assert.equal(ready.sourceSignature,plan.signature);
  assert(ready.clip.y>=0 && ready.clip.y+ready.clip.height<=800.01);
  assert.equal(ready.height,1028);
  await f.run({phase:'restore',captureId:uuid()});
  assert.equal(icon.getBoundingClientRect().top,-5.3);
});
test('fits annotations beyond all four edges without shifting them relative to the photo and restores every style', async () => {
  const f=fixture(), texts=f.document.querySelectorAll('.text'), points=f.document.querySelectorAll('.point-icon');
  f.setBox(texts[0],box(70,20,100,20));f.setBox(texts[1],box(1090,700,100,20));
  f.setBox(points[0],box(200,-10,16,16));f.setBox(points[1],box(200,790,16,30));
  const photo=f.document.querySelector('.photo-wrapper'), layer=f.document.querySelector('.doodle-list-container');
  photo.style.overflow='hidden';layer.style.overflow='hidden';
  const styles=[photo.getAttribute('style'),layer.getAttribute('style')];
  const plan=await f.run();
  assert(plan.imageRect.x>0 && plan.imageRect.y>0 && plan.width>1280 && plan.height>1024);
  const ready=await f.run({phase:'prepare',signature:plan.signature,captureId:uuid()});
  assert.equal(photo.style.overflow,'visible');assert.equal(layer.style.overflow,'visible');
  const rect=f.img.getBoundingClientRect(), label=texts[0].getBoundingClientRect();
  assert(Math.abs((label.left-rect.left)/rect.width - (70-100)/1000)<1e-10);
  assert(ready.clip.x>=0 && ready.clip.y>=0 && ready.clip.x+ready.clip.width<=1200.01 && ready.clip.y+ready.clip.height<=800.01);
  const checked=await f.run({phase:'capture-inspect',signature:ready.signature,captureGeometry:{width:ready.width,height:ready.height,imageRect:ready.imageRect}});
  assert.equal(checked.signature,ready.signature);
  await f.run({phase:'restore',captureId:uuid()});
  assert.deepEqual([photo.getAttribute('style'),layer.getAttribute('style')],styles);
});
test('worker exports padded geometry with original-image coordinates and cleans up on success and failure', async () => {
  for(const fail of [false,true]) {
    const c=await captureFixture({fail,configure:f=>f.setBox(f.document.querySelector('.text'),box(1090,700,100,20)),screenshot:({plan})=>png(plan.width,plan.height)});
    if(fail)await assert.rejects(c.run(),/capture failed/);
    else {
      const result=await c.run();assert.equal(result.width,c.plan.width);assert(result.width>1280);
      assert.equal(result.method,'dji-viewer-capture-v2');assert.equal(result.imageRect.width,1280);
    }
    assert.equal(c.f.document.querySelectorAll('[data-taizhou-photo-capture]').length,0);
    assert(!c.f.document.querySelector('.photo-wrapper').style.transform);
  }
});

test('keeps the shared zero-size SVG sprite visible so temperature point symbols still render', async () => {
  const f=fixture(),sprite=f.document.createElement('svg');
  sprite.id='__SVG_SPRITE_NODE__';sprite.innerHTML='<symbol id="ai-point"><circle cx="8" cy="8" r="7"/></symbol>';
  f.document.body.prepend(sprite);sprite.getClientRects=()=>[{}];sprite.getBoundingClientRect=()=>box(0,0,0,0);
  const icon=f.document.querySelector('.point-icon');icon.innerHTML='<svg><use href="#ai-point"/></svg>';
  for(const el of icon.querySelectorAll('*')){el.getClientRects=()=>[{}];f.setBox(el,box(200,200,16,16));}
  const plan=await f.run();await f.run({phase:'prepare',signature:plan.signature,captureId:uuid()});
  assert(!sprite.style.visibility);assert(!sprite.hasAttribute('data-taizhou-photo-capture'));
  assert.equal(f.document.querySelector('.banner').style.visibility,'hidden');
  await f.run({phase:'restore',captureId:uuid()});
});
