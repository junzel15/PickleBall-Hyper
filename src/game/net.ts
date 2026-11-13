// Online match protocol (host-authoritative).
//
// The host's phone runs the real match simulation. In the host's game team A (the
// host's side) is at the bottom and team B at the top. Players on team B see the
// match mirrored, so everyone sees themselves at the bottom: every position is
// flipped (x -> COURT_W - x, y -> COURT_L - y) and the teams swap. The host's
// doubles partner (seat 2) sees it the same way round as the host.
//
// All coordinates on the wire are in the HOST's frame; only team B mirrors.
//
//   guest -> host : position reports ('in'), shot taps ('shot'), Hyper ('hyper'),
//                   'hello' on (re)connect, 'need_log' when rally events were missed
//                   (each guest sends on its own channel, so the host knows who sent it)
//   host -> guests: snapshots ('snap', 20 per second) and match events ('ev')
//
// Messages are kept short (single-letter keys, numbers rounded to 2 decimals) to
// keep Realtime traffic small.

export const COURT_W = 20;
export const COURT_L = 44;

/** Snapshot interval (host -> guest). */
export const SNAPSHOT_MS = 50;
/** Guest position report: at most this often while moving, and a keepalive otherwise. */
export const INPUT_MS = 50;
export const KEEPALIVE_MS = 400;
/** No message from the other side for this long: they are treated as disconnected. */
export const SILENCE_MS = 2500;

export type TeamW = 0 | 1;           // 0 = host's team ('player' on the host), 1 = guest's team
export type ShotW = 'drive' | 'dink' | 'lob' | 'smash';
export type StateW = 'serve' | 'rally' | 'point' | 'over';

/** Ball: x, y, z, vx, vy, vz, gravity, flags (1 held, 2 netted, 4 power). */
export type BallW = [number, number, number, number, number, number, number, number];

// Seats: 0 = host (team A), 1 = team B, 2 = team A, 3 = team B (singles: seats 0 and 1).
export const teamOfSeat = (seat: number): TeamW => (seat % 2) as TeamW;

export interface Snapshot {
  k: 'snap';
  q: number;                 // sequence
  st: StateW;
  sc: [number, number];      // team A score, team B score
  sv: TeamW;                 // serving team
  ss: number;                // serving seat
  sn: number;                // server number (doubles: 1 or 2)
  lh: -1 | TeamW;            // last hitter
  sh: number;                // shots this rally
  bn: number;                // bounces since the last hit
  ct: string[];              // court letter of each seat
  p: [number, number][];     // x, y of each seat (as accepted by the host)
  b: BallW;
  e: [number, number][];     // Hyper meter and Hyper time left, per seat
  gw: -1 | TeamW;            // game winner once decided
  rc: number;                // rallies played so far
  hh: [number, number];      // serving half (x range) for the server
  ts: number;                // host match clock (ms)
  sg: number;                // serve-setup counter: players were placed for a new serve
  hw?: string;               // the host is holding the match, waiting for these players
}

export type MatchEvent =
  | { k: 'hit'; s: number; t: TeamW; ty: ShotW; sk: string; sm: boolean; hy: boolean; p: [number, number, number]; b: BallW; n: number }
  | { k: 'serve'; s: number; t: TeamW; b: BallW }
  | { k: 'wind'; s: number }   // the server started the serve motion (older guests ignore it)
  | { k: 'ref'; r: 0 | 1; p: string; x: string; c?: string; tg?: [number, number]; w?: boolean; s?: string; i?: boolean; d?: number }
  | { k: 'refx'; x: string }
  | { k: 'float'; x: number; y: number; tx: string; c: string; s: number }
  | { k: 'point'; w: TeamW; r: string; mb: -1 | TeamW; m: string; i: number; ts: number; ace: boolean; gw: -1 | TeamW }
  | { k: 'setup' }
  | { k: 'hyper'; s: number; a: 'on' | 'ready' | 'over' }
  | { k: 'over'; w: TeamW; sc: [number, number]; lr: number }
  | { k: 'log'; l: RallyW[] };

export interface RallyW { w: 'h' | 'g'; t: number }

export type HostMsg = Snapshot | { k: 'ev'; e: MatchEvent };

export type GuestMsg =
  | { k: 'in'; x: number; y: number; a: -1 | 0 | 1; s: number } // s: the serve-setup counter the guest has seen
  | { k: 'shot'; ty: ShotW; a: -1 | 0 | 1 }
  | { k: 'hyper' }
  | { k: 'hello' }
  | { k: 'need_log' };

export type NetMsg = HostMsg | GuestMsg;

export const r2 = (n: number) => Math.round(n * 100) / 100;
export const mirrorX = (x: number) => COURT_W - x;
export const mirrorY = (y: number) => COURT_L - y;

export function packBall(b: { x: number; y: number; z: number; vx: number; vy: number; vz: number; g?: number; held: boolean; netted: boolean; power?: boolean }): BallW {
  return [r2(b.x), r2(b.y), r2(b.z), r2(b.vx), r2(b.vy), r2(b.vz), r2(b.g || 32),
    (b.held ? 1 : 0) | (b.netted ? 2 : 0) | (b.power ? 4 : 0)];
}

/** Ball in the guest's (mirrored) frame. */
export function mirrorBall(b: BallW): BallW {
  return [mirrorX(b[0]), mirrorY(b[1]), b[2], -b[3], -b[4], b[5], b[6], b[7]];
}

const SHOTS: ShotW[] = ['drive', 'dink', 'lob', 'smash'];
const STATES: StateW[] = ['serve', 'rally', 'point', 'over'];
const isNum = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const isAim = (n: unknown) => n === -1 || n === 0 || n === 1;

/** Validates a guest -> host message (the host never trusts what it receives). */
export function parseGuestMsg(m: unknown): GuestMsg | null {
  const o = m as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  switch (o.k) {
    case 'in':
      return isNum(o.x) && isNum(o.y) && isAim(o.a) && isNum(o.s)
        ? { k: 'in', x: o.x as number, y: o.y as number, a: o.a as -1 | 0 | 1, s: o.s as number }
        : null;
    case 'shot':
      return SHOTS.includes(o.ty as ShotW) && isAim(o.a) ? { k: 'shot', ty: o.ty as ShotW, a: o.a as -1 | 0 | 1 } : null;
    case 'hyper': case 'hello': case 'need_log':
      return { k: o.k };
    default:
      return null;
  }
}

/** Light shape check of a host -> guest message. */
export function parseHostMsg(m: unknown): HostMsg | null {
  const o = m as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (o.k === 'snap') {
    if (!STATES.includes(o.st as StateW) || !Array.isArray(o.b) || o.b.length !== 8 || !Array.isArray(o.sc)
      || !Array.isArray(o.p) || !Array.isArray(o.e) || !Array.isArray(o.ct)) return null;
    return o as unknown as Snapshot;
  }
  if (o.k === 'ev' && o.e && typeof o.e === 'object' && typeof (o.e as { k?: unknown }).k === 'string') {
    return o as unknown as HostMsg;
  }
  return null;
}
