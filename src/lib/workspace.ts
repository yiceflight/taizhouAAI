export type BrowserTab = { session: string; id: number; title: string; url: string; status: string };
export type BridgeStatus = { connected: boolean; clients: number; versions: string[]; tabs: BrowserTab[]; error: string | null };
export type ReportSummary = { id: string; createdAt: number; source: string; title: string; truncated: boolean };
export const tabKey = (tab: BrowserTab) => `${tab.session}:${tab.id}`;
