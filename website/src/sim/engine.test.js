import { test } from "node:test";
import assert from "node:assert/strict";
import { VEHICLES, turnSpeed, drivenRadius, buildTimeline, sampleAt, destination, distance, bearing } from "./engine.js";

const kmh = (ms) => ms * 3.6;

test("geometry: destination and distance agree", () => {
  const a = [51.5, -0.12];
  const b = destination(a, 90, 1000);
  assert.ok(Math.abs(distance(a, b) - 1000) < 0.5);
  assert.ok(Math.abs(bearing(a, b) - 90) < 0.1);
});

test("a 300 m motorway curve is taken at about 88 km/h by car (CHANGELOG)", () => {
  assert.ok(Math.abs(kmh(turnSpeed(VEHICLES.car, 300)) - 88) < 1);
});

test("a 90 degree junction on a 50 km/h road is taken at about 18 km/h (CHANGELOG)", () => {
  const r = drivenRadius(VEHICLES.car, 90, 0, 50 / 3.6, 200);
  assert.ok(Math.abs(kmh(turnSpeed(VEHICLES.car, r)) - 18) < 1);
});

test("a straight leg accelerates and brakes at 1 m/s^2 and reaches cruise speed", () => {
  const a = [51.5, -0.12];
  const b = destination(a, 0, 2000);
  const tl = buildTimeline([{ points: [a, b], kmh: 50, mode: "car" }]);
  const top = Math.max(...tl.v);
  assert.ok(Math.abs(kmh(top) - 50) < 0.01);
  assert.equal(tl.v[0], 0);
  assert.equal(tl.v[tl.v.length - 1], 0);
  // v^2 = 2as: reaching 13.89 m/s at 1 m/s^2 takes ~96 m and 13.9 s; the trip is 2000 m.
  const expected = 2000 / (50 / 3.6) + 50 / 3.6; // cruise time + the time lost speeding up and slowing down
  assert.ok(Math.abs(tl.duration - expected) < 1, `duration ${tl.duration} vs ${expected}`);
  const mid = sampleAt(tl, tl.duration / 2);
  assert.ok(Math.abs(mid.s - 1000) < 5);
  assert.ok(Math.abs(mid.heading - 0) < 1 || Math.abs(mid.heading - 360) < 1);
});

test("a right-angle corner slows a car down and the turn is reported", () => {
  const a = [51.5, -0.12];
  const c = destination(a, 0, 600);
  const b = destination(c, 90, 600);
  const tl = buildTimeline([{ points: [a, c, b], kmh: 50, mode: "car" }]);
  assert.equal(tl.turns.length, 1);
  assert.ok(tl.turns[0].slowed);
  assert.ok(Math.abs(tl.turns[0].kmh - 18) < 1.5, `turn speed ${tl.turns[0].kmh}`);
  const atCorner = tl.v[tl.cum.findIndex((s) => s >= 600)];
  assert.ok(kmh(atCorner) < 20);
});

test("sampleAt is continuous and ends at the last point", () => {
  const a = [48.85, 2.29];
  const b = destination(a, 45, 500);
  const tl = buildTimeline([{ points: [a, b], kmh: 30, mode: "bike" }]);
  let last = 0;
  for (let i = 0; i <= 100; i++) {
    const s = sampleAt(tl, (tl.duration * i) / 100).s;
    assert.ok(s >= last - 1e-6);
    last = s;
  }
  const end = sampleAt(tl, tl.duration + 5);
  assert.ok(distance(end.pos, b) < 0.01);
});
