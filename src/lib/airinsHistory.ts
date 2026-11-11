import type { Mission } from './flightReport';

export type MissionPage = { missions: Mission[]; total: number };
const tolerance = 300000;

// Read through the entire matching window, including the next page when a
// candidate sits at a page boundary. Otherwise a second candidate is hidden.
export async function readAirinsHistory(
  startTime: number,
  fetchPage: (cursor: Mission | null) => Promise<MissionPage>,
  current: () => boolean = () => true,
  first?: MissionPage,
): Promise<MissionPage> {
  const records = new Map<number, Mission>();
  let cursor: Mission | null = null;
  for (let page = 0; page < 100; page++) {
    if (!current()) throw new Error('任务已变化，请重新读取可飞采样');
    const result: MissionPage = page === 0 && first ? first : await fetchPage(cursor);
    if (!current()) throw new Error('任务已变化，请重新读取可飞采样');
    const rows = [...result.missions].sort((a, b) => b.startTime - a.startTime || b.missionId - a.missionId);
    const before = records.size;
    for (const row of rows) records.set(row.missionId, row);
    const last = rows[rows.length - 1];
    if (!last || last.startTime < startTime - tolerance || records.size >= result.total) {
      return { missions: [...records.values()], total: result.total };
    }
    if (records.size === before || (cursor && last.startTime > cursor.startTime)) {
      throw new Error('可飞历史任务分页未推进，请稍后重试');
    }
    cursor = last;
  }
  throw new Error('可飞历史任务尚未查完，请稍后重试');
}

export function associateAirinsMission(flight: Mission, sampling: Mission[], executions: Mission[]): Mission | null {
  const near = (a: Mission, b: Mission) => Math.abs(a.startTime - b.startTime) <= tolerance;
  const candidates = [...new Map(sampling.filter(m => m.missionId > 0 && near(m, flight)
    && m.endTime > flight.startTime && m.startTime < flight.endTime).map(m => [m.missionId, m])).values()];
  if (!candidates.length) return null;
  if (candidates.length !== 1 || executions.filter(m => near(m, candidates[0])).length > 1) {
    throw new Error('同一时段存在多个可飞采样或司空航次，无法唯一关联，请核查后重试');
  }
  // Keep the DJI name and actual execution window for report statistics.
  return { ...flight, missionId: candidates[0].missionId, geoLocation: candidates[0].geoLocation };
}
