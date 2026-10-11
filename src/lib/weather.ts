export type WeatherView = {
  location: string; latitude: number; longitude: number; source: string;
  refreshing: boolean; allowed: boolean; level: 'ok' | 'caution' | 'unsafe' | 'unknown'; label: string; reasons: string[];
  current: { observedAt: number; fetchedAt: number; temperature: number | null; weatherCode: number | null; windSpeed: number | null; windGusts: number | null; windDirection: number | null; precipitation: number | null } | null;
};
export type WeatherCheck = { checkedAt: number; stage: 'creation' | 'preparation' | 'submission' | 'failure' | 'flight_status'; weather: WeatherView };
export function weatherPasses(weather: WeatherView | undefined) {
  const s = weather?.current, now = Date.now() / 1000;
  return !!(weather?.allowed && s && now - s.observedAt >= -60 && now - s.observedAt <= 1800 && now - s.fetchedAt >= 0 && now - s.fetchedAt <= 600);
}
export function windProhibitsLaunch(weather: WeatherView | undefined) {
  return [weather?.current?.windSpeed, weather?.current?.windGusts].some(value => value != null && Number.isFinite(value) && value >= 12);
}
export const weatherText = (code: number | null | undefined) => {
  if (code == null) return '天气现象缺测';
  const codes: Record<number, string> = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '冻雾', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪', 95: '雷暴', 96: '雷暴伴冰雹', 99: '雷暴伴冰雹' };
  return codes[code] ?? '未知天气';
};
