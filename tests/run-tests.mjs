// Unit tests for the pure logic in index.html (angle math, filter, rep state machine).
// Run with:  node tests/run-tests.mjs
// No dependencies: the <script id="core"> block is pulled out of index.html and evaluated here.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const coreSrc = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const C = new Function(`${coreSrc}\nreturn SquatCore;`)();
const { RepMachine, AngleTracker, SidePicker, State, kneeAngle } = C;

const FPS = 30;
const DT = 1000 / FPS;

/** Linear angle ramp, one value per frame, at the given speed. Excludes `from`, includes `to`. */
function ramp(from, to, degPerSec = 120, fps = FPS) {
  const step = degPerSec / fps * Math.sign(to - from);
  const out = [];
  for (let a = from + step; step > 0 ? a < to : a > to; a += step) out.push(a);
  out.push(to);
  return out;
}
const hold = (angle, frames) => Array(frames).fill(angle);
/** One squat: stand, go down to `bottom`, pause, come back up. */
const squat = (bottom, speed = 120, top = 172) =>
  [...hold(top, 5), ...ramp(top, bottom, speed), ...hold(bottom, 3), ...ramp(bottom, top, speed), ...hold(top, 5)];

/** Feed angles straight into a RepMachine with finite-difference velocity. Returns the events. */
function feed(machine, angles, fps = FPS) {
  const dt = 1000 / fps;
  const events = [];
  let prev = angles[0];
  machine._t = machine._t ?? 0;
  angles.forEach((angle, i) => {
    const vel = (angle - prev) / dt * 1000;
    prev = angle;
    machine._t += dt;
    const ev = machine.update(angle, vel, machine._t, dt);
    if (ev) events.push({ ...ev, frame: i, at: angle });
  });
  return events;
}
const types = (events) => events.map((e) => e.type);
const noAnticipation = (cfg = {}) => new RepMachine({ anticipate: false, ...cfg });

// ---------- Angle math ----------

test('kneeAngle: straight leg is 180, right angle is 90', () => {
  const p = (x, y) => ({ x, y });
  assert.ok(Math.abs(kneeAngle(p(0.5, 0.2), p(0.5, 0.5), p(0.5, 0.8), 100, 100) - 180) < 1e-6);
  assert.ok(Math.abs(kneeAngle(p(0.2, 0.5), p(0.5, 0.5), p(0.5, 0.8), 100, 100) - 90) < 1e-6);
});

test('kneeAngle: corrects for the frame aspect ratio', () => {
  const hip = { x: 0.4, y: 0.4 }, knee = { x: 0.5, y: 0.5 }, ankle = { x: 0.4, y: 0.6 };
  // In a square frame this is a right angle; in a 16:9 frame the same normalized points are not.
  assert.ok(Math.abs(kneeAngle(hip, knee, ankle, 100, 100) - 90) < 1e-6);
  const wide = kneeAngle(hip, knee, ankle, 1600, 900);
  const expected = 2 * Math.atan2(0.1 * 900, 0.1 * 1600) * 180 / Math.PI;
  assert.ok(Math.abs(wide - expected) < 1e-6, `got ${wide}, expected ${expected}`);
});

test('kneeAngle: degenerate points give NaN, not a crash', () => {
  const p = { x: 0.5, y: 0.5 };
  assert.ok(Number.isNaN(kneeAngle(p, p, p, 100, 100)));
});

// ---------- Rep state machine ----------

test('full rep: one ding on the first frame at or below target, rep counted on stand-up', () => {
  const m = noAnticipation();
  const angles = squat(80);
  const events = feed(m, angles);
  assert.deepEqual(types(events), ['depth', 'rep']);
  const depth = events[0];
  assert.ok(depth.at <= 90, 'ding fired at or below target');
  assert.ok(angles[depth.frame - 1] > 90, 'the frame before was still above target: no confirmation delay');
  assert.equal(depth.anticipated, false);
  assert.ok(events[1].at >= 160, 'rep completes only once back above the standing threshold');
  assert.equal(m.good, 1);
  assert.equal(m.shallow, 0);
  assert.equal(Math.round(m.lastMin), 80);
  assert.equal(m.state, State.STANDING);
});

