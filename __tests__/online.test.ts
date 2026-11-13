/**
 * Online play without a network: the scoring rules used by the server, message
 * checks, and two real game engines (host + guest) joined by an in-memory link
 * with latency, playing complete matches through the normal touch inputs.
 * @format
 */
import './helpers/engineMocks';
import { checkReport, parseReport, replay, replaySingles } from '../supabase/functions/_shared/rules';
import { createGame, Game, OnlineMatchEnd } from '../src/game/engine';
import { defaultProfile } from '../src/game/customize';
import { mirrorBall, packBall, parseGuestMsg, parseHostMsg, RallyW } from '../src/game/net';
import { makePilot } from './helpers/autopilot';

// ---------------------------------------------------------------------------
// Rules (the Edge Function's check)
// ---------------------------------------------------------------------------
const rallies = (s: string, gap = 4000): RallyW[] => s.split('').map((w, i) => ({ w: w as 'h' | 'g', t: (i + 1) * gap }));

describe('server scoring rules', () => {
  test('a host shutout 11-0 is 11 straight host rallies', () => {
    const r = replaySingles(rallies('hhhhhhhhhhh'));
    expect(r).toEqual({ ok: true, host: 11, guest: 0, winner: 'h', lastT: 44000 });
  });
  test('only the server scores: a won return is a side out', () => {
    // h serves: h scores 1; g wins rally -> side out (no point); g scores 11 straight
    const r = replaySingles(rallies('hg' + 'g'.repeat(11)));
    expect(r).toEqual({ ok: true, host: 1, guest: 11, winner: 'g', lastT: 13 * 4000 });
  });
  test('win by two', () => {
    // 10-10 (alternating side outs), then the server needs two clear
    let s = '';
    for (let i = 0; i < 10; i++) s += 'h';          // h 10-0
    s += 'g';                                        // side out
    for (let i = 0; i < 10; i++) s += 'g';           // g 10-10
    s += 'h';                                        // side out
    s += 'h';                                        // h 11-10, not over
    expect(replaySingles(rallies(s))).toEqual({ ok: false, reason: 'game_not_finished' });
    expect(replaySingles(rallies(s + 'h'))).toMatchObject({ ok: true, host: 12, guest: 10 });
  });
  test('impossible logs are rejected', () => {
    expect(replaySingles(rallies('hhhhhhhhhhhh'))).toEqual({ ok: false, reason: 'rallies_after_game_end' });
    expect(replaySingles(rallies('hhhhh'))).toEqual({ ok: false, reason: 'too_few_rallies' });
    expect(replaySingles(rallies('hhhhhhhhhhh', 200))).toMatchObject({ ok: false });
    expect(replaySingles([{ w: 'x', t: 1 }])).toMatchObject({ ok: false });
    expect(replaySingles('nope')).toMatchObject({ ok: false });
  });
  test('the claimed score must match the rallies', () => {
    const good = { match_id: '00000000-0000-4000-8000-000000000000', host_score: 11, guest_score: 0, longest_rally: 3, rallies: rallies('hhhhhhhhhhh') };
    expect(checkReport(good)).toMatchObject({ valid: true, winners: 'hhhhhhhhhhh' });
    expect(checkReport({ ...good, guest_score: 5 })).toMatchObject({ valid: false, reason: 'score_does_not_match_rallies' });
    expect(checkReport({ ...good, longest_rally: 900 })).toMatchObject({ valid: false, reason: 'rally_too_long_for_time' });
    expect(parseReport({ ...good, match_id: 'x' })).toBeNull();
    expect(parseReport({ ...good, host_score: -1 })).toBeNull();
    expect(parseReport(good)).not.toBeNull();
  });
});

describe('wire messages', () => {
  test('guest messages are validated by the host', () => {
    expect(parseGuestMsg({ k: 'in', x: 1, y: 2, a: 0, s: 1 })).toEqual({ k: 'in', x: 1, y: 2, a: 0, s: 1 });
    expect(parseGuestMsg({ k: 'in', x: 'a', y: 2, a: 0, s: 1 })).toBeNull();
    expect(parseGuestMsg({ k: 'shot', ty: 'smash', a: 1 })).toEqual({ k: 'shot', ty: 'smash', a: 1 });
    expect(parseGuestMsg({ k: 'shot', ty: 'nuke', a: 1 })).toBeNull();
    expect(parseGuestMsg({ k: 'score', v: 11 })).toBeNull();
    expect(parseGuestMsg(null)).toBeNull();
    expect(parseHostMsg({ k: 'ev', e: { k: 'setup' } })).not.toBeNull();
    expect(parseHostMsg({ k: 'snap' })).toBeNull();
  });
  test('the guest sees the court mirrored', () => {
    const b = packBall({ x: 4, y: 10, z: 3, vx: 2, vy: 30, vz: -1, g: 32, held: false, netted: false, power: true });
    expect(mirrorBall(b)).toEqual([16, 34, 3, -2, -30, -1, 32, 4]);
  });
});

