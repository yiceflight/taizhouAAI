import { expect, it } from 'vitest';
import { windDirectionForDegrees, windDirectionForRule, windDirections } from '../src/lib/windDirections';

it('assigns every exact boundary clockwise, including the north wrap', () => {
  for (const [boundary, before, at] of [
    [22.5,'北风','东北风'], [67.5,'东北风','东风'], [112.5,'东风','东南风'],
    [157.5,'东南风','南风'], [202.5,'南风','西南风'], [247.5,'西南风','西风'],
    [292.5,'西风','西北风'], [337.5,'西北风','北风'],
  ] as const) {
    expect(windDirectionForDegrees(boundary - 0.000001)?.label).toBe(before);
    expect(windDirectionForDegrees(boundary)?.label).toBe(at);
    expect(windDirectionForDegrees(boundary + 0.000001)?.label).toBe(at);
  }
  for (const value of [0, 360, 359.999999]) expect(windDirectionForDegrees(value)?.label).toBe('北风');
  expect(windDirectionForDegrees(66)?.label).toBe('东北风');
});
it('does not turn invalid or absent direction into north wind', () => {
  for (const value of [null, undefined, -1, 361, NaN, Infinity]) expect(windDirectionForDegrees(value)).toBeUndefined();
});
it('round trips exact persisted sectors but never approximates custom legacy ranges', () => {
  for (const direction of windDirections) expect(windDirectionForRule({...direction,route:'测试航线'})?.id).toBe(direction.id);
  expect(windDirectionForRule({startDegrees:0,endDegrees:45,route:'测试航线'})).toBeUndefined();
  expect(windDirectionForRule({startDegrees:315,endDegrees:45,route:'测试航线'})).toBeUndefined();
});
