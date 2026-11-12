// Calls to the online-play functions in the database (supabase/migrations/*_online_multiplayer.sql)
// and the submit-result Edge Function. Every function takes the client so it can be
// tested with a fake one. All writes happen on the server; these only ask for them.
import type { Client } from '../supabase';
import type { RallyW } from '../../game/net';

/** Thrown with a message that is safe to show to the player; `code` is the server's reason. */
export class OnlineError extends Error {
  constructor(message: string, public code = '') { super(message); }
}

const MESSAGES: Record<string, string> = {
  not_signed_in: 'Sign in to play online.',
  room_not_found: 'No open room has that code.',
  room_full: 'That room is already full.',
  room_in_game: 'That room is in the middle of a match.',
  not_in_room: "You aren't in a room.",
  not_in_lobby: "You aren't in a lobby.",
  only_host_can_start: 'Only the host can start the match.',
  opponent_not_ready: "Your opponent isn't ready yet.",
  need_two_players: 'Waiting for a second player to join.',
  need_more_players: 'Waiting for more players to join.',
  only_host_can_change: 'Only the host can change the game type.',
  too_many_players: 'Too many players in the room for 1 vs 1.',
  seat_taken: 'That spot is taken.',
  host_keeps_seat: 'The host stays on team A.',
  bad_seat: "That spot isn't in this game.",
  bad_mode: 'Unknown game type.',
  could_not_create_room: 'Could not create a room. Please try again.',
  friend_not_found: 'No player has that friend code.',
  cannot_add_self: "That's your own friend code.",
  already_friends: "You're already friends.",
  too_many_friends: 'Your friends list is full.',
  request_not_found: 'That friend request is no longer there.',
  not_friends: 'You can only invite friends.',
  invite_expired: 'That invite has expired.',
  match_not_found: 'That match was not found.',
  opponent_still_connected: 'Your opponent is still connected.',
  too_early: 'Still waiting for your opponent.',
};

export function toOnlineError(error: { message?: string; code?: string } | null | undefined, fallback = 'Something went wrong. Please try again.'): OnlineError {
  const msg = error?.message || '';
  const code = Object.keys(MESSAGES).find(k => msg === k || msg.includes(k));
  if (code) return new OnlineError(MESSAGES[code], code);
  if (/network|fetch|timed? ?out|failed to send/i.test(msg)) return new OnlineError('No connection. Check your internet and try again.', 'network');
  if (/jwt|not authenticated|permission denied/i.test(msg)) return new OnlineError(MESSAGES.not_signed_in, 'not_signed_in');
  return new OnlineError(fallback, msg || 'unknown');
}

type Rpc = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> };

async function call<T>(db: Client, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db as unknown as Rpc).rpc(fn, args);
  if (error) throw toOnlineError(error);
  return data as T;
}

// ---------------------------------------------------------------------------
// Shapes returned by the server
// ---------------------------------------------------------------------------
export type OnlineMode = 'singles' | 'doubles';
/** Seats: 0 = host (team A), 1 = team B, 2 = team A, 3 = team B; team = seat % 2. */
export interface RoomPlayer {
  user_id: string; seat: number; team: 0 | 1; ready: boolean;
  name: string; avatar: Record<string, unknown>; paddle: string; rating: number;
}
export interface MatchPlayer {
  seat: number; user_id: string | null; team: 0 | 1; name: string; avatar: Record<string, unknown>; paddle: string;
}
export interface RoomMatch {
  id: string; mode?: OnlineMode; host_id: string; guest_id: string; status: string; started_at: string; players?: MatchPlayer[];
}
export interface RoomState {
  id: string; code: string; kind: 'private' | 'quick'; mode: OnlineMode; status: 'lobby' | 'playing';
  capacity?: number;
  host_id: string; match_id: string | null; players: RoomPlayer[]; match: RoomMatch | null;
}
export interface QuickResult { status: 'searching' | 'matched'; mode?: OnlineMode; waiting?: number; room?: RoomState }
export interface MyOnlineProfile {
  user_id: string; name: string; friend_code: string; rating: number;
  played: number; wins: number; losses: number; streak: number; best_streak: number; forfeits: number; longest_rally: number;
}
export interface Friend {
  user_id: string; name: string; avatar: Record<string, unknown>; paddle: string; rating: number;
  status: 'pending' | 'accepted'; incoming: boolean;
}
export interface Invite { id: number; code: string; mode?: OnlineMode; from_id: string; from_name: string; created_at: string }
export interface HeartbeatResult {
  status: string; reason: string | null; winner_id: string | null; winner_team: number | null;
  deltas?: Record<string, number>; opponent_seen_ago: number;
}
export interface OnlineHistoryRow {
  id: string; kind: string; mode?: OnlineMode; status: string; end_reason: string | null; started_at: string; ended_at: string | null;
  longest_rally: number | null; opponent: string; partner?: string | null; my_score: number | null; opp_score: number | null;
  won: boolean | null; rating_delta: number | null;
}
export interface OnlineLeaderRow {
  rank: number; name: string; rating: number; wins: number; losses: number; played: number; best_streak: number; is_me: boolean;
}
export interface SubmitOutcome {
  status: 'waiting_for_opponent' | 'finished' | 'disputed' | 'abandoned' | 'active' | 'rejected';
  winner_id?: string | null; winner_team?: number | null; reason?: string | null;
  /** rating change per player id */
  deltas?: Record<string, number>;
  host_score?: number | null; guest_score?: number | null; host_delta?: number | null; guest_delta?: number | null;
  report_valid?: boolean; invalid_reason?: string;
}

