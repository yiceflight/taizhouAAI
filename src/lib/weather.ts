import { windDirectionForDegrees } from './windDirections';
export type WeatherView = {
  location: string; latitude: number; longitude: number; source: string;
  refreshing: boolean; allowed: boolean; level: 'ok' | 'caution' | 'unsafe' | 'unknown'; label: string; reasons: string[];
  current: { airworthy?: number | null; platformLabel?: string | null; rainfall?: number | null;
    forecast?: { observedAt: number; condition: string; temperature: number; humidity: number; precipitation: number } | null;
    items?: { key: string; label: string; value: string; level: number }[];
    observedAt: number; fetchedAt: number; temperature: number | null; weatherCode: number | null; windSpeed: number | null; windGusts: number | null; windDirection: number | null; precipitation: number | null } | null;
};
export type WeatherCheck = { checkedAt: number; stage: 'creation' | 'preparation' | 'submission' | 'failure' | 'flight_status'; weather: WeatherView };
export function forecastWindLabel(weather: WeatherView | undefined, now = Date.now() / 1000) {
  const sample = weather?.current;
  const direction = windDirectionForDegrees(sample?.windDirection);
  if (!sample?.forecast || !direction) return '未取得';
  if (weather?.level === 'unknown') return '暂不可用';
  if (now - sample.forecast.observedAt < 0 || now - sample.forecast.observedAt > 3600
      || now - sample.fetchedAt < 0 || now - sample.fetchedAt > 1800
      || now - sample.observedAt < -60 || now - sample.observedAt > 1920) return '已过期';
  return direction.label;
}
// Presentation only: a favorable platform verdict is not local launch authorization.
export function weatherPasses(weather: WeatherView | undefined) {
  const s = weather?.current, now = Date.now() / 1000;
  return !!(weather?.allowed && s && now - s.observedAt >= -60 && now - s.observedAt <= 1920 && now - s.fetchedAt >= 0 && now - s.fetchedAt <= 1800);
}
export const currentWeatherText = (sample: WeatherView['current'] | undefined) => sample?.forecast?.condition ?? weatherText(sample?.weatherCode);
export const rainfallText = (sample: WeatherView['current'] | undefined) => sample?.items?.find(i => i.key === 'rainfall')?.value ?? '缺测';
export const weatherText = (code: number | null | undefined) => {
  if (code == null) return '天气现象缺测';
  const codes: Record<number, string> = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '冻雾', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪', 95: '雷暴', 96: '雷暴伴冰雹', 99: '雷暴伴冰雹' };
  return codes[code] ?? '未知天气';
};
