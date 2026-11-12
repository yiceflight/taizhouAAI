import test from 'node:test';
import assert from 'node:assert/strict';
import {airinsHistoryRouteMatches, airinsMap} from '../extension/src/airins-map.js';
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
test('serialized map capture automatically retries clipped trajectories',()=>{
 const source=airinsMap.toString();
 assert.match(source,/for \(let attempt = 0; attempt < 4; attempt\+\+\)/);
 assert.match(source,/recoveryAttempt:attempt/);
 assert.match(source,/finally \{\s*\/\/ Also clean up malformed/);
});
test('platform export is embedded whole without inferring route pixels from the PNG',()=>{
 const source=airinsMap.toString();
 assert.match(source,/method:'airins-export-full-v1'/);
 assert.match(source,/dataUrl:source,originalDataUrl:source/);
 assert.doesNotMatch(source,/getImageData|trajectoryCrop|未可靠识别|触及地图边缘|zoomOut/);
});
