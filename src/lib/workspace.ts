import { weatherPasses, type WeatherView } from './weather';
export type BrowserTab = { session: string; id: number; title: string; url: string; status: string };
export type BridgeStatus = { connected: boolean; clients: number; versions: string[]; tabs: BrowserTab[]; error: string | null };
export type ReportSummary = { id: string; createdAt: number; source: string; title: string; truncated: boolean };
export const tabKey = (tab: BrowserTab) => `${tab.session}:${tab.id}`;
export type SiteHealth = { id: string; state: 'blocked' | 'unchecked' | 'not_open' | 'ready' | 'login_required' | 'forbidden' | 'page_required' | 'error'; message: string; checkedAt: string | null; session: string | null; tabId: number | null; url: string | null };
export type Readiness = { pluginReady: boolean; pluginMessage: string; pluginUpdateRequired: boolean; minimumExtensionVersion: string; checking: boolean; sites: SiteHealth[]; ready: boolean; started: boolean };
export type HourRow = { time: string; potassium: number | null };
export type WorkspaceSettings = { potassiumThreshold: number; pm25Threshold: number; takeoffDelayMinutes: number; requireManualConfirmation: boolean };
export const defaultSettings: WorkspaceSettings = { potassiumThreshold: 1.0, pm25Threshold: 60, takeoffDelayMinutes: 5, requireManualConfirmation: true };
export type FlightEvent = { id: string; observedAt: string; potassium: number | null; name: string; status: 'countdown' | 'preparing' | 'ready' | 'submitting' | 'submitted' | 'uncertain' | 'failed' | 'canceled' | 'dismissed'; error: string | null; preview: boolean; source?: string; launchAt?: number | null };
export type MonitorView = { weather?: WeatherView; enabled: boolean; syncing: boolean; lastAttempt: string | null; lastSuccess: string | null; error: string | null; total: number; rows: HourRow[]; queryThrough: string | null; settings: WorkspaceSettings; flight: { enabled: boolean; threshold: number; delayMinutes?: number; event: FlightEvent | null } };
export const siteLabels: Record<SiteHealth['state'], string> = { blocked: '等待插件', unchecked: '待验证', not_open: '待打开', ready: '已验证', login_required: '需登录', forbidden: '无访问权限', page_required: '需打开业务页', error: '检测异常' };
export const hourTime = (value: string) => new Date(value.replace(' ', 'T') + '+08:00').getTime();
export function potassiumReading(data: MonitorView | null, now = Date.now()) {
  const latest = data?.rows[0];
  const age = latest ? now - hourTime(latest.time) : NaN;
  const valid = latest?.potassium != null && Number.isFinite(latest.potassium) && age >= 0 && age <= 3 * 3600000;
  const threshold = data?.settings?.potassiumThreshold ?? defaultSettings.potassiumThreshold;
  return { latest, valid, threshold, exceeded: valid && latest!.potassium! > threshold };
}
export function dataQuality(data: MonitorView | null) {
  const latest = data?.rows[0];
  if (!latest) return { tone: 'warning', label: '暂无数据', detail: '首次读取后显示最新小时数据' };
  if (Date.now() - hourTime(latest.time) > 3 * 3600000) return { tone: 'warning', label: '数据已过期', detail: '最新数据超过 3 小时，暂不判断巡查触发条件' };
  if (hourTime(latest.time) > Date.now()) return { tone: 'warning', label: '数据时间异常', detail: '数据时间晚于当前时间，暂不判断巡查触发条件' };
  if (latest.potassium === null) return { tone: 'warning', label: '暂无数据', detail: 'K⁺ 暂无数据，暂不判断巡查触发条件' };
  const settings = data?.settings ?? defaultSettings;
  const potassiumHigh = latest.potassium > settings.potassiumThreshold;
  return { tone: potassiumHigh ? 'warning' : 'success', label: potassiumHigh ? 'K⁺ 超过巡查阈值' : '数据正常', detail: '钾离子数据在有效时间内' };
}

type FlightSummary = { title: string; detail: string; tone: 'muted' | 'warning' | 'danger' | 'active' | 'ready'; needsManualLaunch?: boolean };
export function flightSummary(data: MonitorView | null, ready: boolean, now = Date.now()): FlightSummary {
  const flight = data?.flight, event = flight?.event;
  if (!data) return { title: '无人机 · 状态待读取', detail: '等待客户端获取巡飞任务', tone: 'muted' };
  if (event && !['dismissed', 'canceled'].includes(event.status)) {
    switch (event.status) {
      case 'countdown': {
        const seconds = Math.max(0, Math.ceil(((event.launchAt ?? now) - now) / 1000));
        const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        return { title: data.settings?.requireManualConfirmation ? '巡飞计划 · 等待准备' : seconds > 0 ? `无人机 · ${time} 后起飞` : '无人机 · 等待起飞检查', detail: `K⁺ ${event.potassium ?? '—'} μg/m³ 超标 · 可取消本次任务`, tone: 'danger' };
      }
      case 'preparing': return { title: event.preview ? '正在演练填写' : '无人机 · 正在准备起飞', detail: '正在填写巡飞计划 · 提交前可取消', tone: event.source === 'auto' && !event.preview ? 'danger' : 'warning' };
      case 'submitting': return { title: '无人机 · 正在提交起飞请求', detail: '请勿重复操作 · 等待司空回执', tone: 'warning' };
      case 'submitted': return { title: '无人机 · 起飞请求已提交', detail: '实际飞行状态请在司空查看', tone: 'active' };
      case 'uncertain': return { title: '无人机 · 起飞结果待核查', detail: '请到司空核查 · 不会自动重试', tone: 'warning' };
      case 'ready': return { title: '巡飞计划 · 待人工确认', detail: '计划尚未提交 · 点击查看', tone: event.source === 'auto' && !event.preview ? 'danger' : 'warning' };
      case 'failed': return { title: '无人机 · 起飞准备失败', detail: '未发送起飞请求 · 点击处理', tone: 'warning' };
    }
  }
  if (event?.status === 'canceled') return { title: '无人机 · 任务已取消', detail: '本轮超标不再自动触发 · 可手动起飞', tone: 'muted' };
  const { latest, valid, threshold, exceeded } = potassiumReading(data, now);
  if (exceeded) {
    const detail = `K⁺ ${latest!.potassium} > ${threshold} μg/m³`;
    const needsManualLaunch = !flight?.enabled || data.settings.requireManualConfirmation;
    const next = !ready ? '请先完成工作准备' : !weatherPasses(data.weather) ? '天气条件未通过，暂不可起飞' : needsManualLaunch ? '请手动执行巡查任务' : '等待自动巡飞调度';
    return { title: needsManualLaunch ? 'K⁺ 超标 · 需要执行任务' : 'K⁺ 超标 · 等待巡飞任务', detail: `${detail} · ${next}`, tone: 'danger', needsManualLaunch };
  }
  if (!ready) return { title: '无人机 · 等待工作环境就绪', detail: '完成工作准备后可发起巡飞', tone: 'muted' };
  if (!weatherPasses(data.weather)) return { title: '无人机 · 等待适飞天气', detail: '天气条件未通过 · 点击查看原因', tone: 'warning' };
  return { title: '无人机 · 待命', detail: !flight?.enabled ? '手动模式 · 未超标也可起飞' : !valid ? '自动巡飞 · 等待有效 K⁺ 数据' : data.settings?.requireManualConfirmation ? '自动巡飞 · 超标后填写计划，待人工确认' : `自动巡飞 · 超标 ${data.settings?.takeoffDelayMinutes ?? 5} 分钟后起飞`, tone: 'ready' };
}
