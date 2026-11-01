import type { FlightTime } from './flightReport';
import { type WeatherView, type WeatherCheck } from './weather';
export type BrowserTab = { session: string; id: number; title: string; url: string; status: string };
export type BridgeStatus = { connected: boolean; clients: number; versions: string[]; tabs: BrowserTab[]; error: string | null };
export type ReportSummary = { id: string; createdAt: number; source: string; title: string; truncated: boolean };
export const tabKey = (tab: BrowserTab) => `${tab.session}:${tab.id}`;
export type SiteHealth = { id: string; state: 'blocked' | 'unchecked' | 'not_open' | 'ready' | 'login_required' | 'forbidden' | 'page_required' | 'error'; message: string; checkedAt: string | null; session: string | null; tabId: number | null; url: string | null };
export type Readiness = {
  monitoringReady?: boolean; flightReady?: boolean; reportReady?: boolean; pluginReady: boolean; pluginMessage: string; pluginUpdateRequired: boolean; minimumExtensionVersion: string; checking: boolean; sites: SiteHealth[]; ready: boolean; started: boolean };
export type HourRow = { time: string; potassium: number | null; pm25: number | null };
export type NoFlyPeriod = { start: string; end: string };
// Legacy input only; route selection now depends on whether wind rules exist.
export type RouteSelectionMode = 'fixed' | 'wind';
export type WindRouteRule = { startDegrees: number; endDegrees: number; route: string };
export type WorkspaceSettings = { potassiumEnabled?: boolean; pm25Enabled?: boolean; potassiumThreshold: number; pm25Threshold: number; takeoffDelayMinutes: number; requireManualConfirmation: boolean; noFlyPeriods?: NoFlyPeriod[]; routeSelectionMode?: RouteSelectionMode; windRouteRules?: WindRouteRule[] };
export type FlightRoute = { routeId: string; name: string; updateTime?: number };
export const defaultSettings: WorkspaceSettings = { potassiumThreshold: 1.0, pm25Threshold: 30, takeoffDelayMinutes: 5, requireManualConfirmation: true, noFlyPeriods: [{ start: '05:00', end: '08:00' }], windRouteRules: [] };
export type FlightEvent = { id: string; observedAt: string; sourceHour?: string | null; potassium: number | null; pm25?: number | null; route?: string | null; name: string; status: 'countdown' | 'preparing' | 'ready' | 'submitting' | 'submitted' | 'uncertain' | 'flying' | 'paused' | 'completed' | 'flight_error' | 'failed' | 'not_flown' | 'restricted' | 'canceled' | 'dismissed'; error: string | null; preview: boolean; source?: string; launchAt?: number | null; statusCheckError?: string | null; statusCheckedAt?: number | null; weatherOverrideConfirmedAt?: number | null; weatherChecks?: WeatherCheck[]; resolvedAt?: number | null; flightTime?: FlightTime | null };
export type MonitorView = { weather?: WeatherView; enabled: boolean; syncing: boolean; lastAttempt: string | null; lastSuccess: string | null; error: string | null; total: number; rows: HourRow[]; queryThrough: string | null; settings: WorkspaceSettings; flight: { threshold: number; delayMinutes?: number; event: FlightEvent | null; records?: FlightEvent[]; tasksClearedAt?: number | null; routes?: FlightRoute[]; selectedRoute?: string; routesSyncedAt?: number | null } };
export const siteLabels: Record<SiteHealth['state'], string> = { blocked: '等待插件', unchecked: '待验证', not_open: '待打开', ready: '已验证', login_required: '需登录', forbidden: '无访问权限', page_required: '需打开业务页', error: '检测异常' };
export const hourTime = (value: string) => new Date(value.replace(' ', 'T') + '+08:00').getTime();
export function noFlyPeriod(settings: WorkspaceSettings | undefined, now = Date.now()): NoFlyPeriod | undefined {
  const local = new Date(now + 8 * 3600000), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return (settings?.noFlyPeriods ?? defaultSettings.noFlyPeriods ?? []).find(period => {
    const toMinute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const start = toMinute(period.start), end = toMinute(period.end);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  });
}
export function flightDisplay(data: MonitorView | null, now = Date.now()) {
  const stored = data?.flight.event;
  // A skipped observation remains historical after the current no-fly
  // window ends, even if its observation hour was inside that window.
  const historical = stored?.status === 'restricted' && !noFlyPeriod(data?.settings, now);
  const event = historical ? null : stored;
  const records = historical ? [stored, ...(data?.flight.records ?? [])] : data?.flight.records ?? [];
  const ids = new Set<string>();
  return { event, records: records.filter(record => {
    if (record.id === event?.id || ids.has(record.id)) return false;
    ids.add(record.id); return true;
  }) };
}
// Only a pending or ongoing execution belongs in the overview's current status.
export function isCurrentFlightEvent(event: FlightEvent | null | undefined) {
  return !!event && ['countdown', 'preparing', 'ready', 'submitting', 'submitted', 'uncertain', 'flying', 'paused'].includes(event.status);
}
export function latestValidRow(data: MonitorView | null, field?: 'potassium' | 'pm25') {
  return data?.rows.find(row => {
    if (field) {
      const value = row[field];
      return value != null && Number.isFinite(value);
    }
    return [row.potassium, row.pm25].some(value => value != null && Number.isFinite(value));
  });
}
export function triggerReading(data: MonitorView | null, now = Date.now()) {
  const settings = data?.settings ?? defaultSettings;
  const potassium = latestValidRow(data, 'potassium') ?? data?.rows.find(row => row.potassium != null);
  const pm25 = latestValidRow(data, 'pm25') ?? data?.rows.find(row => row.pm25 != null);
  const fresh = (row: HourRow | undefined) => !!row && now >= hourTime(row.time) && now - hourTime(row.time) <= 3 * 3600000;
  const potassiumValid = settings.potassiumEnabled !== false && fresh(potassium) && Number.isFinite(potassium?.potassium);
  const pm25Valid = settings.pm25Enabled !== false && fresh(pm25) && Number.isFinite(pm25?.pm25);
  const potassiumExceeded = potassiumValid && potassium!.potassium! > settings.potassiumThreshold;
  const pm25Exceeded = pm25Valid && pm25!.pm25! > settings.pm25Threshold;
  const candidates = [settings.potassiumEnabled !== false ? potassium : undefined, settings.pm25Enabled !== false ? pm25 : undefined].filter((row): row is HourRow => !!row).sort((a, b) => b.time.localeCompare(a.time));
  const latest = candidates.find(fresh) ?? candidates[0];
  const triggerHour = [potassiumExceeded ? potassium : undefined, pm25Exceeded ? pm25 : undefined].filter((row): row is HourRow => !!row).sort((a, b) => b.time.localeCompare(a.time))[0]?.time;
  return { latest, potassium, pm25, potassiumValid, pm25Valid, triggerHour, valid: potassiumValid || pm25Valid, potassiumExceeded, pm25Exceeded, exceeded: potassiumExceeded || pm25Exceeded, potassiumThreshold: settings.potassiumThreshold, pm25Threshold: settings.pm25Threshold };

}
export function dataQuality(data: MonitorView | null) {
  const reading = triggerReading(data);
  const latest = reading.latest;
  if (!latest) return { tone: 'warning', label: '暂无数据', detail: '首次读取后显示最新小时数据' };
  if (!reading.valid && hourTime(latest.time) > Date.now()) return { tone: 'warning', label: '数据时间异常', detail: '数据时间晚于当前时间，暂不判断巡查触发条件' };
  if (!reading.valid && Number.isFinite(hourTime(latest.time)) && Date.now() - hourTime(latest.time) >= 0 && Date.now() - hourTime(latest.time) <= 3 * 3600000) return { tone: 'warning', label: '数据异常', detail: '最新小时数据包含无效浓度，暂不判断巡查触发条件' };
  if (!reading.valid) return { tone: 'warning', label: '数据已过期', detail: '最新数据超过 3 小时，暂不判断巡查触发条件' };
  if (latest.potassium == null && latest.pm25 == null) return { tone: 'warning', label: '暂无数据', detail: 'K⁺ 与 PM2.5 均暂无数据，暂不判断巡查触发条件' };
  if (reading.exceeded) {
    const label = reading.potassiumExceeded && reading.pm25Exceeded ? 'K⁺、PM2.5 均超过巡查阈值' : reading.potassiumExceeded ? 'K⁺ 超过巡查阈值' : 'PM2.5 超过巡查阈值';
    return { tone: 'warning', label, detail: '监测数据超过巡查触发阈值' };
  }
  return { tone: 'success', label: '数据正常', detail: `${[reading.potassiumValid ? 'K⁺' : '', reading.pm25Valid ? 'PM2.5' : ''].filter(Boolean).join('、')} 数据在有效时间内` };
}