test('rep count does not increase until the stand-up', () => {
  const m = noAnticipation();
  feed(m, [...hold(172, 5), ...ramp(172, 80), ...hold(80, 10)]);
  assert.equal(m.dings, 1);
  assert.equal(m.good, 0);
  assert.equal(m.state, State.DEPTH);
  feed(m, ramp(80, 172));
  assert.equal(m.good, 1);
});

test('shallow rep: below 130 but above target gives a shallow event and no ding', () => {
  const m = noAnticipation();
  const events = feed(m, squat(110));
  assert.deepEqual(types(events), ['shallow']);
  assert.equal(m.dings, 0);
  assert.equal(m.good, 0);
  assert.equal(m.shallow, 1);
  assert.equal(Math.round(m.lastMin), 110);
});

test('a small dip that stays above 130 is ignored', () => {
  const m = noAnticipation();
  const events = feed(m, squat(140));
  assert.deepEqual(events, []);
  assert.equal(m.shallow, 0);
  assert.equal(m.state, State.STANDING);
});

test('jitter around the target: exactly one ding', () => {
  const m = noAnticipation();
  const wobble = Array.from({ length: 60 }, (_, i) => 90 + (i % 2 ? 2.5 : -2.5)); // 87.5 / 92.5 / 87.5 ...
  const events = feed(m, [...hold(172, 5), ...ramp(172, 93), ...wobble, ...ramp(93, 172), ...hold(172, 5)]);
  assert.deepEqual(types(events), ['depth', 'rep']);
  assert.equal(m.dings, 1);
});

test('jitter around the standing threshold: no phantom reps', () => {
  const m = noAnticipation();
  const wobble = Array.from({ length: 200 }, (_, i) => 160 + 4 * Math.sin(i * 1.7)); // 156..164
  assert.deepEqual(feed(m, [...hold(172, 5), ...wobble]), []);
  assert.equal(m.good + m.shallow + m.dings, 0);
});

test('jitter around the descend threshold: no phantom reps', () => {
  const m = noAnticipation();
  const wobble = Array.from({ length: 200 }, (_, i) => 150 + 4 * Math.sin(i * 1.3)); // 146..154
  assert.deepEqual(feed(m, [...hold(172, 5), ...wobble, ...hold(172, 5)]), []);
});

test('must re-arm: no second ding until back above the standing threshold', () => {
  const m = noAnticipation();
  // Down, half-way up to 150 (below the 160 re-arm line), down again.
  let events = feed(m, [...hold(172, 5), ...ramp(172, 80), ...ramp(80, 150), ...ramp(150, 80)]);
  assert.deepEqual(types(events), ['depth']);
  // Now a proper lock-out, then the next rep dings again.
  events = feed(m, [...ramp(80, 172), ...hold(172, 3), ...ramp(172, 80), ...ramp(80, 172)]);
  assert.deepEqual(types(events), ['rep', 'depth', 'rep']);
  assert.equal(m.good, 2);
  assert.equal(Math.round(m.lastMin), 80);
});

test('five reps in a row: five dings, five good reps', () => {
  const m = noAnticipation();
  const events = feed(m, Array.from({ length: 5 }, () => squat(85)).flat());
  assert.equal(events.filter((e) => e.type === 'depth').length, 5);
  assert.equal(m.good, 5);
  assert.equal(m.shallow, 0);
});

test('mixed set: good, shallow, good', () => {
  const m = noAnticipation();
  const events = feed(m, [...squat(85), ...squat(115), ...squat(88)]);
  assert.deepEqual(types(events), ['depth', 'rep', 'shallow', 'depth', 'rep']);
  assert.equal(m.good, 2);
  assert.equal(m.shallow, 1);
});

test('not armed until seen standing: starting in a squat does not ding', () => {
  const m = noAnticipation();
  let events = feed(m, hold(80, 30));
  assert.deepEqual(events, []);
  assert.equal(m.state, State.UNKNOWN);
  events = feed(m, [...ramp(80, 172), ...squat(80)]);
  assert.deepEqual(types(events), ['depth', 'rep']);
});