// ---------------------------------------------------------------------------
// Rooms, Quick Match, match lifecycle
// ---------------------------------------------------------------------------
export const getRoomState = (db: Client) => call<RoomState | null>(db, 'get_room_state');
export const createRoom = (db: Client, mode: OnlineMode = 'singles') => call<RoomState>(db, 'create_room', { p_mode: mode });
/** Host only, in the lobby: switch between 1 vs 1 and 2 vs 2. */
export const setRoomMode = (db: Client, mode: OnlineMode) => call<RoomState>(db, 'set_room_mode', { p_mode: mode });
/** Move to a free seat (seat % 2 is your team). The host stays in seat 0. */
export const changeSeat = (db: Client, seat: number) => call<RoomState>(db, 'change_seat', { p_seat: seat });
export const joinRoom = (db: Client, code: string) => call<RoomState>(db, 'join_room', { p_code: code.trim().toUpperCase() });
export const leaveRoom = (db: Client) => call<void>(db, 'leave_room');
export const setReady = (db: Client, ready: boolean) => call<RoomState>(db, 'set_ready', { p_ready: ready });
export const startMatch = (db: Client) => call<RoomState>(db, 'start_match');
export const quickMatch = (db: Client, mode: OnlineMode = 'singles') => call<QuickResult>(db, 'quick_match', { p_mode: mode });
export const cancelQuickMatch = (db: Client) => call<RoomState | null>(db, 'cancel_quick_match');
export const matchHeartbeat = (db: Client, matchId: string) => call<HeartbeatResult>(db, 'match_heartbeat', { p_match: matchId });
export const claimForfeit = (db: Client, matchId: string) => call<SubmitOutcome>(db, 'claim_forfeit', { p_match: matchId });
export const resolveMissingReport = (db: Client, matchId: string) => call<SubmitOutcome>(db, 'resolve_missing_report', { p_match: matchId });

// ---------------------------------------------------------------------------
// Friends and invites
// ---------------------------------------------------------------------------
export const sendFriendRequest = (db: Client, code: string) =>
  call<{ status: 'pending' | 'accepted'; name: string }>(db, 'send_friend_request', { p_code: code.trim().toUpperCase() });
export const respondFriendRequest = (db: Client, userId: string, accept: boolean) =>
  call<void>(db, 'respond_friend_request', { p_user: userId, p_accept: accept });
export const removeFriend = (db: Client, userId: string) => call<void>(db, 'remove_friend', { p_user: userId });
export const listFriends = (db: Client) => call<Friend[]>(db, 'list_friends');
export const inviteFriend = (db: Client, userId: string) => call<void>(db, 'invite_friend', { p_user: userId });
export const listInvites = (db: Client) => call<Invite[]>(db, 'list_invites');
export const respondInvite = (db: Client, id: number, accept: boolean) =>
  call<RoomState | null>(db, 'respond_invite', { p_invite: id, p_accept: accept });

// ---------------------------------------------------------------------------
// Profile, history, leaderboard
// ---------------------------------------------------------------------------
export const getMyOnlineProfile = (db: Client) => call<MyOnlineProfile | null>(db, 'get_my_online_profile');
export const getOnlineHistory = (db: Client, limit = 30) => call<OnlineHistoryRow[]>(db, 'get_online_history', { p_limit: limit });
export const getOnlineLeaderboard = (db: Client, maxRows = 20) =>
  call<OnlineLeaderRow[]>(db, 'get_online_leaderboard', { max_rows: maxRows });

// ---------------------------------------------------------------------------
// Result (Edge Function)
// ---------------------------------------------------------------------------
export interface ResultReport {
  match_id: string; host_score: number; guest_score: number; longest_rally: number; rallies: RallyW[];
}

export async function submitResult(db: Client, report: ResultReport): Promise<SubmitOutcome> {
  const { data, error } = await db.functions.invoke('submit-result', { body: report });
  if (error) {
    let body: Record<string, unknown> | null = null;
    try {
      const res = (error as { context?: { json?: () => Promise<Record<string, unknown>> } }).context;
      body = (await res?.json?.()) ?? null;
    } catch {
      /* not a JSON reply */
    }
    if (body && typeof body.status === 'string') return body as unknown as SubmitOutcome;
    throw toOnlineError({ message: String(body?.error ?? error.message ?? '') }, 'Could not send the result.');
  }
  return data as SubmitOutcome;
}
