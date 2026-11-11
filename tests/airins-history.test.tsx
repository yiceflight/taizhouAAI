import { describe, expect, it, vi } from 'vitest';
import { associateAirinsMission, readAirinsHistory } from '../src/lib/airinsHistory';
import type { Mission } from '../src/lib/flightReport';
const flight: Mission = { missionId: 0, missionName: '东侧下午5点航线巡查', startTime: Date.parse('2026-11-03T17:00:00+08:00'), endTime: Date.parse('2026-11-03T17:25:00+08:00'), geoLocation: '' };
const sample = { ...flight, missionId: 42, missionName: '7e6683fe_2026-11-03 17:01:18', startTime: flight.startTime + 78000, endTime: flight.startTime + 1479000, geoLocation: '泰州' };
const newer = { ...sample, missionId: 43, startTime: flight.startTime + 86400000 };
describe('historical Airins association', () => {
  it('reads beyond the first page and preserves actual DJI times', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ missions: [newer], total: 2 }).mockResolvedValueOnce({ missions: [sample], total: 2 });
    const data = await readAirinsHistory(flight.startTime, fetch);
    expect(fetch).toHaveBeenNthCalledWith(2, newer);
    expect(associateAirinsMission(flight, data.missions, [flight])).toEqual({ ...flight, missionId: 42, geoLocation: '泰州' });
  });
  it('reads past a candidate page boundary and rejects ambiguity', async () => {
    const other = { ...sample, missionId: 41, startTime: sample.startTime - 1000 };
    const fetch = vi.fn().mockResolvedValueOnce({ missions: [sample], total: 2 }).mockResolvedValueOnce({ missions: [other], total: 2 });
    const data = await readAirinsHistory(flight.startTime, fetch);
    expect(() => associateAirinsMission(flight, data.missions, [flight])).toThrow('无法唯一关联');
    expect(() => associateAirinsMission(flight, [sample], [flight, { ...flight, startTime: flight.startTime + 60000 }])).toThrow('无法唯一关联');
  });
  it('stops after crossing the matching window, not just when no match appears on the first page', async () => {
    const older = { ...sample, missionId: 40, startTime: flight.startTime - 3600000, endTime: flight.startTime - 3000000 };
    const fetch = vi.fn().mockResolvedValueOnce({ missions: [newer], total: 20 }).mockResolvedValueOnce({ missions: [older], total: 20 });
    const data = await readAirinsHistory(flight.startTime, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(associateAirinsMission(flight, data.missions, [flight])).toBeNull();
  });
  it('does not treat a failed, repeated or canceled page as absent data', async () => {
    await expect(readAirinsHistory(flight.startTime, vi.fn().mockRejectedValue(new Error('网络中断')))).rejects.toThrow('网络中断');
    await expect(readAirinsHistory(flight.startTime, vi.fn().mockResolvedValue({ missions: [newer], total: 10 }))).rejects.toThrow('分页未推进');
    let valid = true;
    await expect(readAirinsHistory(flight.startTime, async () => { valid = false; return { missions: [], total: 0 }; }, () => valid)).rejects.toThrow('任务已变化');
  });
});
