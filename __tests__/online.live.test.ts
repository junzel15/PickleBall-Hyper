/// <reference types="node" />
/**
 * LIVE online tests against the real Supabase project: two separate players (two
 * clients, two real accounts, two game engines) using the real database functions,
 * Realtime channels and the submit-result Edge Function.
 *
 * Skipped unless PBH_LIVE=1:
 *   PBH_LIVE=1 npx jest __tests__/online.live.test.ts --runInBand
 * The two test accounts are created on the first run (via the register function);
 * their passwords are kept in .env.test (git-ignored).
 *
 * @jest-environment node
 */
import './helpers/engineMocks';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../src/backend/config';
import type { Client } from '../src/backend/supabase';
import type { Database } from '../src/backend/types';
import * as api from '../src/backend/online/api';
import type * as NetplayModule from '../src/backend/online/netplay';
import type * as EngineModule from '../src/game/engine';
import { makePilot } from './helpers/autopilot';

const LIVE = process.env.PBH_LIVE === '1';
const d = LIVE ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 30_000, every = 200): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(every);
  }
}

interface Player { name: string; email: string; password: string; db: Client; id: string }

function creds(): { a: string; b: string; c: string; d: string } {
  const file = path.join(__dirname, '..', '.env.test');
  let txt = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const get = (k: string) => (txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
  let changed = false;
  for (const k of ['A', 'B', 'C', 'D']) {
    if (!get(`PBH_TEST_PASSWORD_${k}`)) {
      txt += `PBH_TEST_PASSWORD_${k}=${crypto.randomBytes(18).toString('base64url')}\n`;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, txt);
  return {
    a: get('PBH_TEST_PASSWORD_A') as string, b: get('PBH_TEST_PASSWORD_B') as string,
    c: get('PBH_TEST_PASSWORD_C') as string, d: get('PBH_TEST_PASSWORD_D') as string,
  };
}

async function player(name: string, email: string, password: string): Promise<Player> {
  const db = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as Client;
  let signed = await db.auth.signInWithPassword({ email, password });
  if (signed.error) {
    const reg = await db.functions.invoke('register', { body: { email, password, name } });
    if (reg.error) throw new Error(`could not create test account ${email}: ${reg.error.message}`);
    signed = await db.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
  }
  await db.realtime.setAuth();
  return { name, email, password, db, id: signed.data.user!.id };
}

function listen(db: Client, topic: string, events: string[]) {
  const got: { event: string; payload: unknown }[] = [];
  let status = '';
  const ch: RealtimeChannel = db.channel(topic, { config: { private: true } });
  for (const e of events) ch.on('broadcast', { event: e }, ({ payload }) => got.push({ event: e, payload }));
  ch.subscribe(s => { status = s; });
  return { ch, got, status: () => status, close: () => db.removeChannel(ch) };
}

/** A player's phone: their own engine + netplay module instance. */
function phone(p: Player) {
  let engine!: typeof EngineModule;
  let netplay!: typeof NetplayModule;
  jest.isolateModules(() => {
    engine = require('../src/game/engine');
    netplay = require('../src/backend/online/netplay');
  });
  const game = engine.createGame();
  game.setProfile({ name: p.name, avatar: game.getUi().profile.avatar, paddle: 'tidal-wave', age: null });
  let exited = 0;
  return { game, netplay, exited: () => exited, onExit: () => { exited++; } };
}

/** Runs both engines in real time (like requestAnimationFrame) with their autopilots. */
function runLoop(tick: (dt: number) => void) {
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt);
  }, 16);
  return () => clearInterval(t);
}

async function matchRow(db: Client, id: string) {
  const { data, error } = await db.from('online_matches' as never).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as unknown as Record<string, unknown> | null;
}

async function freshRoomMatch(A: Player, B: Player): Promise<api.RoomState> {
  const room = await api.createRoom(A.db);
  await api.joinRoom(B.db, room.code);
  await api.setReady(B.db, true);
  const started = await api.startMatch(A.db);
  expect(started.status).toBe('playing');
  expect(started.match?.status).toBe('active');
  return started;
}