test('resetState mid-rep disarms without touching the counts', () => {
  const m = noAnticipation();
  feed(m, squat(80));
  feed(m, [...hold(172, 3), ...ramp(172, 120)]);
  m.resetState();
  const events = feed(m, [...ramp(120, 80), ...hold(80, 5)]);
  assert.deepEqual(events, []);
  assert.equal(m.good, 1);
});

test('custom thresholds: target 110, standing 150', () => {
  const m = noAnticipation({ targetDeg: 110, standDeg: 150 });
  assert.equal(m.descendDeg, 140);
  const angles = [...hold(155, 5), ...ramp(155, 105), ...ramp(105, 155), ...hold(155, 5)];
  const events = feed(m, angles);
  assert.deepEqual(types(events), ['depth', 'rep']);
  assert.ok(events[0].at <= 110 && angles[events[0].frame - 1] > 110);
  assert.ok(events[1].at >= 150);
});

test('thresholds stay ordered at the slider extremes', () => {
  for (const targetDeg of [60, 90, 130]) {
    for (const standDeg of [150, 160, 175]) {
      const m = new RepMachine({ targetDeg, standDeg });
      assert.ok(m.targetDeg < m.shallowDeg, `target < shallow (${targetDeg}/${standDeg})`);
      assert.ok(m.shallowDeg <= m.descendDeg, `shallow <= descend (${targetDeg}/${standDeg})`);
      assert.ok(m.descendDeg < m.standDeg, `descend < stand (${targetDeg}/${standDeg})`);
    }
  }
  const junk = new RepMachine({ targetDeg: 'abc', standDeg: 999 });
  assert.equal(junk.targetDeg, 90);
  assert.equal(junk.standDeg, 175);
});

// ---------- Anticipation ----------

test('anticipation: dings one frame before the crossing on a steady descent', () => {
  const angles = squat(80);
  const plain = feed(noAnticipation(), angles)[0];
  const m = new RepMachine({ anticipate: true });
  const events = feed(m, angles);
  assert.deepEqual(types(events), ['depth', 'rep']);
  assert.equal(events[0].anticipated, true);
  assert.equal(events[0].frame, plain.frame - 1, 'exactly one frame earlier than without anticipation');
  assert.ok(events[0].at > 90);
  assert.equal(m.early, 1);
  assert.equal(m.earlyMissed, 0);
  assert.equal(m.earlyConfirmed, 1);
  assert.ok(Math.abs(m.earlyLeadSumMs - DT) < 1, 'logged lead is one frame');
});

test('anticipation: no early ding on a slow creep toward the target', () => {
  const m = new RepMachine({ anticipate: true });
  // 10 deg/s is below ANTICIPATE_MIN_VEL, so the ding must wait for the real crossing.
  const angles = [...hold(172, 5), ...ramp(172, 100), ...ramp(100, 88, 10), ...ramp(88, 172)];
  const events = feed(m, angles);
  assert.equal(events[0].type, 'depth');
  assert.equal(events[0].anticipated, false);
  assert.ok(events[0].at <= 90);
  assert.equal(m.early, 0);
});

test('anticipation: never fires on the way up', () => {
  const m = new RepMachine({ anticipate: true });
  // Bottoms out at 93 (above target), then rises: velocity is positive right next to the target.
  const events = feed(m, [...hold(172, 5), ...ramp(172, 100), ...ramp(100, 93, 15), ...hold(93, 3), ...ramp(93, 172)]);
  assert.deepEqual(types(events), ['shallow']);
});

test('anticipation: an early ding that never reaches target is counted as missed', () => {
  const m = new RepMachine({ anticipate: true });
  // Fast descent that stops dead at 92: the prediction fires, the knee never gets to 90.
  const events = feed(m, [...hold(172, 5), ...ramp(172, 92, 150), ...hold(92, 5), ...ramp(92, 172)]);
  assert.deepEqual(types(events), ['depth', 'rep']);
  assert.equal(events[0].anticipated, true);
  assert.equal(events[1].confirmed, false);
  assert.equal(m.early, 1);
  assert.equal(m.earlyMissed, 1);
  assert.equal(m.good, 1, 'he heard a ding, so the rep counts; the miss shows up in the log');
});