// ---------------------------------------------------------------------------
// Two engines over an in-memory link
// ---------------------------------------------------------------------------
interface Table {
  /** engines by seat (seat 0 = host) */
  seats: Game[];
  host: Game;
  guest: Game;            // seat 1
  hostMsgs: unknown[];
  guestMsgs: unknown[];   // everything any guest sent
  tick: (dt: number) => void;
  /** cut a seat's link (or every guest's link when no seat is given) */
  drop: (on: boolean, seat?: number) => void;
}

const NAMES = ['Hana Host', 'Gil Guest', 'Pia Partner', 'Rex Rival'];
const look = (name: string) => ({ name, avatar: defaultProfile().avatar, paddle: 'tidal-wave' });

/**
 * Real engines (one per seat) wired together like netplay does: the host's messages go
 * to every guest; each guest's messages reach only the host, tagged with its seat.
 */
function table(mode: 'singles' | 'doubles' = 'singles', latencyMs = 60, jitterMs = 0): Table {
  const n = mode === 'doubles' ? 4 : 2;
  let t = 0;
  const cut = new Set<number>();
  const games: Game[] = [];
  const toGuest: { at: number; m: unknown }[][] = [];
  const toHost: { at: number; seat: number; m: unknown }[] = [];
  const hostMsgs: unknown[] = [];
  const guestMsgs: unknown[] = [];
  for (let s = 0; s < n; s++) {
    const g = createGame();
    g.setProfile({ ...defaultProfile(), name: NAMES[s] });
    games.push(g);
    toGuest.push([]);
  }
  games.forEach((g, s) => {
    g.startOnline({
      role: s === 0 ? 'host' : 'guest', mode, seat: s,
      others: NAMES.slice(0, n).map((name, i) => ({ seat: i, look: look(name) })).filter(o => o.seat !== s),
      send: m => {
        const copy = JSON.parse(JSON.stringify(m));
        // phone-like delivery: a base delay plus uneven extra delay, still in order
        const at = (q: { at: number }[]) => Math.max(t + latencyMs + Math.random() * jitterMs, q.length ? q[q.length - 1].at : 0);
        if (s === 0) {
          hostMsgs.push(m);
          for (let i = 1; i < n; i++) if (!cut.has(i)) toGuest[i].push({ at: at(toGuest[i]), m: copy });
        } else {
          guestMsgs.push(m);
          if (!cut.has(s)) toHost.push({ at: at(toHost), seat: s, m: copy });
        }
      },
    });
  });
  return {
    seats: games, host: games[0], guest: games[1], hostMsgs, guestMsgs,
    drop(on, seat) {
      const list = seat === undefined ? games.map((_, i) => i).slice(1) : [seat];
      for (const i of list) { if (on) cut.add(i); else cut.delete(i); }
    },
    tick(dt: number) {
      t += dt * 1000;
      while (toHost.length && toHost[0].at <= t) { const x = toHost.shift()!; games[0].netReceive(x.m, x.seat); }
      for (let i = 1; i < n; i++) {
        const q = toGuest[i];
        while (q.length && q[0].at <= t) games[i].netReceive(q.shift()!.m);
      }
      for (const g of games) g.step(dt);
    },
  };
}

const connect = (latencyMs = 60) => table('singles', latencyMs);

/** What netplay does when the guests' first messages arrive. */
function begin(L: Table) {
  L.seats.forEach((_, s) => { if (s > 0) L.host.netReceive({ k: 'hello' }, s); });
  L.host.setNetHold(false);
}

const events = (msgs: unknown[], kind: string) =>
  msgs.filter((m): m is { k: 'ev'; e: Record<string, unknown> } => (m as { k: string }).k === 'ev' && (m as { e: { k: string } }).e.k === kind)
    .map(m => m.e);