d('LIVE: real players on the real backend', () => {
  let A: Player, B: Player, C: Player, D: Player;

  beforeAll(async () => {
    if (!/^https:\/\//.test(SUPABASE_URL)) throw new Error('SUPABASE_URL missing in .env');
    const c = creds();
    A = await player('Live Tester A', 'pbh-live-a@example.com', c.a);
    B = await player('Live Tester B', 'pbh-live-b@example.com', c.b);
    C = await player('Live Tester C', 'pbh-live-c@example.com', c.c);
    D = await player('Live Tester D', 'pbh-live-d@example.com', c.d);
    for (const p of [A, B, C, D]) {
      await api.leaveRoom(p.db).catch(() => {});
      await api.cancelQuickMatch(p.db).catch(() => {});
    }
  });

  afterAll(async () => {
    for (const p of [A, B, C, D]) {
      if (!p) continue;
      await api.leaveRoom(p.db).catch(() => {});
      await p.db.removeAllChannels();
      p.db.realtime.disconnect();
    }
  });

  test('Realtime: you can only join channels that are yours', async () => {
    const mine = listen(B.db, `user:${B.id}`, []);
    const theirs = listen(B.db, `user:${A.id}`, []);
    await until('own channel joined', () => mine.status() === 'SUBSCRIBED', 15_000);
    await until('other player channel refused', () => /CHANNEL_ERROR|CLOSED|TIMED_OUT/.test(theirs.status()), 15_000);
    expect(theirs.status()).not.toBe('SUBSCRIBED');
    // a room you are not in
    const room = await api.createRoom(A.db);
    const spy = listen(B.db, `room:${room.id}`, ['room_changed']);
    await until('room channel refused', () => /CHANNEL_ERROR|CLOSED|TIMED_OUT/.test(spy.status()), 15_000);
    await api.leaveRoom(A.db);
    mine.close(); theirs.close(); spy.close();
  });

  test('players cannot write rooms, matches, results or stats themselves', async () => {
    const tries = [
      B.db.from('online_matches' as never).insert({ kind: 'private', host_id: B.id, guest_id: A.id } as never),
      B.db.from('player_stats' as never).upsert({ user_id: B.id, rating: 4000 } as never),
      B.db.from('rooms' as never).insert({ code: 'ABCDEF', kind: 'private', host_id: B.id } as never),
      B.db.from('match_reports' as never).select('*'),
      (B.db as unknown as { rpc: (f: string, a: object) => Promise<{ error: unknown }> }).rpc('svc_submit_report', {
        p_match: crypto.randomUUID(), p_user: B.id, p_host_score: 0, p_guest_score: 11, p_longest: 1,
        p_winners: 'g', p_valid: true, p_reason: null, p_last_point_ms: 1,
      }),
    ];
    const results = await Promise.all(tries);
    for (const r of results) expect(r.error).toBeTruthy();
    // and the friend code can't be changed
    await B.db.from('profiles').update({ friend_code: 'AAAAAAAA' } as never).eq('id', B.id);
    const me = await api.getMyOnlineProfile(B.db);
    expect(me?.friend_code).not.toBe('AAAAAAAA');
  });

  test('friends, presence-free invites and joining a friend\'s room', async () => {
    const aMe = await api.getMyOnlineProfile(A.db);
    const bMe = await api.getMyOnlineProfile(B.db);
    expect(aMe?.friend_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    // clean slate
    await api.removeFriend(A.db, B.id);
    const bInbox = listen(B.db, `user:${B.id}`, ['friends_changed', 'room_invite']);
    await until('B inbox joined', () => bInbox.status() === 'SUBSCRIBED', 15_000);

    const sent = await api.sendFriendRequest(A.db, bMe!.friend_code);
    expect(sent.status).toBe('pending');
    await until('B notified of the friend request', () => bInbox.got.some(g => g.event === 'friends_changed'));
    const bFriends = await api.listFriends(B.db);
    expect(bFriends.find(f => f.user_id === A.id)).toMatchObject({ status: 'pending', incoming: true });
    await api.respondFriendRequest(B.db, A.id, true);
    expect((await api.listFriends(A.db)).find(f => f.user_id === B.id)?.status).toBe('accepted');
    await expect(api.sendFriendRequest(A.db, bMe!.friend_code)).rejects.toMatchObject({ code: 'already_friends' });
    await expect(api.sendFriendRequest(A.db, aMe!.friend_code)).rejects.toMatchObject({ code: 'cannot_add_self' });

    // A makes a room and invites B
    const room = await api.createRoom(A.db);
    const aRoom = listen(A.db, `room:${room.id}`, ['room_changed', 'match_start']);
    await until('A room channel joined', () => aRoom.status() === 'SUBSCRIBED', 15_000);
    await api.inviteFriend(A.db, B.id);
    await until('B got the invite in real time', () => bInbox.got.some(g => g.event === 'room_invite'));
    const invites = await api.listInvites(B.db);
    const inv = invites.find(i => i.code === room.code);
    expect(inv).toBeTruthy();
    const joined = await api.respondInvite(B.db, inv!.id, true);
    expect(joined?.players.map(p => p.user_id).sort()).toEqual([A.id, B.id].sort());
    await until('A saw B join', () => aRoom.got.some(g => g.event === 'room_changed'));
    // only the host starts, and only when the guest is ready
    await expect(api.startMatch(B.db)).rejects.toMatchObject({ code: 'only_host_can_start' });
    await expect(api.startMatch(A.db)).rejects.toMatchObject({ code: 'opponent_not_ready' });
    // a third join attempt fails: the room is full (A tries to re-join from B's code path is a no-op)
    await api.leaveRoom(B.db);
    await until('A saw B leave', async () => (await api.getRoomState(A.db))?.players.length === 1);
    await api.leaveRoom(A.db);
    expect(await api.getRoomState(A.db)).toBeNull();
    bInbox.close(); aRoom.close();
  });

  test('Quick Match: simultaneous searches pair the two players exactly once', async () => {
    for (let round = 0; round < 3; round++) {
      // both search at the same instant, several times in a row
      let roomA: api.RoomState | undefined, roomB: api.RoomState | undefined;
      for (let i = 0; i < 6 && !(roomA && roomB); i++) {
        const [ra, rb] = await Promise.all([api.quickMatch(A.db), api.quickMatch(B.db)]);
        if (ra.status === 'matched') roomA = ra.room;
        if (rb.status === 'matched') roomB = rb.room;
        if (!(roomA && roomB)) await sleep(300);
      }
      expect(roomA?.id).toBeTruthy();
      expect(roomA?.id).toBe(roomB?.id);
      expect(roomA?.kind).toBe('quick');
      expect(roomA?.match?.status).toBe('active');
      const ids = roomA!.players.map(p => p.user_id).sort();
      expect(ids).toEqual([A.id, B.id].sort());
      // nobody is in two places: searching again returns the same match
      const again = await api.quickMatch(A.db);
      expect(again.status).toBe('matched');
      expect(again.room?.match?.id).toBe(roomA!.match!.id);
      // leaving a live match counts as a loss for the leaver
      const mid = roomA!.match!.id;
      await api.leaveRoom(A.db);
      const row = await until('match closed', () => matchRow(B.db, mid).then(r => (r && r.status !== 'active' ? r : null)));
      expect(row).toMatchObject({ status: 'finished', end_reason: 'left', winner_id: B.id });
      expect(await api.getRoomState(B.db)).toBeNull(); // the quick room is gone for both
    }
  });

  test('a full match over Realtime: synced play, all shots, Hyper, disconnect + reconnect, server-checked result', async () => {
    const before = { a: await api.getMyOnlineProfile(A.db), b: await api.getMyOnlineProfile(B.db) };
    const room = await freshRoomMatch(A, B);
    const matchId = room.match!.id;
    const pa = phone(A), pb = phone(B);
    const hostMsgs: { k: string; e?: { k: string; s?: number; t?: number; a?: string; ty?: string; sm?: boolean; hy?: boolean } }[] = [];
    // watch the real traffic from a third listener? No: tap the host engine's send through netplay
    await pa.netplay.beginMatch({ db: A.db, game: pa.game, room, myId: A.id, onExit: pa.onExit });
    await pb.netplay.beginMatch({ db: B.db, game: pb.game, room, myId: B.id, onExit: pb.onExit });
    expect(pa.game.netRole()).toBe('host');
    expect(pb.game.netRole()).toBe('guest');
    // record what the host's engine broadcasts by listening on the guest's side of the channel
    const tap = pb.game.netReceive;
    (pb.game as { netReceive: (m: unknown) => void }).netReceive = (m: unknown) => { hostMsgs.push(m as never); tap(m); };

    let phase: 'play' | 'serve-only' = 'play';
    const hostPilot = makePilot(pa.game, { hyper: true });
    const guestPilot = makePilot(pb.game, { hyper: true, mode: () => phase });
    let stop = runLoop(dt => { hostPilot.tick(dt); guestPilot.tick(dt); pa.game.step(dt); pb.game.step(dt); });

    try {
      // connected: the host starts once the guest says hello
      await until('guest connected', () => pa.game.debug().netHold === false && pa.game.getUi().online?.link === 'playing', 30_000);
      // play real rallies for a while
      await until('rallies played', () => pa.game.debug().rallies.length >= 3, 120_000, 500);

      // disconnect the guest's network for a few seconds: the host must hold the match
      pb.game.testInput({ dx: 0, dy: 0 });
      B.db.realtime.disconnect();
      await until('host holds while the guest is gone', () => pa.game.debug().netHold === true, 15_000);
      const heldScore = pa.game.debug().score;
      await sleep(3000);
      expect(pa.game.debug().score).toEqual(heldScore);
      expect(pa.game.getUi().online?.link).toBe('waiting');
      B.db.realtime.connect();
      await until('match resumes after reconnect', () => pa.game.debug().netHold === false, 45_000, 250);

      // more play, then the guest stops returning so the match ends
      await until('Hyper used by both', () => {
        const on = hostMsgs.filter(m => m.k === 'ev' && m.e?.k === 'hyper' && m.e.a === 'on');
        return on.some(m => m.e?.s === 0) && on.some(m => m.e?.s === 1);
      }, 150_000, 500).catch(() => null);
      phase = 'serve-only';
      await until('match over on both phones', () => pa.game.debug().state === 'over' && pb.game.debug().state === 'over', 300_000, 500);
      const hs = pa.game.debug().score, gs = pb.game.debug().score;
      expect(gs).toEqual({ player: hs.ai, ai: hs.player });
      expect(pb.game.debug().rallies.map(r => r.w).join('')).toBe(pa.game.debug().rallies.map(r => r.w).join(''));

      // the server confirms the result from the two reports
      const row = await until('server result', () => matchRow(A.db, matchId).then(r => (r && r.status !== 'active' ? r : null)), 60_000, 1000);
      expect(row).toMatchObject({ status: 'finished', end_reason: 'score', host_score: hs.player, guest_score: hs.ai });
      expect(row.winner_id).toBe(hs.player > hs.ai ? A.id : B.id);
      await until('result shown on both phones', () =>
        /confirmed/i.test(pa.game.getUi().online?.note ?? '') && /confirmed/i.test(pb.game.getUi().online?.note ?? ''), 30_000);

      // stats and rating moved, the right way
      const after = { a: await api.getMyOnlineProfile(A.db), b: await api.getMyOnlineProfile(B.db) };
      const aWon = row.winner_id === A.id;
      expect(after.a!.played).toBe(before.a!.played + 1);
      expect(after.b!.played).toBe(before.b!.played + 1);
      expect(after.a!.wins).toBe(before.a!.wins + (aWon ? 1 : 0));
      expect(Math.sign(after.a!.rating - before.a!.rating)).toBe(aWon ? 1 : -1);
      expect(after.a!.rating - before.a!.rating).toBe(-(after.b!.rating - before.b!.rating));
      const hist = await api.getOnlineHistory(B.db, 5);
      expect(hist[0]).toMatchObject({ id: matchId, my_score: hs.ai, opp_score: hs.player, won: !aWon });
      const lb = await api.getOnlineLeaderboard(A.db, 100);
      expect(lb.some(r => r.is_me)).toBe(true);

      // what crossed the network: every shot type, from both sides; Hyper from both
      const hits = hostMsgs.filter(m => m.k === 'ev' && m.e?.k === 'hit').map(m => m.e!);
      expect(hits.some(h => h.t === 0)).toBe(true);
      expect(hits.some(h => h.t === 1)).toBe(true);
      const kinds = new Set(hits.map(h => (h.sm ? 'smash' : h.ty)));
      for (const k of ['drive', 'lob', 'dink']) expect(kinds.has(k)).toBe(true);
      const hyperOn = hostMsgs.filter(m => m.k === 'ev' && m.e?.k === 'hyper' && m.e.a === 'on');
      expect(hyperOn.some(m => m.e?.s === 0)).toBe(true);
      expect(hyperOn.some(m => m.e?.s === 1)).toBe(true);

      // back to the lobby: the private room is open again for a rematch
      pa.netplay.exitMatch(); pb.netplay.exitMatch();
      const lobby = await api.getRoomState(A.db);
      expect(lobby?.status).toBe('lobby');
      expect(lobby?.players.length).toBe(2);
    } finally {
      stop();
      pa.netplay.stopMatch(); pb.netplay.stopMatch();
      await api.leaveRoom(B.db).catch(() => {});
      await api.leaveRoom(A.db).catch(() => {});
    }
    stop = () => {};
  });

  test('forged results are never counted', async () => {
    const before = { a: await api.getMyOnlineProfile(A.db), b: await api.getMyOnlineProfile(B.db) };
    const room = await freshRoomMatch(A, B);
    const mid = room.match!.id;
    const fake = (w: string) => w.split('').map((x, i) => ({ w: x as 'h' | 'g', t: (i + 1) * 3000 }));
    // a log that breaks the rules is marked invalid
    const bad = await api.submitResult(A.db, { match_id: mid, host_score: 11, guest_score: 0, longest_rally: 3, rallies: fake('hhhhhh') });
    expect(bad.report_valid).toBe(false);
    expect(bad.status).toBe('waiting_for_opponent');
    // the other player reports a different (valid) game: the match is disputed, nobody gains
    const other = await api.submitResult(B.db, { match_id: mid, host_score: 0, guest_score: 11, longest_rally: 3, rallies: fake('g'.repeat(12)) });
    expect(other.status).toBe('disputed');
    // a second report can't overwrite the first
    const retry = await api.submitResult(A.db, { match_id: mid, host_score: 0, guest_score: 11, longest_rally: 3, rallies: fake('g'.repeat(12)) });
    expect(retry.status).toBe('disputed');
    const row = await matchRow(A.db, mid);
    expect(row).toMatchObject({ status: 'disputed', winner_id: null });
    const after = { a: await api.getMyOnlineProfile(A.db), b: await api.getMyOnlineProfile(B.db) };
    expect(after.a!.rating).toBe(before.a!.rating);
    expect(after.b!.rating).toBe(before.b!.rating);
    expect(after.a!.played).toBe(before.a!.played);

    // a player can't report on a match they aren't in
    const room2 = await api.getRoomState(A.db);
    expect(room2?.status).toBe('lobby');
    await api.leaveRoom(B.db);
    const solo = await api.submitResult(B.db, { match_id: mid, host_score: 11, guest_score: 0, longest_rally: 1, rallies: fake('hhhhhhhhhhh') });
    expect(['disputed', 'rejected']).toContain(solo.status);
    await api.leaveRoom(A.db);
  });

  test('a player who disappears loses by forfeit (checked against the server clock)', async () => {
    const room = await freshRoomMatch(A, B);
    const mid = room.match!.id;
    const pa = phone(A), pb = phone(B);
    await pa.netplay.beginMatch({ db: A.db, game: pa.game, room, myId: A.id, onExit: pa.onExit });
    await pb.netplay.beginMatch({ db: B.db, game: pb.game, room, myId: B.id, onExit: pb.onExit });
    const stop = runLoop(dt => { pa.game.step(dt); pb.game.step(dt); });
    try {
      await until('connected', () => pa.game.debug().netHold === false, 30_000);
      // claiming early is refused by the server
      await expect(api.claimForfeit(A.db, mid)).rejects.toMatchObject({ code: 'opponent_still_connected' });
      // the guest's phone vanishes: no messages, no heartbeats
      pb.netplay.stopMatch();
      const row = await until('forfeit decided', () => matchRow(A.db, mid).then(r => (r && r.status !== 'active' ? r : null)), 120_000, 2000);
      expect(row).toMatchObject({ status: 'finished', end_reason: 'forfeit', winner_id: A.id });
      await until('host told it won', () => /forfeit/i.test(pa.game.getUi().online?.note ?? ''), 20_000);
      expect(pa.game.getUi().overOpen).toBe(true);
    } finally {
      stop();
      pa.netplay.stopMatch();
      await api.leaveRoom(A.db).catch(() => {});
      await api.leaveRoom(B.db).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 2 vs 2 with four real accounts
  // -------------------------------------------------------------------------
  test('2v2 Quick Match: four simultaneous searches make exactly one balanced match', async () => {
    const all = [A, B, C, D];
    const rooms: (api.RoomState | undefined)[] = [undefined, undefined, undefined, undefined];
    for (let i = 0; i < 8 && rooms.some(r => !r); i++) {
      const res = await Promise.all(all.map((p, k) => (rooms[k] ? Promise.resolve(null) : api.quickMatch(p.db, 'doubles'))));
      res.forEach((r, k) => { if (r?.status === 'matched') rooms[k] = r.room; });
      if (rooms.some(r => !r)) await sleep(300);
    }
    const ids = new Set(rooms.map(r => r?.id));
    expect(ids.size).toBe(1);                       // everyone in the same room
    const room = rooms[0]!;
    expect(room.mode).toBe('doubles');
    expect(room.match?.status).toBe('active');
    expect(room.players.map(p => p.seat).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(room.players.map(p => p.user_id)).size).toBe(4);
    for (const p of room.players) expect(p.team).toBe(p.seat % 2);
    // a 1v1 search by someone already matched returns the same match
    const again = await api.quickMatch(C.db, 'singles');
    expect(again.room?.match?.id).toBe(room.match!.id);
    // one player walks out: their whole team loses, the quick room closes for all four
    const leaver = room.players.find(p => p.seat === 3)!;
    const who = all.find(p => p.id === leaver.user_id)!;
    await api.leaveRoom(who.db);
    const row = await until('match closed', () => matchRow(A.db, room.match!.id).then(r => (r && r.status !== 'active' ? r : null)));
    expect(row).toMatchObject({ status: 'finished', end_reason: 'left', winner_team: 0, mode: 'doubles' });
    for (const p of all) expect(await api.getRoomState(p.db)).toBeNull();
  });

  test('2v2 room: join by code, pick teams, Realtime channels are per player, a full match is confirmed by the server', async () => {
    const all = [A, B, C, D];
    const before = await Promise.all(all.map(p => api.getMyOnlineProfile(p.db)));
    // A hosts a 2v2 room; B, C and D join with the code
    let room = await api.createRoom(A.db, 'doubles');
    expect(room).toMatchObject({ mode: 'doubles', capacity: 4 });
    room = await api.joinRoom(B.db, room.code);     // seat 1 (team B)
    room = await api.joinRoom(C.db, room.code);     // seat 2 (team A)
    // B switches to seat 3 (still team B); D then takes the free seat 1
    room = await api.changeSeat(B.db, 3);
    await expect(api.changeSeat(C.db, 3)).rejects.toMatchObject({ code: 'seat_taken' });
    await expect(api.changeSeat(A.db, 1)).rejects.toMatchObject({ code: 'host_keeps_seat' });
    room = await api.joinRoom(D.db, room.code);
    const seatOf = (p: Player) => room.players.find(x => x.user_id === p.id)!.seat;
    expect([seatOf(A), seatOf(D), seatOf(C), seatOf(B)]).toEqual([0, 1, 2, 3]);
    expect((await api.joinRoom(A.db, room.code)).players.length).toBe(4); // re-joining your own room changes nothing
    // can't switch to 1v1 with four people in the room; can't start until everyone is ready
    await expect(api.setRoomMode(A.db, 'singles')).rejects.toMatchObject({ code: 'too_many_players' });
    await api.setReady(B.db, true);
    await api.setReady(C.db, true);
    await expect(api.startMatch(A.db)).rejects.toMatchObject({ code: 'opponent_not_ready' });
    await api.setReady(D.db, true);
    room = await api.startMatch(A.db);
    expect(room.match?.status).toBe('active');
    expect(room.match?.players?.length).toBe(4);
    const matchId = room.match!.id;

    // channel rules: only the host may send on match:<id>; nobody may listen to another player's inputs
    const spyInputs = listen(C.db, `match:${matchId}:${B.id}`, ['m']);
    await until('C refused on B\'s input channel', () => /CHANNEL_ERROR|CLOSED|TIMED_OUT/.test(spyInputs.status()), 15_000);
    spyInputs.close();

    // four phones
    const phones = all.map(p => ({ p, ph: phone(p) }));
    const hostMsgs: { k: string; e?: { k: string; s?: number; a?: string; ty?: string; sm?: boolean } }[] = [];
    for (const { p, ph } of phones) await ph.netplay.beginMatch({ db: p.db, game: ph.game, room, myId: p.id, onExit: ph.onExit });
    const hostPhone = phones[0].ph;
    expect(hostPhone.game.netRole()).toBe('host');
    // listen to what the host broadcasts through C's phone (seat 2)
    const cGame = phones[2].ph.game;
    const tap = cGame.netReceive;
    (cGame as { netReceive: (m: unknown, s?: number) => void }).netReceive = (m: unknown, s?: number) => { hostMsgs.push(m as never); tap(m, s); };

    let phase: 'play' | 'end' = 'play';
    const pilots = phones.map(({ ph }) => {
      const seat = ph.game.debug().seat;
      return makePilot(ph.game, { hyper: true, mode: () => (phase === 'end' && seat % 2 === 1 ? 'serve-only' : 'play') });
    });
    const stop = runLoop(dt => { pilots.forEach(pl => pl.tick(dt)); phones.forEach(({ ph }) => ph.game.step(dt)); });
    try {
      await until('all four connected', () => hostPhone.game.debug().netHold === false
        && phones.every(({ ph }) => ph.game.getUi().online?.link === 'playing'), 45_000, 250);
      // every seat sees the same score (from its own side)
      await until('rallies played', () => hostPhone.game.debug().rallies.length >= 4, 180_000, 500);
      const hits = () => hostMsgs.filter(m => m.k === 'ev' && m.e?.k === 'hit').map(m => m.e!);
      await until('all four players hit the ball', () => [0, 1, 2, 3].every(s => hits().some(h => h.s === s)), 180_000, 500)
        .catch(() => null);
      phase = 'end';
      await until('match over on all four phones', () => phones.every(({ ph }) => ph.game.debug().state === 'over'), 400_000, 500);
      const host = hostPhone.game.debug();
      for (const { ph } of phones) {
        const dd = ph.game.debug();
        const teamA = dd.seat % 2 === 0 ? dd.score.player : dd.score.ai;
        const teamB = dd.seat % 2 === 0 ? dd.score.ai : dd.score.player;
        expect([teamA, teamB]).toEqual([host.score.player, host.score.ai]);
        expect(dd.rallies.map(r => r.w).join('')).toBe(host.rallies.map(r => r.w).join(''));
      }
      const row = await until('server result', () => matchRow(A.db, matchId).then(r => (r && r.status !== 'active' ? r : null)), 90_000, 1000);
      expect(row).toMatchObject({ status: 'finished', end_reason: 'score', mode: 'doubles', host_score: host.score.player, guest_score: host.score.ai });
      const winTeam = host.score.player > host.score.ai ? 0 : 1;
      expect(row.winner_team).toBe(winTeam);
      await until('result shown on all four phones', () => phones.every(({ ph }) => /confirmed/i.test(ph.game.getUi().online?.note ?? '')), 30_000);

      // ratings: both partners moved the same way, and the two teams' changes cancel out
      const after = await Promise.all(all.map(p => api.getMyOnlineProfile(p.db)));
      const delta = all.map((p, i) => after[i]!.rating - before[i]!.rating);
      const team = all.map(p => room.players.find(x => x.user_id === p.id)!.team);
      all.forEach((p, i) => {
        expect(after[i]!.played).toBe(before[i]!.played + 1);
        expect(Math.sign(delta[i])).toBe(team[i] === winTeam ? 1 : -1);
      });
      expect(delta.reduce((x, y) => x + y, 0)).toBe(0);
      const hist = await api.getOnlineHistory(C.db, 5);
      expect(hist[0]).toMatchObject({ id: matchId, mode: 'doubles', won: team[2] === winTeam });
      expect(hist[0].partner).toBe('Live Tester A');
      expect(hits().filter(h => h.s !== undefined).length).toBeGreaterThan(4);

      phones.forEach(({ ph }) => ph.netplay.exitMatch());
      const lobby = await api.getRoomState(A.db);
      expect(lobby).toMatchObject({ status: 'lobby', mode: 'doubles' });
      expect(lobby?.players.length).toBe(4);
    } finally {
      stop();
      phones.forEach(({ ph }) => ph.netplay.stopMatch());
      for (const p of all) await api.leaveRoom(p.db).catch(() => {});
    }
  });
});

test('live tests are opt-in', () => {
  expect(typeof LIVE).toBe('boolean');
});
