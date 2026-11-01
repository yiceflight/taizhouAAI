import { useEffect, useRef } from 'react';
import type { PatrolTask } from './flightReport';

// A row can acquire a DJI execution, sampling mission or report after it was
// viewed. Remember all known identities so that enrichment is not a new flight.
function identities(task: PatrolTask): string[] {
  return [...new Set([
    task.key,
    task.localEvent?.id && `event-${task.localEvent.id}`,
    task.djiTask?.taskId && `dji-${task.djiTask.taskId}`,
    task.mission?.missionId && `mission-${task.mission.missionId}`,
    task.report?.id && `report-${task.report.id}`,
  ].filter((id): id is string => typeof id === 'string' && !!id))];
}

export function usePatrolUnread(tasks: PatrolTask[], active: boolean, clearedAt: number, onChange?: (unread: boolean) => void) {
  const saved = useRef<{ key: string; seen: Set<string> } | null>(null);
  const key = `taizhou.patrol-seen.v1:${clearedAt}`;
  const groupsJson = JSON.stringify(tasks.map(identities));
  useEffect(() => {
    if (!onChange) return;
    if (saved.current?.key !== key) {
      let ids: string[] = [];
      try {
        const stored: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
        if (Array.isArray(stored)) ids = stored.filter((id): id is string => typeof id === 'string');
      } catch { /* Storage unavailable or malformed: retain in-memory read state. */ }
      saved.current = { key, seen: new Set(ids) };
    }
    const { seen } = saved.current;
    const groups: string[][] = JSON.parse(groupsJson);
    let unread = false, changed = false;
    for (const ids of groups) {
      const read = ids.some(id => seen.has(id));
      if (!read) unread = true;
      if (active || read) {
        for (const id of ids) {
          if (!seen.has(id)) { seen.add(id); changed = true; }
        }
      }
    }
    if (changed) {
      try { window.localStorage.setItem(key, JSON.stringify([...seen])); } catch { /* Keep session state. */ }
    }
    onChange(!active && unread);
  }, [key, groupsJson, active, onChange]);
}
