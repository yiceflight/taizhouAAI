import test from 'node:test';
import assert from 'node:assert/strict';
import {airinsHistoryRouteMatches, airinsMap, trajectoryCrop} from '../extension/src/airins-map.js';
function fixture(width=1000,height=1000) {
 const pixels=new Uint8ClampedArray(width*height*4);
 const line=(x1,y1,x2,y2,color=[255,7,3])=>{for(let y=y1;y<=y2;y++)for(let x=x1;x<=x2;x++){pixels.set([...color,255],(y*width+x)*4);}};
 return {pixels,width,height,line};
}
test('crop includes disjoint low and high concentration legs with 10 percent padding',()=>{
 const f=fixture();f.line(200,200,205,800);f.line(700,200,705,800,[24,204,70]);
 const r=trajectoryCrop(f.pixels,f.width,f.height,[[255,7,3],[24,204,70]]);
 assert.ok(r.x<200&&r.y<200&&r.x+r.width>705&&r.y+r.height>800);
 assert.ok(r.width<700&&r.height<750);
});
test('empty and edge-clipped trajectories fail instead of silently creating incomplete report images',()=>{
 const f=fixture();assert.throws(()=>trajectoryCrop(f.pixels,1000,1000,[[255,7,3]]),/未可靠/);
 f.line(0,200,5,800);f.line(0,200,400,205);
 assert.throws(()=>trajectoryCrop(f.pixels,1000,1000,[[255,7,3]]),/边缘/);
});
test('history route accepts mounted pages that normalize the path or remove the query',()=>{
 assert.equal(airinsHistoryRouteMatches('https://aai.airins.cn/sniff/HistoryCloud?missionId=42',42),true);
 assert.equal(airinsHistoryRouteMatches('https://aai.airins.cn/sniff/HistoryCloud/?missionId=42',42),true);
 assert.equal(airinsHistoryRouteMatches('https://aai.airins.cn/sniff/HistoryCloud',42),true);
 assert.equal(airinsHistoryRouteMatches('https://aai.airins.cn/sniff/HistoryCloud?missionId=7',42),false);
 assert.equal(airinsHistoryRouteMatches('https://evil.test/sniff/HistoryCloud?missionId=42',42),false);
});
test('serialized map capture does not depend on module scope helpers',()=>{
 const source=airinsMap.toString();
 assert.match(source,/const historyRouteMatches/);
 assert.doesNotMatch(source,/airinsHistoryRouteMatches\(/);
});
