import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { usePatrolUnread } from '../src/lib/usePatrolUnread';
import type { PatrolTask } from '../src/lib/flightReport';

let root: ReturnType<typeof createRoot>;
let storage: Map<string, string>;
const changed = vi.fn();
const task = (key: string): PatrolTask => ({ key, mission: null, report: null });
function Fixture({ tasks, active, clearedAt = 0 }: { tasks: PatrolTask[]; active: boolean; clearedAt?: number }) {
  usePatrolUnread(tasks, active, clearedAt, changed);
  return null;
}
const render = async (tasks: PatrolTask[], active = false, clearedAt = 0) => {
  await act(async () => root.render(<Fixture tasks={tasks} active={active} clearedAt={clearedAt} />));
};
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  storage = new Map();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  changed.mockClear();
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('notifies for unseen records, clears on opening the tab, and persists across remounts', async () => {
  await render([]); expect(changed).toHaveBeenLastCalledWith(false);
  await render([task('a')]); expect(changed).toHaveBeenLastCalledWith(true);
  await render([task('a')], true); expect(changed).toHaveBeenLastCalledWith(false);
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root')!);
  await render([task('a')]); expect(changed).toHaveBeenLastCalledWith(false);
  await render([task('a'), task('b')]); expect(changed).toHaveBeenLastCalledWith(true);
  await render([task('a'), task('b')], true); expect(changed).toHaveBeenLastCalledWith(false);
});

it('acknowledges incoming records while the task tab is visible and preserves read aliases', async () => {
  const local = { ...task('event-a'), localEvent: { id: 'a', name: '巡查', observedAt: '', status: 'flying' } };
  await render([local], true);
  await render([{ ...local, key: 'dji-execution' }]);
  expect(changed).toHaveBeenLastCalledWith(false);
  await render([task('dji-execution')]); expect(changed).toHaveBeenLastCalledWith(false);
  await render([task('dji-execution'), task('new')], true);
  await render([task('dji-execution'), task('new')]); expect(changed).toHaveBeenLastCalledWith(false);
});

it('clears the dot when records disappear and isolates a cleared dataset', async () => {
  await render([task('a')], true);
  await render([], false, 123); expect(changed).toHaveBeenLastCalledWith(false);
  await render([task('a')], false, 123); expect(changed).toHaveBeenLastCalledWith(true);
});

it('tolerates malformed or unavailable storage without losing session read state', async () => {
  storage.set('taizhou.patrol-seen.v1:0', '{}');
  await render([task('a')]); expect(changed).toHaveBeenLastCalledWith(true);
  window.localStorage.setItem = () => { throw new Error('unavailable'); };
  await render([task('a')], true);
  await render([task('a')]); expect(changed).toHaveBeenLastCalledWith(false);
});