test('anticipation: lead is capped, a velocity spike cannot fire far above target', () => {
  const m = new RepMachine({ anticipate: true, extraLeadMs: 150 });
  m.update(172, 0, 0, DT);
  m.update(140, -690, DT, DT);                       // descending, absurd velocity
  assert.equal(m.update(90 + C.ANTICIPATE_MAX_DEG + 1, -690, 2 * DT, DT), null);
  assert.equal(m.update(90 + C.ANTICIPATE_MAX_DEG - 1, -690, 3 * DT, DT).type, 'depth');
});

test('anticipation: extra lead fires earlier than one frame', () => {
  const angles = squat(80);
  const oneFrame = feed(new RepMachine({ anticipate: true }), angles)[0];
  const extra = feed(new RepMachine({ anticipate: true, extraLeadMs: 60 }), angles)[0];
  assert.ok(extra.frame < oneFrame.frame);
  assert.ok(oneFrame.frame - extra.frame <= 3, '60 ms at 30 fps is about two more frames');
});

// ---------- Angle tracker (filter, velocity, glitch rejection) ----------

function track(tracker, angles, fps = FPS, t0 = 0) {
  const dt = 1000 / fps;
  return angles.map((a, i) => { const s = tracker.update(a, t0 + i * dt); return s ? { ...s } : null; });
}

test('tracker: filter lag on a steady 120 deg/s descent stays under 3 degrees', () => {
  for (const fps of [30, 60]) {
    const angles = [...hold(170, 10), ...ramp(170, 80, 120, fps)];
    const out = track(new AngleTracker(), angles, fps);
    const i = angles.findIndex((a) => a <= 95);
    const lag = out[i].angle - angles[i];
    assert.ok(lag >= 0 && lag < 3, `lag at ${fps} fps was ${lag.toFixed(2)} deg`);
  }
});

test('tracker: velocity estimate matches a steady ramp', () => {
  const out = track(new AngleTracker(), [...hold(170, 10), ...ramp(170, 80, 120)]);
  const mid = out[out.length - 5];
  assert.ok(mid.vel < -100 && mid.vel > -130, `velocity was ${mid.vel.toFixed(1)}`);
  assert.ok(Math.abs(mid.dtMs - DT) < 1);
});

test('tracker: standing jitter is reduced (the filter is deliberately light) and velocity stays small', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  // White noise of +/-1 degree is harsher than real landmark jitter, which MediaPipe pre-smooths.
  const out = track(new AngleTracker(), Array.from({ length: 240 }, () => 170 + rand()));
  const tail = out.slice(30);
  const spread = Math.max(...tail.map((s) => s.angle)) - Math.min(...tail.map((s) => s.angle));
  assert.ok(spread < 1.4, `filtered spread ${spread.toFixed(2)} should be under the raw 2.0`);
  const speeds = tail.map((s) => Math.abs(s.vel)).sort((a, b) => a - b);
  assert.ok(speeds[speeds.length >> 1] < C.ANTICIPATE_MIN_VEL / 4, 'typical jitter velocity is far below the anticipation gate');
});

test('tracker: a single-frame glitch is rejected and never reaches the state machine', () => {
  const t = new AngleTracker();
  const m = noAnticipation();
  const angles = [...hold(172, 20), 60, ...hold(172, 20)]; // one wild frame
  let events = 0, rejected = 0;
  angles.forEach((a, i) => {
    const s = t.update(a, i * DT);
    if (!s) { rejected++; return; }
    if (m.update(s.angle, s.vel, i * DT, s.dtMs)) events++;
  });
  assert.equal(rejected, 1);
  assert.equal(events, 0);
  assert.equal(m.state, State.STANDING);
});