describe('online match between two engines', () => {
  test('a whole match stays in sync and both sides report the same valid result', () => {
    const L = connect(60);
    const ends: Record<'host' | 'guest', OnlineMatchEnd | null> = { host: null, guest: null };
    L.host.onOnlineEnd(r => { ends.host = r; });
    L.guest.onOnlineEnd(r => { ends.guest = r; });

    const dt = 1 / 60;
    // first 60 s: both play every ball with every shot type and use Hyper; then the guest
    // only serves so the match finishes
    let simT = 0;
    const hostPilot = makePilot(L.host, { hyper: true });
    const guestPilot = makePilot(L.guest, { hyper: true, mode: () => (simT < 60 ? 'play' : 'serve-only') });
    // the host waits for the guest's hello before anything moves (netplay sends it on joining)
    begin(L);

    let maxPosErr = 0;
    let scoreMismatchTicks = 0;
    const hostTrail: { x: number; y: number }[] = [];
    for (; simT < 1500 && !(ends.host && ends.guest); simT += dt) {
      hostPilot.tick(dt);
      guestPilot.tick(dt);
      L.tick(dt);
      const h = L.host.debug(), g = L.guest.debug();
      hostTrail.push({ x: h.px, y: h.py });
      if (hostTrail.length > 30) hostTrail.shift();
      if (h.state === 'rally' && g.state === 'rally') {
        // the guest sees the host (mirrored) where the host was a network delay ago:
        // compare with the host's positions over the last half second
        const err = Math.min(...hostTrail.map(p => Math.hypot(g.ox - (20 - p.x), g.oy - (44 - p.y))));
        maxPosErr = Math.max(maxPosErr, err);
      }
      if (h.state === 'serve' && g.state === 'serve') {
        if (h.score.player !== g.score.ai || h.score.ai !== g.score.player) scoreMismatchTicks++;
      }
    }
    expect(ends.host).not.toBeNull();
    expect(ends.guest).not.toBeNull();
    const H = ends.host as OnlineMatchEnd, G = ends.guest as OnlineMatchEnd;

    // same final score and identical rally-by-rally record on both phones
    expect(G.hostScore).toBe(H.hostScore);
    expect(G.guestScore).toBe(H.guestScore);
    expect(G.rallies.map(r => r.w).join('')).toBe(H.rallies.map(r => r.w).join(''));
    expect(Math.max(H.hostScore, H.guestScore)).toBeGreaterThanOrEqual(11);
    expect(Math.abs(H.hostScore - H.guestScore)).toBeGreaterThanOrEqual(2);
    // both reports pass the server's rule check
    for (const e of [H, G]) {
      const c = checkReport({ match_id: '00000000-0000-4000-8000-000000000000', host_score: e.hostScore, guest_score: e.guestScore, longest_rally: e.longestRally, rallies: e.rallies });
      expect(c.valid).toBe(true);
    }
    // scores matched whenever both were between points; the host is drawn where it really was
    expect(scoreMismatchTicks).toBe(0);
    expect(maxPosErr).toBeLessThan(1.0);
    // the game-over screens agree (mirrored)
    expect(L.host.getUi().gameOver.score).toBe(`${H.hostScore} – ${H.guestScore}`);
    expect(L.guest.getUi().gameOver.score).toBe(`${H.guestScore} – ${H.hostScore}`);

    // the guest's shots were played on the host: every type reached the host's match
    const hits = events(L.hostMsgs, 'hit');
    const guestHits = hits.filter(e => e.t === 1);
    const hostHits = hits.filter(e => e.t === 0);
    expect(guestHits.length).toBeGreaterThan(3);
    expect(hostHits.length).toBeGreaterThan(3);
    const types = new Set(hits.map(e => (e.sm ? 'smash' : e.ty)));
    for (const ty of ['drive', 'lob', 'dink']) expect(types.has(ty)).toBe(true);
    expect(guestPilot.shotsTapped.smash + hostPilot.shotsTapped.smash).toBeGreaterThan(0);
    // Hyper: both players charged it and switched it on; their shots carried it
    const hypers = events(L.hostMsgs, 'hyper').filter(e => e.a === 'on');
    expect(hypers.some(e => e.s === 0)).toBe(true);
    expect(hypers.some(e => e.s === 1)).toBe(true);
    expect(hits.some(e => e.hy === true)).toBe(true);
    // the guest never sent anything but inputs
    const kinds = new Set(L.guestMsgs.map(m => (m as { k: string }).k));
    for (const k of kinds) expect(['in', 'shot', 'hyper', 'hello', 'need_log']).toContain(k);
  });

  test('running on a slow, uneven connection: your player never jumps or flickers', () => {
    // 150 ms each way plus up to 120 ms of jitter (a busy mobile network)
    const T = table('singles', 150, 120);
    const dt = 1 / 60;
    const hp = makePilot(T.host);
    const gp = makePilot(T.guest); // runs side to side to reach every ball
    begin(T);
    let prev = T.guest.debug();
    let jumps = 0, frames = 0, maxStep = 0;
    for (let t = 0; t < 90; t += dt) {
      hp.tick(dt); gp.tick(dt); T.tick(dt);
      const d = T.guest.debug();
      if (d.state === prev.state && d.state === 'rally') { // a new serve places everyone: not a glitch
        const step = Math.hypot(d.px - prev.px, d.py - prev.py);
        maxStep = Math.max(maxStep, step);
        frames++;
        if (step > 1.2) jumps++; // full speed is ~0.33 ft per frame; a lunge ~0.4
      }
      prev = d;
    }
    expect(frames).toBeGreaterThan(600); // there was real running in rallies
    expect(jumps).toBe(0);
    expect(maxStep).toBeLessThan(1.2);
  });

  test('the host holds the match while the guest is away, then carries on', () => {
    const L = connect(40);
    const dt = 1 / 60;
    begin(L);
    for (let i = 0; i < 120; i++) L.tick(dt);
    // play is running: the host moves when the stick is pushed
    const x0 = L.host.debug().px;
    for (let i = 0; i < 30; i++) { L.host.testInput({ dx: -1, dy: 0 }); L.tick(dt); }
    L.host.testInput({ dx: 0, dy: 0 });
    expect(L.host.debug().px).not.toBe(x0);
    // guest drops out: the host is told to hold (netplay does this after 2.5 s of silence)
    L.drop(true);
    L.host.setNetHold(true);
    const before = L.host.debug();
    for (let i = 0; i < 600; i++) { L.host.testInput({ dx: 1, dy: 0 }); L.tick(dt); }
    const during = L.host.debug();
    expect(during.netHold).toBe(true);
    expect(during.px).toBe(before.px);              // nothing moves
    expect(during.score).toEqual(before.score);
    // guest back
    L.drop(false);
    L.host.setNetHold(false);
    L.host.testInput({ dx: 0, dy: 0 });
    const scoreBefore = L.host.debug().score;
    for (let i = 0; i < 300; i++) L.tick(dt);
    expect(L.host.debug().netHold).toBe(false);
    expect(L.guest.debug().score).toEqual({ player: scoreBefore.ai, ai: scoreBefore.player });
  });

  test('a guest that missed rally results gets the full list back from the host', () => {
    const L = connect(30);
    const dt = 1 / 60;
    const hostPilot = makePilot(L.host);
    const guestPilot = makePilot(L.guest, { mode: () => 'serve-only' });
    begin(L);
    // let a few rallies happen while every message to the guest is lost
    L.drop(true);
    for (let t = 0; t < 25; t += dt) { hostPilot.tick(dt); guestPilot.tick(dt); L.tick(dt); }
    const missed = L.host.debug().rallies.length;
    expect(missed).toBeGreaterThan(0);
    expect(L.guest.debug().rallies.length).toBe(0);
    L.drop(false);
    for (let t = 0; t < 5; t += dt) { L.tick(dt); }
    expect(L.guest.debug().rallies.map(r => r.w)).toEqual(L.host.debug().rallies.map(r => r.w).slice(0, L.guest.debug().rallies.length));
    expect(L.guest.debug().rallies.length).toBeGreaterThanOrEqual(missed);
  });

  test('a host restart resumes from the saved score', () => {
    const L = connect(30);
    const dt = 1 / 60;
    const hp = makePilot(L.host);
    const gp = makePilot(L.guest, { mode: () => 'serve-only' });
    begin(L);
    for (let t = 0; t < 30; t += dt) { hp.tick(dt); gp.tick(dt); L.tick(dt); }
    expect(L.host.debug().rallies.length).toBeGreaterThan(0);
    const saved = L.host.exportResume();
    expect(saved).not.toBeNull();
    const fresh = createGame();
    fresh.startOnline({ role: 'host', mode: 'singles', seat: 0, send: () => {}, others: [{ seat: 1, look: look('Gil Guest') }], resume: saved });
    const d = fresh.debug();
    expect(d.score).toEqual(L.host.debug().score);
    expect(d.rallies).toEqual(saved!.rallies);
    expect(d.state).toBe('serve');
  });

  test('offline play is unchanged: CPU match, no network, no online UI', () => {
    const g = createGame();
    const sent: unknown[] = [];
    g.startGame();
    const p = makePilot(g);
    // play until someone scores (rallies can end in side outs with no point)
    for (let t = 0; t < 600 && g.debug().score.player + g.debug().score.ai === 0; t += 1 / 60) { p.tick(1 / 60); g.step(1 / 60); }
    const d = g.debug();
    expect(d.role).toBe('off');
    expect(g.getUi().online).toBeNull();
    expect(d.rallies.length).toBe(0);
    expect(sent.length).toBe(0);
    expect(d.score.player + d.score.ai).toBeGreaterThan(0);
  });

  test('CPU opponents have different styles; on Hard they charge and use Hyper, on Easy never', () => {
    const run = (difficulty: 'easy' | 'hard', seconds: number) => {
      const g = createGame();
      g.setSelectedMode('doubles');
      g.setDifficulty(difficulty);
      g.startGame();
      const p = makePilot(g);
      let botHyper = 0, maxBotEnergy = 0;
      const styles = new Set(g.debug().bots.filter(b => b.team === 'ai').map(b => b.style));
      for (let t = 0; t < seconds && g.debug().state !== 'over'; t += 1 / 60) {
        p.tick(1 / 60);
        g.step(1 / 60);
        for (const b of g.debug().bots) {
          maxBotEnergy = Math.max(maxBotEnergy, b.energy);
          if (b.hyperT > 0) botHyper++;
        }
      }
      return { styles, botHyper, maxBotEnergy, d: g.debug() };
    };
    const hard = run('hard', 400);
    expect(hard.styles.size).toBe(2); // the two opponents play differently
    expect(hard.maxBotEnergy).toBeGreaterThan(50);
    expect(hard.botHyper).toBeGreaterThan(0);
    const easy = run('easy', 120);
    expect(easy.maxBotEnergy).toBe(0);
    expect(easy.botHyper).toBe(0);
  });

  test('a shot tapped early (as soon as the opponent hits) still meets the ball', () => {
    const g = createGame();
    g.setSelectedMode('singles');
    g.setDifficulty('medium');
    g.startGame();
    const p = makePilot(g, { tapEarly: true, shots: ['drive', 'lob', 'dink'] });
    let incoming = 0, returned = 0, prevHitter: string | null = null, prevShots = 0;
    for (let t = 0; t < 300 && g.debug().state !== 'over'; t += 1 / 60) {
      p.tick(1 / 60);
      g.step(1 / 60);
      const d = g.debug();
      // a new ball from the CPU that is coming to us, in play past the serve
      if (d.lastHitter === 'ai' && (prevHitter !== 'ai' || d.shots !== prevShots) && d.shots >= 2) incoming++;
      if (d.lastHitter === 'player' && prevHitter === 'ai') returned++;
      prevHitter = d.lastHitter; prevShots = d.shots;
    }
    expect(incoming).toBeGreaterThan(10);
    // the queued shot waits for the ball instead of running out on the way
    expect(returned / incoming).toBeGreaterThan(0.6);
  });

  test('leaving an online match restores the CPU opponent', () => {
    const L = connect(30);
    L.host.endOnline();
    const d = L.host.debug();
    expect(d.role).toBe('off');
    expect(L.host.getUi().online).toBeNull();
    expect(L.host.getUi().menuOpen).toBe(true);
    L.host.startGame();
    expect(L.host.debug().state).toBe('serve');
  });
});

