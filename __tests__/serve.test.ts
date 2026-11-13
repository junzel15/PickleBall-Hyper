/**
 * The serve looks like a real underhand drop serve: the ball is held out in front,
 * beside the body (visible, never painted over the server's back), the paddle swings
 * back while the free hand brings the ball across and drops it, and the paddle meets
 * it below the waist on the paddle side, in front of the body.
 * @format
 */
import './helpers/engineMocks';
import { createGame } from '../src/game/engine';

const DT = 1 / 120;
const WAIST = 2.6; // contact must be below the waist (legal serve)

function toMyServe() {
  const g = createGame();
  g.startGame();
  for (let t = 0; t < 10 && !(g.debug().state === 'serve' && g.debug().serverIsMe); t += DT) g.step(DT);
  expect(g.debug().state).toBe('serve');
  expect(g.debug().serverIsMe).toBe(true);
  return g;
}

describe('serve', () => {
  test('waiting: ball held out in front, beside the body (not behind or on the back)', () => {
    const g = toMyServe();
    g.step(0.5);
    const [u, z, w] = g.debug().serveBall;
    expect(w).toBeGreaterThan(0.4);        // in front of the body, toward the net
    expect(Math.abs(u)).toBeGreaterThan(0.6); // clear of the torso (half width ~0.5 ft) so it shows beside it
    expect(z).toBeGreaterThan(2.9);        // about waist height, in the free hand
    expect(z).toBeLessThan(3.5);
    expect(g.debug().held).toBe(true);
  });

  test('tap: wind-up, the ball is carried across and dropped, contact below the waist on the paddle side', () => {
    const g = toMyServe();
    g.step(0.3);
    g.testInput({ tap: 'drive' });
    const path: { t: number; u: number; z: number; w: number; st: string; strokeT: number }[] = [];
    let launchedAt = -1, contact: number[] = [], strokeAtContact = 0;
    for (let t = 0; t < 1; t += DT) {
      const before = g.debug();
      g.step(DT);
      const d = g.debug();
      if (d.state === 'serve') path.push({ t, u: d.serveBall[0], z: d.serveBall[1], w: d.serveBall[2], st: d.state, strokeT: d.serverStrokeT });
      if (before.state === 'serve' && d.state === 'rally') {
        launchedAt = t;
        contact = before.serveBall;
        strokeAtContact = d.serverStrokeT;
        break;
      }
    }
    // a short, natural wind-up (not instant, not sluggish)
    expect(launchedAt).toBeGreaterThan(0.3);
    expect(launchedAt).toBeLessThan(0.6);
    // the ball goes from the free-hand side to the paddle side, then falls
    expect(path[0].u).toBeLessThan(-0.5);
    const [u, z, w] = contact;
    expect(u).toBeGreaterThan(0.4);   // paddle side
    expect(w).toBeGreaterThan(0.4);   // in front of the body
    expect(z).toBeLessThan(WAIST);    // below the waist: a legal underhand serve
    expect(z).toBeGreaterThan(1.5);
    const falling = path.filter(p => p.u > 0.5);
    for (let i = 1; i < falling.length; i++) expect(falling[i].z).toBeLessThanOrEqual(falling[i - 1].z + 1e-9); // drops, never floats up
    // the paddle is at the contact point of the swing when the ball leaves
    expect(strokeAtContact).toBeGreaterThan(0.4);
    expect(strokeAtContact).toBeLessThan(0.6);
    // serving starts the rally normally
    expect(g.debug().shots).toBe(1);
    expect(g.debug().held).toBe(false);
  });

  test('a second tap during the wind-up does not serve twice; you stay planted', () => {
    const g = toMyServe();
    g.testInput({ tap: 'drive' });
    const x0 = g.debug().px;
    g.testInput({ dx: 1, dy: 0 });
    g.step(0.1);
    g.testInput({ tap: 'drive' });
    for (let t = 0; t < 1 && g.debug().state === 'serve'; t += DT) g.step(DT);
    expect(g.debug().state).toBe('rally');
    expect(g.debug().shots).toBe(1);
    expect(Math.abs(g.debug().px - x0)).toBeLessThan(0.05);
  });

  test('the CPU serves the same way', () => {
    const g = createGame();
    g.startGame();
    let saw = false;
    for (let t = 0; t < 120 && !saw; t += DT) {
      const before = g.debug();
      g.step(DT);
      const d = g.debug();
      if (before.state === 'serve' && !before.serverIsMe && before.serveWindT > 0 && d.state === 'rally') {
        const [u, z, w] = before.serveBall;
        expect(u).toBeGreaterThan(0.4);
        expect(w).toBeGreaterThan(0.4);
        expect(z).toBeLessThan(WAIST);
        saw = true;
      }
      if (d.state === 'serve' && d.serverIsMe) g.testInput({ tap: 'drive' });
    }
    expect(saw).toBe(true);
  });
});

describe('hitting: the paddle meets the ball', () => {
  test('at contact the paddle face is at the ball, for every kind of shot you play', async () => {
    const { makePilot } = require('./helpers/autopilot');
    const g = createGame();
    g.startGame();
    const pilot = makePilot(g);
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const checked: string[] = [];
    const lowBalls: number[] = [];
    let worstTarget = 0, worstDrawn = 0;
    for (let t = 0; t < 240 && checked.length < 25; t += DT) {
      pilot.tick(DT);
      g.step(DT);
      const s = g.debug().swing;
      if (!s || s.kind === 'serve') continue;
      if (s.t >= 0.44 && s.t <= 0.52 && !checked.includes(`${s.kind}@${s.ball.map((v: number) => v.toFixed(2))}`)) {
        checked.push(`${s.kind}@${s.ball.map((v: number) => v.toFixed(2))}`);
        worstTarget = Math.max(worstTarget, dist(s.face, s.ball));
        if (s.drawn) worstDrawn = Math.max(worstDrawn, dist(s.drawn, s.ball));
        if (s.ball[1] < 1.6) lowBalls.push(s.crouch);
      }
    }
    expect(checked.length).toBeGreaterThan(5);
    // the swing is aimed at the ball (within its reach limits) and what you see is close behind
    expect(worstTarget).toBeLessThan(0.9);
    expect(worstDrawn).toBeLessThan(1.4);
    // low balls are played with bent knees
    for (const c of lowBalls) expect(c).toBeGreaterThan(0.5);
  });
});
