// Connects one online match (1 vs 1 or 2 vs 2) to the game engine:
//   * private Realtime channels, each opened once:
//       match:<id>          the host sends snapshots and events, everyone listens
//       match:<id>:<uid>    one per guest: that guest's inputs, only the host listens
//     (the database only lets each player send on their own channel, so nobody can
//     send messages that look like another player's)
//   * disconnects: the match waits while anyone is silent; after FORFEIT_AFTER_MS a
//     player can claim the win (the SERVER checks that the silent player's
//     heartbeat really stopped)
//   * a heartbeat to the database every HEARTBEAT_MS (also how the server's verdict
//     arrives if a Realtime notice was missed)
//   * the host saves the score after every rally, so a restarted app can resume
//   * at the end every player sends their own record to the submit-result Edge
//     Function; the server decides the result
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Game, OnlineMatchEnd, OnlineResume } from '../../game/engine';
import { sanitizeProfile } from '../../game/customize';
import { SILENCE_MS, teamOfSeat } from '../../game/net';
import type { Client } from '../supabase';
import * as api from './api';

export const HEARTBEAT_MS = 10_000;
/** Someone has been silent this long: claim the win (the server needs 30 s of no heartbeat). */
export const FORFEIT_AFTER_MS = 40_000;
const RESUME_KEY = 'pickleball.onlineResume.v1';

interface Peer { seat: number; userId: string; name: string; team: 0 | 1 }

interface Current {
  matchId: string;
  roomId: string;
  role: 'host' | 'guest';
  myId: string;
  mySeat: number;
  myTeam: 0 | 1;
  peers: Peer[];          // everyone else in the match
  opponentNames: string;
  main: RealtimeChannel;  // match:<id>
  inputs: RealtimeChannel[]; // host: one per guest / guest: its own
  startedAt: number;
  lastHello: number;
  lastClaim: number;
  lastJoinedOk: number;
  gameOver: boolean;      // the engine reached the end of the match
  final: boolean;         // the server has the final result
  timers: ReturnType<typeof setInterval>[];
  unsub: (() => void)[];
  db: Client;
  game: Game;
  onExit: () => void;
}

let cur: Current | null = null;

export const activeMatchId = () => cur?.matchId ?? null;

const mainTopic = (matchId: string) => `match:${matchId}`;
const inputTopic = (matchId: string, userId: string) => `match:${matchId}:${userId}`;

/** Removes any channel already open for this topic (no duplicate subscriptions). */
export function dropChannels(db: Client, topic: string) {
  for (const ch of db.getChannels()) {
    if (ch.topic === `realtime:${topic}` || ch.topic === topic) db.removeChannel(ch);
  }
}

