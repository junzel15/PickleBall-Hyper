// Online lobby state for the signed-in player, shared with the React screens:
//   * your online card (name, friend code, rating, record)
//   * the room you are in (lobby or match), Quick Match search, invites, friends
//   * who is online (Realtime Presence on the `lobby` topic)
// Realtime channels (all private, each opened at most once):
//   user:<you>   server notices: invites, friend requests, "match found"
//   lobby        presence only
//   room:<id>    while you are in a room: lobby changes, match start / end
// The database is the source of truth: a notice only says "something changed" and
// the screen reloads that one thing, so nothing is polled except the Quick Match search.
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Game } from '../../game/engine';
import { account } from '../cloud';
import { supabase, Client } from '../supabase';
import * as api from './api';
import * as netplay from './netplay';

export interface OnlineState {
  userId: string | null;
  me: api.MyOnlineProfile | null;
  room: api.RoomState | null;
  /** An active match from before (app restart): offer to rejoin it. */
  rejoin: api.RoomState | null;
  quick: 'idle' | 'searching';
  /** What Quick Match is looking for. */
  quickMode: api.OnlineMode;
  quickWaiting: number;
  invites: api.Invite[];
  friends: api.Friend[] | null;
  onlineIds: string[];
  /** Latest incoming invite, shown as a small card until handled. */
  toast: { code: string; fromName: string } | null;
  busy: boolean;
  error: string | null;
  /** A match is on screen. */
  inMatch: boolean;
  /** Quick Match just found the players: shown as "Opponent Found!" before play starts. */
  found: api.RoomState | null;
}

const initial = (): OnlineState => ({
  userId: null, me: null, room: null, rejoin: null, quick: 'idle', quickMode: 'singles', quickWaiting: 0, invites: [],
  friends: null, onlineIds: [], toast: null, busy: false, error: null, inMatch: false, found: null,
});

let state: OnlineState = initial();
const listeners = new Set<() => void>();
function set(patch: Partial<OnlineState>) {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
}

export const onlineStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: () => state,
};

let game: Game | null = null;
let userCh: RealtimeChannel | null = null;
let lobbyCh: RealtimeChannel | null = null;
let roomCh: RealtimeChannel | null = null;
let roomChId: string | null = null;
let quickTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0; // bumps on sign-in / sign-out so late replies are ignored
const exitedMatches = new Set<string>();
const announced = new Set<string>(); // Quick Matches already shown as "Opponent Found!"

const db = (): Client => {
  if (!supabase) throw new api.OnlineError('Online play is not set up in this build.');
  return supabase;
};
const errText = (e: unknown) => (e instanceof api.OnlineError ? e.message : 'Something went wrong. Please try again.');

function openChannel(topic: string, setup: (ch: RealtimeChannel) => void, opts: { presenceKey?: string } = {}): RealtimeChannel {
  const client = db();
  netplay.dropChannels(client, topic);
  const ch = client.channel(topic, {
    config: { private: true, broadcast: { self: false }, ...(opts.presenceKey ? { presence: { key: opts.presenceKey } } : {}) },
  });
  setup(ch);
  return ch;
}

async function subscribeChannel(ch: RealtimeChannel, onJoined?: () => void) {
  try { await db().realtime.setAuth(); } catch { /* uses the current session */ }
  ch.subscribe(status => { if (status === 'SUBSCRIBED') onJoined?.(); });
}

function closeChannel(ch: RealtimeChannel | null) {
  if (ch && supabase) supabase.removeChannel(ch);
}

// ---------------------------------------------------------------------------
// Sign-in / sign-out
// ---------------------------------------------------------------------------
/** Starts following the signed-in player. Returns a function that stops it. */
export function startOnlineSession(g: Game): () => void {
  game = g;
  if (!supabase) return () => {};
  const follow = () => {
    const uid = account.get().userId;
    if (uid !== state.userId) switchUser(uid);
  };
  const unAcc = account.subscribe(follow);
  follow();
  return () => {
    unAcc();
    switchUser(null);
    game = null;
  };
}

