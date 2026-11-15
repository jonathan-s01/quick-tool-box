import test from 'node:test';
import assert from 'node:assert/strict';
import { routeStops } from './gtfs.js';

const stops = [
  { code: '100', name: 'First Street', dir: '', routes: ['7'], lat: 0, lon: 0 },
  { code: '200', name: 'Main Street', dir: '', routes: ['7'], lat: 0, lon: 0 },
  { code: '300', name: 'Last Street', dir: '', routes: ['7'], lat: 0, lon: 0 },
];
const g = {
  codeIndex: new Map(stops.map((stop, i) => [stop.code, i])),
  routeByShort: new Map([['7', ['route-7']]]),
  routes: new Map([['route-7', { short: '7' }]]),
  routePatterns: new Map([['route-7', [
    { dir: '0', headsign: 'Last Street', trips: 4, stops: [0, 1, 2] },
    { dir: '1', headsign: 'First Street', trips: 3, stops: [2, 1, 0] },
    { dir: '2', headsign: 'Loop', trips: 1, stops: [1, 0, 1] },
  ]]]),
  stops,
};

test('routeStops returns ordered stops around the selected stop for every matching direction', () => {
  const segments = routeStops(g, '7', '200');
  assert.equal(segments.length, 4);
  assert.deepEqual(segments[0].before.map((s) => s.code), ['100']);
  assert.equal(segments[0].stop.code, '200');
  assert.deepEqual(segments[0].after.map((s) => s.code), ['300']);
  assert.deepEqual(segments[1].before.map((s) => s.code), ['300']);
  assert.deepEqual(segments[1].after.map((s) => s.code), ['100']);
});

test('routeStops preserves repeated visits to a stop on a loop', () => {
  const loops = routeStops(g, '7', '200').filter((s) => s.headsign === 'Loop');
  assert.equal(loops.length, 2);
  assert.deepEqual(loops.map((s) => s.occurrence), [1, 2]);
  assert.deepEqual(loops[1].before.map((s) => s.code), ['200', '100']);
});

test('routeStops returns no segments for an unknown route or stop', () => {
  assert.deepEqual(routeStops(g, '99', '200'), []);
  assert.deepEqual(routeStops(g, '7', '999'), []);
});