// ---------------------------------------------------------------------------
// 2 vs 2: four real engines (host + 3 guests)
// ---------------------------------------------------------------------------
describe('doubles scoring rules', () => {
  test('doubles starts 0-0-2: the first lost serve is a side out', () => {
    // team A scores 2, loses its only serve (side out); team B loses on both servers
    // (second server, then side out); team A then scores 9 straight
    const log = 'hh' + 'g' + 'h' + 'h' + 'h'.repeat(9);
    expect(replay(rallies(log), 'doubles')).toMatchObject({ ok: true, host: 11, guest: 0 });
    // the same log is not a finished singles game
    expect(replay(rallies(log), 'singles')).toMatchObject({ ok: false });
  });
  test('both partners serve before a side out', () => {
    // A loses at 0-0-2 -> side out. B (server 1) scores 3, loses (server 2), scores 2,
    // loses -> side out. A (server 1) then scores 11 straight: 11-5
    const log = 'g' + 'ggg' + 'h' + 'gg' + 'h' + 'h'.repeat(11);
    expect(replay(rallies(log), 'doubles')).toMatchObject({ ok: true, host: 11, guest: 5 });
  });
});

describe('online 2 vs 2 between four engines', () => {
  test('seats see the right court: team A as the host does, team B mirrored', () => {
    const T = table('doubles', 30);
    begin(T);
    for (let i = 0; i < 90; i++) T.tick(1 / 60);
    const [h, g1, g2, g3] = T.seats.map(g => g.debug());
    expect(h.role).toBe('host');
    expect([g1.seat, g2.seat, g3.seat]).toEqual([1, 2, 3]);
    const pos = (d: typeof h, seat: number) => d.athletes.find(a => a.seat === seat)!;
    // the host's partner (seat 2, team A) sees everyone where the host does
    for (const s of [0, 1, 2, 3]) {
      expect(Math.hypot(pos(g2, s).x - pos(h, s).x, pos(g2, s).y - pos(h, s).y)).toBeLessThan(1.5);
    }
    // team B (seats 1 and 3) see the court mirrored, themselves at the bottom
    for (const g of [g1, g3]) {
      for (const s of [0, 1, 2, 3]) {
        expect(Math.hypot(pos(g, s).x - (20 - pos(h, s).x), pos(g, s).y - (44 - pos(h, s).y))).toBeLessThan(1.5);
      }
      expect(pos(g, g.seat).team).toBe('player');
      expect(pos(g, g.seat).y).toBeGreaterThan(22); // bottom half
    }
    // partners are on the same team on every phone
    expect(pos(g1, 3).team).toBe('player');
    expect(pos(g2, 0).team).toBe('player');
    expect(pos(h, 1).team).toBe('ai');
    // the game starts "0-0-2" on every phone
    expect(h.serverNum).toBe(2);
    expect(g1.serverNum).toBe(2);
    expect(g3.serverNum).toBe(2);
  });

  test('a whole doubles match: all four phones agree, every player hits, the server accepts it', () => {
    const T = table('doubles', 50);
    const ends: (OnlineMatchEnd | null)[] = [null, null, null, null];
    T.seats.forEach((g, s) => g.onOnlineEnd(r => { ends[s] = r; }));
    const dt = 1 / 60;
    let simT = 0;
    const pilots = T.seats.map((g, s) => makePilot(g, {
      hyper: true,
      // after 90 s team B stops returning so the match finishes
      mode: () => (s % 2 === 1 && simT > 90 ? 'serve-only' : 'play'),
    }));
    begin(T);
    let scoreMismatch = 0;
    for (; simT < 2400 && ends.some(e => !e); simT += dt) {
      pilots.forEach(p => p.tick(dt));
      T.tick(dt);
      const ds = T.seats.map(g => g.debug());
      if (ds.every(d => d.state === 'serve')) {
        const a = ds[0].score; // host: player = team A
        for (const d of ds.slice(1)) {
          const teamA = d.seat % 2 === 0 ? d.score.player : d.score.ai;
          const teamB = d.seat % 2 === 0 ? d.score.ai : d.score.player;
          if (teamA !== a.player || teamB !== a.ai) scoreMismatch++;
        }
      }
    }
    expect(ends.every(Boolean)).toBe(true);
    const E = ends as OnlineMatchEnd[];
    for (const e of E.slice(1)) {
      expect(e.hostScore).toBe(E[0].hostScore);
      expect(e.guestScore).toBe(E[0].guestScore);
      expect(e.rallies.map(r => r.w).join('')).toBe(E[0].rallies.map(r => r.w).join(''));
    }
    expect(scoreMismatch).toBe(0);
    for (const e of E) {
      const c = checkReport({
        match_id: '00000000-0000-4000-8000-000000000000', host_score: e.hostScore, guest_score: e.guestScore,
        longest_rally: e.longestRally, rallies: e.rallies,
      }, 'doubles');
      expect(c.valid).toBe(true);
    }
    // all four people hit the ball; Hyper was used by more than one player
    const hits = events(T.hostMsgs, 'hit');
    for (const s of [0, 1, 2, 3]) expect(hits.filter(h => h.s === s).length).toBeGreaterThan(0);
    const hyperOn = events(T.hostMsgs, 'hyper').filter(e => e.a === 'on');
    expect(new Set(hyperOn.map(e => e.s)).size).toBeGreaterThanOrEqual(2);
    // every guest only ever sent inputs
    for (const m of T.guestMsgs) expect(['in', 'shot', 'hyper', 'hello', 'need_log']).toContain((m as { k: string }).k);
    // game-over screens agree, each from its own side
    const sA = `${E[0].hostScore} – ${E[0].guestScore}`, sB = `${E[0].guestScore} – ${E[0].hostScore}`;
    T.seats.forEach((g, s) => expect(g.getUi().gameOver.score).toBe(s % 2 === 0 ? sA : sB));
  });

  test('one player dropping holds the match for everyone and names who is missing', () => {
    const T = table('doubles', 30);
    begin(T);
    for (let i = 0; i < 60; i++) T.tick(1 / 60);
    T.drop(true, 3);
    T.host.setNetHold(true, 'Rex Rival'); // what netplay does after 2.5 s of silence from seat 3
    const scoreBefore = T.host.debug().score;
    for (let i = 0; i < 90; i++) T.tick(1 / 60);
    expect(T.host.debug().netHold).toBe(true);
    expect(T.host.debug().score).toEqual(scoreBefore);
    // the others keep hearing from the host and are told who everyone is waiting for
    expect(T.seats[1].netWaitingFor()).toBe('Rex Rival');
    expect(T.seats[2].netWaitingFor()).toBe('Rex Rival');
    T.drop(false, 3);
    T.host.setNetHold(false);
    for (let i = 0; i < 30; i++) T.tick(1 / 60);
    expect(T.seats[1].netWaitingFor()).toBe('');
  });

  test('a guest cannot act for another seat: inputs only move the sender', () => {
    const T = table('doubles', 0);
    begin(T);
    for (let i = 0; i < 60; i++) T.tick(1 / 60);
    const seat3 = () => T.host.debug().athletes.find(a => a.seat === 3)!;
    const before = seat3();
    // seat 1 reports a position; the host moves seat 1 there and nobody else
    for (let i = 0; i < 90; i++) { T.host.netReceive({ k: 'in', x: 2, y: 3, a: 0, s: 1 }, 1); T.host.step(1 / 60); }
    const mover = T.host.debug().athletes.find(a => a.seat === 1)!;
    expect(seat3().x).toBeCloseTo(before.x, 5);
    expect(Math.hypot(mover.x - 2, mover.y - 3)).toBeLessThan(0.5);
    // messages arriving "from" the host's own seat or a seat that doesn't exist do nothing
    const hostX = T.host.debug().px;
    T.host.netReceive({ k: 'in', x: 1, y: 40, a: 0, s: 1 }, 0);
    T.host.netReceive({ k: 'in', x: 1, y: 40, a: 0, s: 1 }, 7);
    T.host.step(0.5);
    expect(T.host.debug().px).toBe(hostX);
  });
});

describe('online serve motion', () => {
  test('the guest sees the host server\'s wind-up and ball drop before the serve', () => {
    const T = table('singles', 60);
    begin(T);
    const dt = 1 / 60;
    for (let t = 0; t < 5 && !(T.host.debug().state === 'serve' && T.guest.debug().state === 'serve'); t += dt) T.tick(dt);
    expect(T.host.debug().serverSeat).toBe(0); // the host serves first
    T.host.testInput({ tap: 'drive' });
    expect(T.hostMsgs.some(m => (m as { e?: { k?: string } }).e?.k === 'wind')).toBe(true);
    let guestWound = false, served = false;
    for (let t = 0; t < 2 && !served; t += dt) {
      T.tick(dt);
      const g = T.guest.debug();
      if (g.state === 'serve' && g.serveWindT > 0) guestWound = true;
      if (g.state === 'rally') served = true;
    }
    expect(guestWound).toBe(true);
    expect(served).toBe(true);
    expect(T.guest.debug().serveWindT).toBe(-1); // cleared by the serve
  });
});