function switchUser(uid: string | null) {
  generation++;
  stopQuickTimer();
  netplay.stopMatch();
  closeChannel(userCh); userCh = null;
  closeChannel(lobbyCh); lobbyCh = null;
  closeChannel(roomCh); roomCh = null; roomChId = null;
  state = { ...initial(), userId: uid };
  listeners.forEach(fn => fn());
  if (!uid) return;

  userCh = openChannel(`user:${uid}`, ch => {
    ch.on('broadcast', { event: 'room_invite' }, ({ payload }) => {
      const p = (payload ?? {}) as { code?: string; from_name?: string };
      if (p.code) set({ toast: { code: String(p.code), fromName: String(p.from_name ?? 'A friend') } });
      refreshInvites();
    });
    ch.on('broadcast', { event: 'friends_changed' }, () => { if (state.friends) refreshFriends(); });
    ch.on('broadcast', { event: 'match_found' }, () => { if (state.quick === 'searching') pollQuick(); else refreshRoom(); });
  });
  subscribeChannel(userCh);

  lobbyCh = openChannel('lobby', ch => {
    ch.on('presence', { event: 'sync' }, () => {
      const ids = Object.keys(ch.presenceState()).filter(id => id !== uid);
      set({ onlineIds: ids });
    });
  }, { presenceKey: uid });
  const lobby = lobbyCh;
  subscribeChannel(lobby, () => { lobby.track({ at: Date.now() }).catch(() => {}); });

  refreshAll(true);
}

/** Reloads your card, room and invites (on opening the Online screen). */
export async function refreshAll(atStart = false) {
  const gen = generation;
  try {
    const client = db();
    const [me, room, invites] = await Promise.all([
      api.getMyOnlineProfile(client), api.getRoomState(client), api.listInvites(client),
    ]);
    if (gen !== generation) return;
    set({ me, invites, error: null });
    applyRoom(room, atStart);
  } catch (e) {
    if (gen === generation) set({ error: errText(e) });
  }
}

export async function refreshMe() {
  const gen = generation;
  try {
    const me = await api.getMyOnlineProfile(db());
    if (gen === generation) set({ me });
  } catch { /* keep the old card */ }
}

async function refreshInvites() {
  const gen = generation;
  try {
    const invites = await api.listInvites(db());
    if (gen === generation) set({ invites });
  } catch { /* keep the old list */ }
}

export async function refreshFriends() {
  const gen = generation;
  try {
    const friends = await api.listFriends(db());
    if (gen === generation) set({ friends });
  } catch (e) {
    if (gen === generation) set({ error: errText(e) });
  }
}

export async function refreshRoom() {
  const gen = generation;
  try {
    const room = await api.getRoomState(db());
    if (gen === generation) applyRoom(room, false);
  } catch { /* the next notice / action reloads it */ }
}

// ---------------------------------------------------------------------------
// Room state -> channels and match start
// ---------------------------------------------------------------------------
function applyRoom(room: api.RoomState | null, atStart: boolean) {
  // follow the room's channel (exactly one at a time)
  if ((room?.id ?? null) !== roomChId) {
    closeChannel(roomCh); roomCh = null; roomChId = null;
    if (room) {
      roomChId = room.id;
      roomCh = openChannel(`room:${room.id}`, ch => {
        const reload = () => refreshRoom();
        ch.on('broadcast', { event: 'room_changed' }, reload);
        ch.on('broadcast', { event: 'match_start' }, reload);
        ch.on('broadcast', { event: 'room_closed' }, reload);
      });
      subscribeChannel(roomCh);
    }
  }
  const active = room?.status === 'playing' && room.match?.status === 'active' && !exitedMatches.has(room.match.id);
  if (active && netplay.activeMatchId() === room!.match!.id) {
    set({ room, rejoin: null });
    return;
  }
  if (active && atStart) {
    set({ room, rejoin: room }); // after an app restart: ask before jumping into a match
    return;
  }
  if (active && room!.kind === 'quick' && !announced.has(room!.match!.id)) {
    // Quick Match: show who was found first ("Opponent Found!"), then play
    announced.add(room!.match!.id);
    stopQuickTimer();
    set({ room, rejoin: null, quick: 'idle', found: room });
    return;
  }
  if (active && state.found?.match?.id === room!.match!.id) { set({ room }); return; } // still on the found screen
  set({ room, rejoin: null });
  if (active) beginMatch(room!);
}

/** Start the match shown on the "Opponent Found!" screen. */
export function acceptFound() {
  const room = state.found;
  if (!room) return;
  set({ found: null });
  beginMatch(room);
}

function beginMatch(room: api.RoomState) {
  const uid = state.userId;
  if (!game || !uid || !supabase) return;
  stopQuickTimer();
  const matchId = room.match?.id ?? '';
  set({ quick: 'idle', inMatch: true, rejoin: null, toast: null });
  netplay.beginMatch({
    db: supabase, game, room, myId: uid,
    onExit: () => {
      // never pulled back into a match you walked away from (its result may still be settling)
      exitedMatches.add(matchId);
      set({ inMatch: false });
      refreshRoom();
      refreshMe();
    },
  });
}