test('tracker: a jump that persists is accepted after a couple of frames', () => {
  const out = track(new AngleTracker(), [...hold(172, 10), ...hold(100, 10)]);
  assert.equal(out[10], null);
  assert.equal(out[11], null);
  assert.ok(out[12] && Math.abs(out[12].angle - 100) < 1e-9);
});

test('tracker: restarts cleanly after a gap or a backwards timestamp', () => {
  const t = new AngleTracker();
  track(t, hold(172, 10));
  const afterGap = t.update(100, 10 * DT + C.GAP_RESET_MS + 1);
  assert.equal(afterGap.angle, 100);
  assert.equal(afterGap.vel, 0);
  const rewound = t.update(150, 5); // file replay: time goes backwards
  assert.equal(rewound.angle, 150);
  assert.equal(t.update(NaN, 50), null);
});

// ---------- End to end: noisy synthetic set through tracker + machine ----------

test('end to end: noisy 8-rep set at 30 and 60 fps, every ding lands within one frame of the true crossing', () => {
  for (const fps of [30, 60]) {
    for (const anticipate of [false, true]) {
      let seed = 42;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
      const dt = 1000 / fps, period = 3; // seconds per rep
      const truth = (tSec) => 126 + 46 * Math.cos(2 * Math.PI * tSec / period); // 172 at the top, 80 at the bottom
      const tracker = new AngleTracker(), m = new RepMachine({ anticipate });
      const dingTimes = [];
      const frames = Math.round(8 * period * fps);
      for (let i = 0; i <= frames; i++) {
        const tMs = i * dt;
        const s = tracker.update(truth(tMs / 1000) + 1.5 * rand(), tMs);
        if (!s) continue;
        const ev = m.update(s.angle, s.vel, tMs, s.dtMs);
        if (ev?.type === 'depth') dingTimes.push(tMs);
      }
      assert.equal(dingTimes.length, 8, `${fps} fps anticipate=${anticipate}: dings`);
      assert.ok(m.good >= 7, `${fps} fps: good reps ${m.good}`); // the 8th finishes on the last frame
      assert.equal(m.shallow, 0);
      // True crossing of 90 deg in each rep: cos(x) = (90-126)/46
      const phase = Math.acos((90 - 126) / 46) / (2 * Math.PI) * period * 1000;
      dingTimes.forEach((tDing, rep) => {
        const late = tDing - (rep * period * 1000 + phase);
        assert.ok(late < 2 * dt + 20, `${fps} fps anticipate=${anticipate} rep ${rep}: ding ${late.toFixed(0)} ms after crossing`);
        assert.ok(late > -3 * dt - 20, `${fps} fps anticipate=${anticipate} rep ${rep}: ding ${(-late).toFixed(0)} ms early`);
      });
    }
  }
});

// ---------- Side picker ----------

function landmarks(visL, visR) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  for (const i of C.LEG.L) lm[i].visibility = visL;
  for (const i of C.LEG.R) lm[i].visibility = visR;
  return lm;
}

test('side picker: picks the more visible leg', () => {
  assert.equal(new SidePicker().update(landmarks(0.9, 0.4), 0), 'L');
  assert.equal(new SidePicker().update(landmarks(0.3, 0.8), 0), 'R');
});

test('side picker: switches only at re-evaluation, on the average, and never mid-rep', () => {
  const p = new SidePicker();
  p.update(landmarks(0.9, 0.4), 0);
  // One flickering frame is not enough.
  p.update(landmarks(0.2, 0.9), 100);
  assert.equal(p.side, 'L');
  // Right leg clearly better for a while, but a rep is in progress (canSwitch = false).
  let t = 100;
  for (; t < 1500; t += 33) p.update(landmarks(0.3, 0.9), t, false);
  assert.equal(p.side, 'L');
  // Rep over: switch at the next evaluation.
  p.update(landmarks(0.3, 0.9), t, true);
  assert.equal(p.side, 'R');
  // Nearly equal visibility does not flip it back (margin).
  for (t += 33; t < 12000; t += 33) p.update(landmarks(0.82, 0.8), t, true);
  assert.equal(p.side, 'R');
});
