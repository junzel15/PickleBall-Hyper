// Pickleball Hyper - scoring rules, used to check a reported match.
// Pure TypeScript with no imports so it runs in the Edge Function (Deno) and in the
// app's Jest tests. Must match the game engine (src/game/engine.ts, endRally):
//   * team 'h' (the host's side, team A) serves first
//   * only the serving side scores: rally won by the server -> +1 for the server
//   * singles: rally won by the receiver -> side out (no point)
//   * doubles: the game starts "0-0-2" (one server only); after that each side has a
//     first and a second server: the first lost rally passes the serve to the partner,
//     the second is a side out
//   * first to 11, win by 2; the game ends on the rally that reaches that score.

export const WIN_SCORE = 11;
export const MAX_RALLIES = 200;
/** Two rallies can't finish closer together than this (serve flight + point pause). */
export const MIN_RALLY_GAP_MS = 1000;

export type Side = 'h' | 'g';
export interface Rally { w: Side; t: number }

export type ReplayResult =
  | { ok: true; host: number; guest: number; winner: Side; lastT: number }
  | { ok: false; reason: string };

export type Mode = 'singles' | 'doubles';

/** Replays the rally winners in order and returns the final score, or why the log is impossible. */
export function replaySingles(rallies: unknown): ReplayResult {
  return replay(rallies, 'singles');
}

export function replay(rallies: unknown, mode: Mode): ReplayResult {
  if (!Array.isArray(rallies)) return { ok: false, reason: 'not_a_list' };
  if (rallies.length < WIN_SCORE) return { ok: false, reason: 'too_few_rallies' };
  if (rallies.length > MAX_RALLIES) return { ok: false, reason: 'too_many_rallies' };
  const score: Record<Side, number> = { h: 0, g: 0 };
  let server: Side = 'h';
  let serverNum = mode === 'doubles' ? 2 : 1; // doubles starts "0-0-2"
  let lastT = -Infinity;
  for (let i = 0; i < rallies.length; i++) {
    const r = rallies[i] as Partial<Rally> | null;
    if (!r || (r.w !== 'h' && r.w !== 'g')) return { ok: false, reason: `bad_winner_at_${i}` };
    if (typeof r.t !== 'number' || !Number.isFinite(r.t) || r.t < 0 || r.t > 3_600_000) {
      return { ok: false, reason: `bad_time_at_${i}` };
    }
    if (r.t < lastT + MIN_RALLY_GAP_MS) return { ok: false, reason: `too_fast_at_${i}` };
    lastT = r.t;
    if (r.w === server) score[server]++;
    else if (mode === 'doubles' && serverNum === 1) serverNum = 2;
    else { server = r.w; serverNum = 1; }
    const other: Side = server === 'h' ? 'g' : 'h';
    const over = score[server] >= WIN_SCORE && score[server] - score[other] >= 2;
    if (over) {
      if (i !== rallies.length - 1) return { ok: false, reason: 'rallies_after_game_end' };
      return { ok: true, host: score.h, guest: score.g, winner: server, lastT };
    }
  }
  return { ok: false, reason: 'game_not_finished' };
}

export interface Report {
  match_id: string;
  host_score: number;
  guest_score: number;
  longest_rally: number;
  rallies: Rally[];
}

export type CheckResult =
  | { valid: true; winners: string; host: number; guest: number; lastT: number }
  | { valid: false; reason: string; winners: string; lastT: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isInt = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

/** Shape check for the request body. Returns null when it can't even be stored. */
export function parseReport(body: unknown): Report | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  if (typeof b.match_id !== 'string' || !UUID.test(b.match_id)) return null;
  if (!isInt(b.host_score, 0, 99) || !isInt(b.guest_score, 0, 99) || !isInt(b.longest_rally, 0, 999)) return null;
  if (!Array.isArray(b.rallies) || b.rallies.length < 1 || b.rallies.length > MAX_RALLIES) return null;
  return b as unknown as Report;
}

/**
 * Full check of a report: the rally log must be a legal game ending at the claimed score.
 * host_score / guest_score are team A / team B (the host's side / the other side).
 */
export function checkReport(r: Report, mode: Mode = 'singles'): CheckResult {
  const winners = r.rallies.map(x => (x && (x as Rally).w === 'g' ? 'g' : 'h')).join('');
  const res = replay(r.rallies, mode);
  if (!res.ok) return { valid: false, reason: res.reason, winners, lastT: 0 };
  if (res.host !== r.host_score || res.guest !== r.guest_score) {
    return { valid: false, reason: 'score_does_not_match_rallies', winners, lastT: res.lastT };
  }
  // a rally needs a serve plus a return: the longest rally can't exceed what time allows
  if (r.longest_rally > Math.max(1, Math.round(res.lastT / 300))) {
    return { valid: false, reason: 'rally_too_long_for_time', winners, lastT: res.lastT };
  }
  return { valid: true, winners, host: res.host, guest: res.guest, lastT: res.lastT };
}