/** Rejoin a match that was running when the app closed. */
export function rejoinMatch() {
  if (state.rejoin) beginMatch(state.rejoin);
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------
async function run<T>(fn: (client: Client) => Promise<T>): Promise<T | undefined> {
  const gen = generation;
  set({ busy: true, error: null });
  try {
    const out = await fn(db());
    return out;
  } catch (e) {
    if (gen === generation) set({ error: errText(e) });
    return undefined;
  } finally {
    if (gen === generation) set({ busy: false });
  }
}

export const clearError = () => set({ error: null });
export const dismissToast = () => set({ toast: null });

export async function createRoom(mode: api.OnlineMode = 'singles') {
  const room = await run(c => api.createRoom(c, mode));
  if (room) applyRoom(room, false);
}

/** Host: switch the room between 1 vs 1 and 2 vs 2. */
export async function setRoomMode(mode: api.OnlineMode) {
  const room = await run(c => api.setRoomMode(c, mode));
  if (room) applyRoom(room, false);
}

/** Take a free spot (doubles: pick your team). */
export async function changeSeat(seat: number) {
  const room = await run(c => api.changeSeat(c, seat));
  if (room) applyRoom(room, false);
}

export async function joinRoom(code: string) {
  const room = await run(c => api.joinRoom(c, code));
  if (room) applyRoom(room, false);
}

export async function leaveRoom() {
  await run(c => api.leaveRoom(c));
  applyRoom(null, false);
}

export async function setReady(ready: boolean) {
  const room = await run(c => api.setReady(c, ready));
  if (room) applyRoom(room, false);
}

export async function startMatch() {
  const room = await run(c => api.startMatch(c));
  if (room) applyRoom(room, false);
}

export async function inviteFriend(userId: string) {
  await run(c => api.inviteFriend(c, userId));
}

export async function respondInvite(id: number, accept: boolean) {
  set({ toast: null, invites: state.invites.filter(i => i.id !== id) });
  const room = await run(c => api.respondInvite(c, id, accept));
  if (room) applyRoom(room, false);
}

/** Accept the invite shown in the toast (looked up by room code). */
export async function acceptToast() {
  const t = state.toast;
  set({ toast: null });
  if (!t) return;
  const inv = state.invites.find(i => i.code === t.code);
  if (inv) await respondInvite(inv.id, true);
  else await joinRoom(t.code);
}

export async function sendFriendRequest(code: string): Promise<string | null> {
  const out = await run(c => api.sendFriendRequest(c, code));
  if (!out) return null;
  refreshFriends();
  return out.status === 'accepted' ? `You and ${out.name} are now friends.` : `Friend request sent to ${out.name}.`;
}

export async function respondFriendRequest(userId: string, accept: boolean) {
  await run(c => api.respondFriendRequest(c, userId, accept));
  refreshFriends();
}

export async function removeFriend(userId: string) {
  await run(c => api.removeFriend(c, userId));
  refreshFriends();
}

// ---------------------------------------------------------------------------
// Quick Match
// ---------------------------------------------------------------------------
const QUICK_POLL_MS = 3000;

function stopQuickTimer() {
  if (quickTimer) clearTimeout(quickTimer);
  quickTimer = null;
}

export function startQuickMatch(mode: api.OnlineMode = 'singles') {
  if (state.quick === 'searching') return;
  set({ quick: 'searching', quickMode: mode, quickWaiting: 0, error: null });
  pollQuick();
}

async function pollQuick() {
  stopQuickTimer();
  const gen = generation;
  if (state.quick !== 'searching') return;
  try {
    const res = await api.quickMatch(db(), state.quickMode);
    if (gen !== generation || state.quick !== 'searching') return;
    if (res.status === 'matched' && res.room) {
      set({ quick: 'idle' });
      applyRoom(res.room, false);
      return;
    }
    set({ quickWaiting: res.waiting ?? 0 });
  } catch (e) {
    if (gen !== generation) return;
    set({ error: errText(e) });
  }
  if (state.quick === 'searching') quickTimer = setTimeout(pollQuick, QUICK_POLL_MS);
}

export async function cancelQuickMatch() {
  stopQuickTimer();
  set({ quick: 'idle' });
  const room = await run(c => api.cancelQuickMatch(c));
  if (room) applyRoom(room, false); // matched just before cancelling: play it
}

// ---------------------------------------------------------------------------
// In a match
// ---------------------------------------------------------------------------
export const leaveMatch = () => netplay.leaveMatch();
export const exitMatch = () => netplay.exitMatch();
