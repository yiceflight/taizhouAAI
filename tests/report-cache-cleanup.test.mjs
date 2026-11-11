import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../extension/src/service-worker.js', import.meta.url), 'utf8');
const cleanup = worker.slice(worker.indexOf('async function closeCachedReportTab('), worker.indexOf('async function capture(tabId, job)'));
test('cached report closes only its owned media tab, including after worker restart', async () => {
  for (const inMemory of [false, true]) {
    for (const url of ['https://fh.dji.com/project#/media?page=1', 'https://fh.dji.com/project#/plan', null]) {
      const closed = [];
      const context = {
        reportKey: job => job.mediaKey,
        reportTabs: new Map(inMemory ? [['flight-1', 41]] : []), REPORT_TAB_PREFIX: 'flight-report-tab:',
        chrome: { storage: { local: { get: async () => ({ 'flight-report-tab:flight-1': 41 }) } },
          tabs: { get: async id => { assert.equal(id, 41); if (!url) throw new Error('gone'); return { url }; } } },
        closeReportTab: async (key, id) => closed.push([key, id]),
      };
      await vm.runInNewContext(`${cleanup}; closeCachedReportTab({mediaKey:'flight-1'})`, context);
      assert.deepEqual(closed, [['flight-1', url?.includes('#/media') ? 41 : undefined]]);
    }
  }
});