type FlightSummary = { title: string; detail: string; tone: 'muted' | 'warning' | 'danger' | 'active' | 'ready'; needsManualLaunch?: boolean };
export function flightSummary(data: MonitorView | null, ready: boolean, now = Date.now()): FlightSummary {
  const { event, records } = flightDisplay(data, now);
  if (!data) return { title: '无人机 · 状态待读取', detail: '等待客户端获取巡飞任务', tone: 'muted' };
  if (event && !['dismissed', 'canceled'].includes(event.status)) {
    switch (event.status) {
      case 'countdown': {
        const seconds = Math.max(0, Math.ceil(((event.launchAt ?? now) - now) / 1000));
        const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        const trigger = [event.potassium != null ? `K⁺ ${event.potassium} μg/m³` : '', event.pm25 != null ? `PM2.5 ${event.pm25} μg/m³` : ''].filter(Boolean).join('、');
        return { title: data.settings?.requireManualConfirmation ? '巡飞计划 · 等待准备' : seconds > 0 ? `无人机 · ${time} 后起飞` : '无人机 · 等待起飞检查', detail: `${trigger || '监测指标'} 超标 · 可取消本次任务`, tone: 'danger' };
      }
      case 'preparing': return { title: event.preview ? '正在演练填写' : '无人机 · 正在准备起飞', detail: '正在填写巡飞计划 · 提交前可取消', tone: event.source === 'auto' && !event.preview ? 'danger' : 'warning' };
      case 'submitting': return { title: '无人机 · 正在提交起飞请求', detail: '请勿重复操作 · 等待司空回执', tone: 'warning' };
      case 'submitted': return { title: '无人机 · 起飞请求已提交', detail: event.statusCheckError ? '司空状态核查未完成 · 请查看任务详情' : '正在核查司空计划状态', tone: event.statusCheckError ? 'warning' : 'active' };
      case 'flying': return { title: '无人机 · 任务执行中', detail: '司空计划显示执行中，包含起飞准备阶段', tone: 'active' };
      case 'paused': return { title: '无人机 · 任务暂停', detail: event.error || '请到司空核查', tone: 'warning' };
      case 'flight_error': return { title: '无人机 · 执飞异常', detail: event.error || '请到司空核查飞行记录', tone: 'warning' };
      case 'uncertain': return { title: '无人机 · 起飞结果待核查', detail: event.error || event.statusCheckError || '请到司空核查 · 不会自动重试', tone: 'warning' };
      case 'not_flown': return { title: '无人机 · 司空天气阻飞', detail: event.error || event.statusCheckError || '请到司空页面核查阻飞原因', tone: 'warning' };
      case 'ready': return { title: event.preview ? '填写演练 · 已就绪' : event.statusCheckError?.startsWith('司空平台天气阻飞：') ? '无人机 · 司空天气阻飞' : '巡飞计划 · 待人工确认', detail: event.preview ? '仅演练填写 · 不会提交起飞请求' : event.statusCheckError?.startsWith('司空平台天气阻飞：') ? event.statusCheckError : '请到司空核对计划并确认起飞', tone: event.source === 'auto' && !event.preview ? 'danger' : 'warning' };
      case 'failed': return { title: '起飞未完成 · 待人工核验', detail: '未发送起飞请求 · 请核验电量、设备与平台任务', tone: 'warning' };
      case 'restricted': return { title: '禁飞时间 · 超标仅记录', detail: '未执行起飞', tone: 'muted' };
    }
  }
  if (event?.status === 'completed') return { title: '无人机 · 巡飞已结束', detail: '请核对监测数据与照片，再生成报告', tone: 'ready' };
  if (event?.status === 'canceled') {
    if (event.preview || event.source === 'preview') return { title: '填写演练 · 已取消', detail: '取消演练不影响自动触发', tone: 'muted' };
    if (event.source === 'manual') return { title: '手动任务已取消', detail: '本次取消不影响自动触发 · 可立即执行任务', tone: 'muted' };
    return { title: '无人机 · 任务已取消', detail: event.source === 'auto' ? '该小时不再自动触发 · 新小时重新判断' : '可立即执行任务', tone: 'muted' };
  }
  const { potassium, pm25, triggerHour, valid, potassiumExceeded, pm25Exceeded, exceeded, potassiumThreshold, pm25Threshold } = triggerReading(data, now);
  if (noFlyPeriod(data.settings, now)) return { title: '禁飞时间 · 不执行起飞', detail: '超标仅记录', tone: 'muted' };
  if (exceeded) {
    if (!event && records.some(record => record.status === 'restricted' && record.observedAt === triggerHour)) {
      const metric = potassiumExceeded && pm25Exceeded ? 'K⁺、PM2.5' : potassiumExceeded ? 'K⁺' : 'PM2.5';
      return { title: `${metric} 超标 · 等待新小时数据`, detail: '本小时已记录，不自动补飞 · 可手动执行任务', tone: 'warning', needsManualLaunch: true };
    }
    const details = [potassiumExceeded && potassium!.potassium != null ? `K⁺ ${potassium!.potassium} > ${potassiumThreshold} μg/m³` : '', pm25Exceeded && pm25!.pm25 != null ? `PM2.5 ${pm25!.pm25} > ${pm25Threshold} μg/m³` : ''].filter(Boolean).join('；');
    const detail = details;
    const needsManualLaunch = data.settings.requireManualConfirmation;
    const next = !ready ? '请先完成工作准备' : needsManualLaunch ? '请手动执行巡查任务' : '等待自动巡飞调度';
    const metric = potassiumExceeded && pm25Exceeded ? 'K⁺、PM2.5' : potassiumExceeded ? 'K⁺' : 'PM2.5';
    return { title: needsManualLaunch ? `${metric} 超标 · 需要执行任务` : `${metric} 超标 · 等待巡飞任务`, detail: `${detail} · ${next}`, tone: 'danger', needsManualLaunch };
  }
  if (!ready) return { title: '无人机 · 等待浏览器与网站就绪', detail: '完成工作准备后可发起巡飞', tone: 'muted' };
  return { title: '无人机 · 待命', detail: !valid ? '巡飞 · 等待有效 K⁺/PM2.5 数据' : data.settings?.requireManualConfirmation ? '超标后填写计划，待工作人员确认' : `超标 ${data.settings?.takeoffDelayMinutes ?? 5} 分钟后自动起飞`, tone: 'ready' };
}
