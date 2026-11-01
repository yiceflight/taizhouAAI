import type { WindRouteRule } from './workspace';

// Meteorological direction (where wind comes from), clockwise from north.
// Half-open sectors agree with the backend's direction_in_rule matcher.
export const windDirections = [
  { id: 'N', label: '北风', startDegrees: 337.5, endDegrees: 22.5 },
  { id: 'NE', label: '东北风', startDegrees: 22.5, endDegrees: 67.5 },
  { id: 'E', label: '东风', startDegrees: 67.5, endDegrees: 112.5 },
  { id: 'SE', label: '东南风', startDegrees: 112.5, endDegrees: 157.5 },
  { id: 'S', label: '南风', startDegrees: 157.5, endDegrees: 202.5 },
  { id: 'SW', label: '西南风', startDegrees: 202.5, endDegrees: 247.5 },
  { id: 'W', label: '西风', startDegrees: 247.5, endDegrees: 292.5 },
  { id: 'NW', label: '西北风', startDegrees: 292.5, endDegrees: 337.5 },
] as const;

export function windDirectionForRule(rule: WindRouteRule) {
  return windDirections.find(direction => direction.startDegrees === rule.startDegrees && direction.endDegrees === rule.endDegrees);
}

export function windDirectionForDegrees(degrees: number | null | undefined) {
  if (degrees == null || !Number.isFinite(degrees) || degrees < 0 || degrees > 360) return undefined;
  const value = degrees === 360 ? 0 : degrees;
  return windDirections.find(({ startDegrees, endDegrees }) => startDegrees < endDegrees
    ? value >= startDegrees && value < endDegrees
    : value >= startDegrees || value < endDegrees);
}