async function loadResume(matchId: string): Promise<OnlineResume | null> {
  try {
    const raw = await AsyncStorage.getItem(RESUME_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    return saved && saved.matchId === matchId ? (saved.resume as OnlineResume) : null;
  } catch {
    return null;
  }
}
async function saveResume(matchId: string, resume: OnlineResume | null) {
  try {
    if (resume) await AsyncStorage.setItem(RESUME_KEY, JSON.stringify({ matchId, resume }));
    else await AsyncStorage.removeItem(RESUME_KEY);
  } catch {
    /* storage unavailable: the match just can't be resumed after a restart */
  }
}

/** Starts (or rejoins) the active match of a room. Safe to call again for the same match. */
export async function beginMatch(opts: {
  db: Client; game: Game; room: api.RoomState; myId: string; onExit: () => void;
}): Promise<void> {
  const { db, game, room, myId } = opts;
  const m = room.match;
  if (!m || m.status !== 'active') return;
  if (cur && cur.matchId === m.id) return; // already on it
  if (cur) stopMatch();

  const roster: api.MatchPlayer[] = m.players?.length
    ? m.players
    : room.players.map(p => ({ seat: p.seat, user_id: p.user_id, team: teamOfSeat(p.seat), name: p.name, avatar: p.avatar, paddle: p.paddle }));
  const me = roster.find(p => p.user_id === myId);
  if (!me) return;
  const mode = (m.mode ?? room.mode) === 'doubles' ? 'doubles' : 'singles';
  const role: 'host' | 'guest' = me.seat === 0 ? 'host' : 'guest';
  const others = roster.filter(p => p.user_id !== myId);
  const resume = role === 'host' ? await loadResume(m.id) : null;
  if (cur) return; // another begin won the race while loading

  const peers: Peer[] = others.map(p => ({
    seat: p.seat, userId: p.user_id ?? '', name: sanitizeProfile({ name: p.name }).name, team: teamOfSeat(p.seat),
  }));
  const myTeam = teamOfSeat(me.seat);
  const c: Current = {
    matchId: m.id, roomId: room.id, role, myId, mySeat: me.seat, myTeam, peers,
    opponentNames: peers.filter(p => p.team !== myTeam).map(p => p.name).join(' & ') || 'your opponent',
    main: null as unknown as RealtimeChannel, inputs: [],
    startedAt: Date.now(), lastHello: 0, lastClaim: 0, lastJoinedOk: Date.now(),
    gameOver: false, final: false, timers: [], unsub: [], db, game, onExit: opts.onExit,
  };
  cur = c;
  openChannels(c);

  const send = (msg: unknown) => { if (cur === c) sendRaw(c, msg); };
  game.startOnline({
    role, mode, seat: me.seat, send,
    others: others.map(p => ({ seat: p.seat, look: sanitizeProfile({ name: p.name, avatar: p.avatar, paddle: p.paddle }) })),
    resume,
  });

  c.unsub.push(game.onRally(() => {
    if (c.role === 'host') saveResume(c.matchId, game.exportResume());
  }));
  c.unsub.push(game.onOnlineEnd(end => { c.gameOver = true; submit(c, end); }));
  c.unsub.push(game.onLeaveRequest(() => { if (cur === c) exitMatch(); }));

  c.timers.push(setInterval(() => monitor(c), 250));
  c.timers.push(setInterval(() => heartbeat(c), HEARTBEAT_MS));
  heartbeat(c);
}

function channelOpts() {
  return { config: { private: true, broadcast: { self: false, ack: false } } };
}

/** (Re)opens the match channels. */
function openChannels(c: Current) {
  const { db, game } = c;
  dropChannels(db, mainTopic(c.matchId));
  const main = db.channel(mainTopic(c.matchId), channelOpts());
  if (c.role === 'guest') main.on('broadcast', { event: 'm' }, ({ payload }) => { if (cur === c) game.netReceive(payload); });
  main.on('broadcast', { event: 'match_final' }, ({ payload }) => { if (cur === c) onFinal(c, payload as api.SubmitOutcome); });
  c.main = main;

  c.inputs = [];
  if (c.role === 'host') {
    for (const p of c.peers) {
      if (!p.userId) continue;
      const topic = inputTopic(c.matchId, p.userId);
      dropChannels(db, topic);
      const ch = db.channel(topic, channelOpts());
      ch.on('broadcast', { event: 'm' }, ({ payload }) => { if (cur === c) game.netReceive(payload, p.seat); });
      c.inputs.push(ch);
    }
  } else {
    const topic = inputTopic(c.matchId, c.myId);
    dropChannels(db, topic);
    c.inputs.push(db.channel(topic, channelOpts()));
  }

  db.realtime.setAuth().catch(() => {}).finally(() => {
    if (cur !== c) return;
    main.subscribe(status => {
      if (cur === c && status === 'SUBSCRIBED' && c.role === 'guest') sayHello(c);
    });
    for (const ch of c.inputs) {
      ch.subscribe(status => {
        if (cur === c && status === 'SUBSCRIBED' && c.role === 'guest') sayHello(c);
      });
    }
  });
}

const joined = (ch: RealtimeChannel | null) => !!ch && ch.state === 'joined';

/** True only while the socket is up and every channel we use is joined. */
function linkUp(c: Current) {
  return c.db.realtime.isConnected() && joined(c.main) && c.inputs.every(joined);
}

function sayHello(c: Current) {
  c.lastHello = Date.now();
  sendRaw(c, { k: 'hello' });
}

// Only over the open socket: while offline, messages are dropped (snapshots and
// position reports are resent constantly anyway) instead of falling back to one
// HTTP request per message.
function sendRaw(c: Current, msg: unknown) {
  const ch = c.role === 'host' ? c.main : c.inputs[0];
  if (joined(ch) && c.db.realtime.isConnected()) ch.send({ type: 'broadcast', event: 'm', payload: msg }).catch(() => {});
}

/** Rebuilds the channels after a long outage (the client also retries on its own). */
function reopen(c: Current) {
  c.lastJoinedOk = Date.now();
  c.db.removeChannel(c.main);
  for (const ch of c.inputs) c.db.removeChannel(ch);
  if (!c.db.realtime.isConnected()) c.db.realtime.connect();
  openChannels(c);
}

function monitor(c: Current) {
  if (cur !== c || c.final) return;
  const now = Date.now();
  if (linkUp(c)) c.lastJoinedOk = now;
  else if (now - c.lastJoinedOk > 8000) reopen(c);
  if (c.gameOver) return;

  // who are we waiting for?
  let missing: { name: string; last: number }[];
  if (c.role === 'host') {
    const bySeat = c.game.netLastBySeat();
    missing = c.peers
      .map(p => ({ name: p.name, last: bySeat.find(s => s.seat === p.seat)?.last ?? 0 }))
      .filter(p => p.last === 0 || now - p.last > SILENCE_MS);
    c.game.setNetHold(missing.length > 0, missing.map(p => p.name).join(' & '));
  } else {
    const last = c.game.netLastRecv();
    missing = last === 0 || now - last > SILENCE_MS ? [{ name: 'the host', last }] : [];
  }

  if (missing.length) {
    const oldest = Math.min(...missing.map(p => p.last));
    const silentFor = now - Math.max(oldest, c.startedAt);
    const names = missing.map(p => p.name).join(' & ');
    const note = oldest === 0
      ? `Waiting for ${names} to connect…`
      : `${names} lost connection… ${Math.floor(silentFor / 1000)}s`;
    c.game.setOnlineLink('waiting', note);
    if (c.role === 'guest' && now - c.lastHello > 1000) sayHello(c);
    if (silentFor > FORFEIT_AFTER_MS && now - c.lastClaim > 10_000) {
      c.lastClaim = now;
      api.claimForfeit(c.db, c.matchId).then(out => onFinal(c, out)).catch(() => { /* still connected or offline: try later */ });
    }
  } else {
    const waitingFor = c.role === 'guest' ? c.game.netWaitingFor() : '';
    if (waitingFor) c.game.setOnlineLink('waiting', `Waiting for ${waitingFor}…`);
    else c.game.setOnlineLink('playing');
  }
}

async function heartbeat(c: Current) {
  if (cur !== c || c.final) return;
  try {
    const hb = await api.matchHeartbeat(c.db, c.matchId);
    if (cur === c && hb.status !== 'active') {
      onFinal(c, {
        status: hb.status as api.SubmitOutcome['status'], winner_team: hb.winner_team, winner_id: hb.winner_id,
        reason: hb.reason, deltas: hb.deltas,
      });
    }
  } catch {
    /* offline: the next beat tries again */
  }
}

async function submit(c: Current, end: OnlineMatchEnd) {
  const report: api.ResultReport = {
    match_id: c.matchId,
    host_score: end.hostScore,
    guest_score: end.guestScore,
    longest_rally: Math.min(999, end.longestRally),
    rallies: end.rallies,
  };
  let out: api.SubmitOutcome | null = null;
  // keeps trying even if the player leaves the result screen: the report still counts
  for (let attempt = 0; attempt < 4 && !c.final; attempt++) {
    try {
      out = await api.submitResult(c.db, report);
      break;
    } catch {
      await new Promise<void>(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  if (cur !== c || c.final) return;
  if (!out) { c.game.setOnlineLink('ended', "Couldn't reach the server. The result will be checked later."); return; }
  if (out.status === 'waiting_for_opponent') {
    c.game.setOnlineLink('ended', 'Waiting for the other players’ results…');
    // poll until the server has every report (or decides without the missing ones)
    const started = Date.now();
    const poll = setInterval(async () => {
      if (cur !== c || c.final) { clearInterval(poll); return; }
      await heartbeat(c);
      if (!c.final && Date.now() - started > 65_000) {
        try { onFinal(c, await api.resolveMissingReport(c.db, c.matchId)); } catch { /* try again next round */ }
      }
    }, 3000);
    c.timers.push(poll);
    return;
  }
  onFinal(c, out);
}

/** The server's final word on the match (from submit, the heartbeat or a Realtime notice). */
function onFinal(c: Current, out: api.SubmitOutcome) {
  if (cur !== c || !out || out.status === 'active' || out.status === 'waiting_for_opponent' || out.status === 'rejected') return;
  if (c.final) return;
  c.final = true;
  if (c.role === 'host') saveResume(c.matchId, null);
  c.game.setNetHold(false);

  const winTeam = typeof out.winner_team === 'number' ? out.winner_team : null;
  const iWon = winTeam === null ? null : winTeam === c.myTeam;
  const delta = out.deltas?.[c.myId];
  const rating = typeof delta === 'number' ? ` · Rating ${delta >= 0 ? '+' : ''}${delta}` : '';
  const opp = c.opponentNames;
  let note: string;
  if (out.status === 'finished') {
    if (out.reason === 'score') note = `Result confirmed by the server${rating}`;
    else if (out.reason === 'left') note = iWon ? `${opp} left the match. You win${rating}` : `Your side left the match${rating}`;
    else note = iWon ? `${opp} disconnected. You win by forfeit${rating}` : `Your side was disconnected too long and lost by forfeit${rating}`;
  } else if (out.status === 'disputed') {
    note = "The players' results didn't match, so this match doesn't count.";
  } else {
    note = 'This match was abandoned and does not count.';
  }

  if (c.gameOver) {
    c.game.setOnlineLink('ended', note);
  } else {
    // the match ended on the server before it ended on court (forfeit / left / abandoned)
    const title = iWon === null ? 'Match ended' : iWon ? 'You win! 🏆' : `${opp} win${opp.includes('&') ? '' : 's'}`;
    c.game.showOnlineResult({ title, score: iWon === null ? '–' : iWon ? 'W' : 'L', stats: `Online · vs ${opp}`, note, won: iWon });
    c.gameOver = true;
  }
  // nothing more to send or receive: close the channels, keep the result on screen
  c.timers.forEach(t => clearInterval(t));
  c.timers = [];
  closeChannels(c);
}

function closeChannels(c: Current) {
  c.db.removeChannel(c.main);
  for (const ch of c.inputs) c.db.removeChannel(ch);
  c.inputs = [];
}

/** Back to the menus once the match is over (or after leaving). */
export function exitMatch() {
  const c = cur;
  if (!c) return;
  stopMatch();
  c.game.endOnline();
  c.onExit();
}

/** Leave in the middle of a match: counts as a loss for your side (the server records it). */
export async function leaveMatch(): Promise<void> {
  const c = cur;
  if (!c) return;
  if (!c.final) {
    try { await api.leaveRoom(c.db); } catch { /* offline: the others can claim the win after the timeout */ }
    if (c.role === 'host') saveResume(c.matchId, null);
  }
  exitMatch();
}

/** Stops everything for the current match without touching the game screen. */
export function stopMatch() {
  const c = cur;
  if (!c) return;
  cur = null;
  c.timers.forEach(t => clearInterval(t));
  c.unsub.forEach(u => u());
  closeChannels(c);
}
