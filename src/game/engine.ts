/**
 * Pickleball game engine — a TypeScript port of the browser game's game.js.
 *
 * Gameplay, physics, AI, scoring, referees, effects and rendering are kept the
 * same as the original. What changed for Android:
 *   - the canvas is a Skia picture recorded each frame (see canvas2d.ts)
 *   - DOM updates (menus, banner, HUD buttons) became a UI state that the
 *     React Native screens subscribe to
 *   - the on-screen touch controls (stick, DRIVE/DINK/LOB/SMASH, HYPER) are drawn on
 *     the court exactly like the browser's touch layout and hit-tested here
 *   - Web Speech -> native TextToSpeech, Web Audio -> react-native-audio-api,
 *     navigator.vibrate -> Vibration, localStorage -> AsyncStorage
 */
import { Skia } from '@shopify/react-native-skia';
import type { SkPicture } from '@shopify/react-native-skia';
import { Vibration } from 'react-native';
import { CanvasGradient, Ctx2D, recordSprite, Sprite } from './canvas2d';
import { rgba, shade } from './colors';
import { ensureAudio, isMuted, setMuted, sfx } from './audio';
import { hushSpeech, speak, speech, waitForVoices } from './speech';
import {
  Avatar, BOTS, cloneProfile, legacy2D, defaultProfile, drawHeadBillboard, HeadLook, Look,
  PADDLES, paddleById, paddleSprite, Profile, SHOES,
} from './customize';
import {
  BallW, GuestMsg, HostMsg, KEEPALIVE_MS, INPUT_MS, MatchEvent, mirrorBall, packBall, parseGuestMsg,
  parseHostMsg, r2, RallyW, SNAPSHOT_MS, Snapshot, TeamW,
} from './net';

// =====================================================================
//  Court geometry (all game units are in FEET; a real court is 20 x 44)
//  y = 0 is the CPU baseline (top of screen), y = 44 is your baseline.
//  Teams: 'player' = bottom (you + partner), 'ai' = top (CPU).
// =====================================================================
const COURT_W = 20;
const COURT_L = 44;
const NET_Y = 22;
const KITCHEN = 7;
const TOP_KITCHEN = NET_Y - KITCHEN; // 15 — CPU's kitchen line
const BOT_KITCHEN = NET_Y + KITCHEN; // 29 — your kitchen line
const NET_H = 2.9;                   // ~34-36 inches (used for shot planning)
/** Real net height across the court: 36 in at the posts (1 ft outside the sidelines), 34 in at the centre. */
const netTopAt = (x: number) => 34 / 12 + (36 / 12 - 34 / 12) * Math.min(1, ((x - COURT_W / 2) / (COURT_W / 2 + 1)) ** 2);
const G = 32;                        // gravity, ft/s^2
const BOUNCE_Z = 0.55;               // vertical restitution
const BOUNCE_XY = 0.82;              // horizontal speed kept on bounce

// Hyper skill look: electric cyan + the game's lime
const HYPER_COLOR = '#7cf2ff';
const HYPER_SPARKS = ['#7cf2ff', '#19b7d6', '#d7f23b', '#ffffff'];

const PLAYER_SPEED = 19.5;           // ft/s at full stick (was 15: felt sluggish on phones)
const REACH = 4.2;           // furthest the player can reach the ball (ft); a step + lunge covers it
const NET_REACH_BONUS = 0.8; // online: extra reach for other people's players (their position is a little old)
const CONTACT_IDEAL = 1.3;   // body-to-ball distance where the paddle meets the ball
const SWING_WINDOW = 0.25;   // a tap with no ball coming: a quick practice swing
const SHOT_BUFFER = 1.4;     // a tap while the ball is coming: once it's on your side, the shot waits this long
const RECEIVE_ASSIST = 10;   // ft/s of gentle sideways help toward the contact spot while a shot waits
const WIN_SCORE = 11;
const X_MIN = -3, X_MAX = COURT_W + 3; // keeps everyone clear of the referee stands

export type Team = 'player' | 'ai';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type Mode = 'singles' | 'doubles';
type State = 'menu' | 'serve' | 'rally' | 'point' | 'paused' | 'over';
type ShotType = 'drive' | 'dink' | 'lob' | 'smash';

interface Skill { speed: number; error: number; reaction: number; smart: number; reach: number; home: number }
// home = how far from the net (feet) a player likes to stand during a rally
const DIFFICULTY: Record<Difficulty, Skill> = {
  easy: { speed: 10.5, error: 2.4, reaction: 0.38, smart: 0.35, reach: 2.9, home: 13 },
  medium: { speed: 12.5, error: 1.5, reaction: 0.24, smart: 0.65, reach: 3.1, home: 9.5 },
  hard: { speed: 14.5, error: 0.85, reaction: 0.13, smart: 0.9, reach: 3.3, home: 8.6 },
};
const PARTNER_SKILL: Skill = { speed: 13, error: 1.2, reaction: 0.2, smart: 0.75, reach: 3.2, home: 9 };

// ---------- computer players' personalities (arcade flavour) ----------
// Each CPU player gets a style for the match: which shots it likes, how fast it is,
// how quickly it reacts and how many risks it takes. Difficulty still sets the base
// skill; the style decides HOW the bot plays, so no two matches feel the same.
interface BotStyle {
  title: string;
  drive: number; dink: number; lob: number; // shot preferences (multipliers)
  angle: number;  // chance to go for a sharp sideline angle
  body: number;   // chance to drive straight at an opponent at the net
  speed: number; react: number; risk: number; // movement, reaction time, error multipliers
  home: number;   // feet further from (+) or closer to (-) the net than usual
  smashAt: number; // lowest ball height it will try to smash
}
const BOT_STYLES: BotStyle[] = [
  { title: 'POWER HITTER', drive: 1.6, dink: 0.5, lob: 0.5, angle: 0.2, body: 0.4, speed: 1.0, react: 0.9, risk: 1.25, home: -0.5, smashAt: 4.0 },
  { title: 'SOFT TOUCH', drive: 0.7, dink: 1.8, lob: 0.6, angle: 0.4, body: 0.1, speed: 1.0, react: 1.0, risk: 0.8, home: -1.4, smashAt: 4.8 },
  { title: 'MOONBALLER', drive: 0.9, dink: 0.8, lob: 2.8, angle: 0.2, body: 0.1, speed: 1.05, react: 1.0, risk: 1.0, home: 1.8, smashAt: 4.6 },
  { title: 'SPEED DEMON', drive: 1.1, dink: 1.0, lob: 0.8, angle: 0.45, body: 0.2, speed: 1.2, react: 0.8, risk: 1.1, home: 0, smashAt: 4.4 },
  { title: 'ALL-ROUNDER', drive: 1.0, dink: 1.0, lob: 1.0, angle: 0.3, body: 0.25, speed: 1.06, react: 0.95, risk: 0.95, home: 0, smashAt: 4.4 },
];
const STEADY_STYLE = BOT_STYLES[4];
/** How fast CPU players charge Hyper (Easy bots never use it). */
const BOT_HYPER_RATE: Record<Difficulty, number> = { easy: 0, medium: 0.6, hard: 0.9 };

// ---------- helpers ----------
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]): T => arr[(Math.random() * arr.length) | 0];
const randn = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const other = (w: Team): Team => (w === 'player' ? 'ai' : 'player');
const sideOf = (y: number): Team => (y < NET_Y ? 'ai' : 'player');
const ownY = (team: Team, distFromNet: number) => (team === 'ai' ? NET_Y - distFromNet : NET_Y + distFromNet);
const behindBaseline = (team: Team) => (team === 'ai' ? -1.5 : COURT_L + 1.5);
const clampOwnY = (team: Team, y: number) => (team === 'ai' ? clamp(y, -5.5, NET_Y - 0.6) : clamp(y, NET_Y + 0.6, COURT_L + 5.5));
const inKitchen = (team: Team, y: number) => (team === 'ai' ? y > TOP_KITCHEN : y < BOT_KITCHEN);
const lerpAng = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);
const wrap01 = (x: number) => ((x % 1) + 1) % 1;

// Screen x-range of a team's right ('R') or left ('L') court, from that team's own view.
// The CPU team faces down the screen, so its right is the screen's left.
function courtHalf(team: Team, court: 'R' | 'L'): [number, number] {
  const screenRight = team === 'player' ? court === 'R' : court === 'L';
  return screenRight ? [10, 20] : [0, 10];
}

function buzz(ms: number | number[]): void {
  try {
    if (Array.isArray(ms)) Vibration.vibrate([0, ...ms]);
    else Vibration.vibrate(ms);
  } catch {
    /* ignore */
  }
}

// =====================================================================
//  Types
// =====================================================================
interface Pose { hand: number[]; off: number[]; crouch: number; lean: number; stance: number; turn: number; step: number[] }
interface Plan { x: number; y: number; t: number; gap: number }
/** Hyper meter (one per human player). */
interface Energy { value: number; hyperT: number; denied: number; fullPulse: number; auraT: number }
const newEnergy = (): Energy => ({ value: 0, hyperT: 0, denied: 0, fullPulse: 0, auraT: 0 });
/** Online: what a remote player reported (host) / where the host says they are (guest). */
interface NetAth { x: number; y: number; aim: -1 | 0 | 1; have: boolean; gen: number; last: number }
interface Athlete {
  id: string; team: Team; human: boolean;
  name: string; avatar: Avatar; paddle: string;
  x: number; y: number; vx: number; vy: number; phase: number; dustT: number; jump: number; swingAnim: number;
  stroke: string | null; strokeT: number; strokeRate: number; tip: number[][];
  prep: number; prepKind: string; split: number; cheer: number;
  lefty: boolean;
  swing: number; swingType: ShotType;
  queued?: boolean;                                    // a shot is waiting for the incoming ball
  lungeT?: number; lungeVX?: number; lungeVY?: number; // quick step toward the ball at contact
  plan: Plan | null; reactT: number; skill: Skill;
  court: 'R' | 'L';
  mvx?: number; mvy?: number;
  loco?: number; runFrac?: number; latFrac?: number; dirX?: number; dirW?: number; gait?: number;
  vis?: Pose;
  visV?: Pose; // pose velocities for the spring smoothing
  cpt?: { x: number; y: number; z: number } | null; // where the paddle met the ball (world), for the swing to reach it
  en: Energy;          // Hyper meter
  style: BotStyle;     // CPU players: how they play this match
  seat: number;        // online seat (0 = host); -1 offline
  net: NetAth | null;  // online: another person's athlete
}
/** One player as the 3D layer sees it (court feet: x across, y along the court, z up). */
export interface Athlete3D {
  id: string; team: Team; lefty: boolean;
  x: number; y: number; vx: number; vy: number; lift: number;
  stroke: string | null; strokeT: number; prep: number; prepKind: string;
  inRally: boolean; cheer: boolean;
  avatar: Avatar; paddle: string;
  serving: boolean;                                     // waiting to serve
  serverMark: boolean;                                  // show the serving arrow over their head
  contact: { x: number; y: number; z: number } | null;  // where the paddle meets the ball this stroke
}
/** A mark on the floor: a (soft) disc, a ring, a dashed ring or a rectangle (x..x1, y..y1). */
export interface Decal3D {
  k: 'disc' | 'ring' | 'dash' | 'quad';
  x: number; y: number; rx: number; ry: number; x1?: number; y1?: number;
  w?: number; rot?: number; soft?: boolean; c: string; a: number;
}
/** The indoor hall around the court (feet), for the 3D layer. */
export interface Hall3D {
  left: number; right: number; back: number; ceil: number; pad: number; near: number;
  lights: { x: number; y: number }[]; dividers: number[]; benches: { x: number; y: number; facing: number }[];
}
export interface Ball3D { x: number; y: number; z: number; spin: number; squash: number; visible: boolean; holder: string | null }
export interface Ref3D { x: number; y: number; face: number; pose: string; look: number; target: { x: number; y: number } | null }
/** The game's pinhole camera (see proj()) plus the players, ball and umpires, for the 3D layer. */
export interface Scene3D {
  w: number; h: number;
  cam: { x: number; y: number; h: number; f: number; cx: number; hor: number };
  paused: boolean;
  clock: number;
  hall: Hall3D;
  decals: Decal3D[];
  ball: Ball3D;
  refs: Ref3D[];
  athletes: Athlete3D[];
}
interface Ball {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  held: boolean; netted: boolean; spin: number; squash: number; g?: number; power?: boolean;
}
interface Particle {
  t: number; life: number; size: number; g: number; z: number; vz: number; kind: 'spark' | 'dust'; color: string;
  x: number; y: number; vx: number; vy: number;
}
interface Confetti { x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; color: string; t: number; life: number; wob: number }
interface Floater { x: number; y: number; text: string; color: string; size: number; t: number; life: number }
type RefPose = 'idle' | 'in' | 'out' | 'kitchen' | 'fault' | 'score' | 'point';
interface Bubble { text: string; t: number; life: number; color: string }
interface Ref { x: number; y: number; face: number; pitch: number; pose: RefPose; poseT: number; target: { x: number; y: number } | null; bubble: Bubble | null; look: number }
interface Box { x0: number; x1: number; y0: number; y1: number }
interface TrailPt { x: number; y: number; z: number; hot: boolean; power: boolean }
interface ArmDir { dx?: number; dy?: number; len: number; up?: boolean; flag?: string }

// =====================================================================
//  UI state shared with the React Native screens
// =====================================================================
/** Summary of a finished match (saved to the cloud match history). */
export interface MatchResult {
  mode: Mode; difficulty: Difficulty; playerScore: number; aiScore: number; won: boolean;
  ralliesWon: number; longestRally: number; opponent: string;
}

export interface BannerState { id: number; title: string; msg: string; kind: 'good' | 'bad' | ''; show: boolean }

/** An online match in progress (null when playing the CPU). */
export interface OnlineUi {
  role: 'host' | 'guest';
  opponent: string;
  /** playing | waiting: the other player's messages stopped | ended: the match is over */
  link: 'playing' | 'waiting' | 'ended';
  /** The ☰ Menu over an online match (Resume / Leave match). */
  menuOpen: boolean;
  /** Shown while waiting / after the match (e.g. "Saving result…", "+16 rating"). */
  note: string;
}

/** Final result of an online match as seen by this player (what the server is sent). */
export interface OnlineMatchEnd {
  hostScore: number;   // team A (the host's side)
  guestScore: number;  // team B
  longestRally: number;
  rallies: RallyW[];
}

/** What the host saves after every rally so a restarted app can resume the match. */
export interface OnlineResume {
  score: [number, number];   // team A, team B
  server: TeamW;
  serverSeat: number;
  serverNum: number;
  courts: string[];          // per seat
  energy: number[];          // per seat (Hyper itself isn't carried over)
  rallies: RallyW[];
  clock: number;
  longestRally: number;
}

export interface OnlineStart {
  role: 'host' | 'guest';
  mode: Mode;
  /** Your seat: 0 = host (team A), 1 = team B, 2 = team A, 3 = team B. */
  seat: number;
  send: (m: HostMsg | GuestMsg) => void;
  /** Everyone else in the match and their look. */
  others: { seat: number; look: Look }[];
  resume?: OnlineResume | null;
}
export interface UiState {
  loading: boolean;
  loader: { progress: number; status: string; tip: string; done: boolean };
  state: State;
  /** Which full-screen overlay is up. */
  menuOpen: boolean;
  pauseOpen: boolean;
  overOpen: boolean;
  customizeOpen: boolean;
  /** A match is paused behind the main menu. */
  suspended: boolean;
  selectedMode: Mode;
  difficulty: Difficulty;
  voiceOn: boolean;
  voiceAvailable: boolean;
  muted: boolean;
  banner: BannerState;
  gameOver: { title: string; score: string; stats: string };
  profile: Profile;
  online: OnlineUi | null;
}

export const LOAD_TIPS = [
  "Tip: Let the serve and the return bounce — that's the two-bounce rule.",
  'Tip: Stay out of the kitchen when you volley.',
  'Tip: A soft DINK into the kitchen forces the other side to hit up.',
  'Tip: Only the serving side can score a point.',
  'Tip: Push the stick left or right as you hit to aim for a sideline.',
  'Tip: Tap SMASH on high balls — watch the shadow to judge the height.',
  'Tip: When the HYPER bar is full, tap HYPER for 5 seconds of stronger shots.',
  'Tip: Serve from the right when your score is even, the left when odd.',
  'Tip: In doubles the score has three numbers — the last one is the server.',
];

// =====================================================================
//  The game
// =====================================================================
export function createGame() {
  // Canvas size in pixels (follows the screen) and the perspective camera
  let VIEW_W = 960;
  let VIEW_H = 600;
  const cam = { x: 10, y: 76, h: 22, f: 800, hor: 0, cx: 480, pan: 0 };
  let ctx: Ctx2D = null as unknown as Ctx2D;
  const frameRecorder = Skia.PictureRecorder();
  let frameCtx: Ctx2D | null = null;
  // 3D players: when on, the frame is split into a background picture (court, shadows)
  // and a transparent foreground picture (ball, effects, HUD), with the 3D layer between.
  let use3D = false;
  const frontRecorder = Skia.PictureRecorder();
  let frontCtx: Ctx2D | null = null;
  let frontPic: SkPicture | null = null;
  const view3D = { ox: 0, oy: 0 }; // screen offset (camera pan + shake) applied this frame

  // ---------- graphics quality (adjusted automatically to the device) ----------
  // 2 = high, 1 = medium, 0 = low. Lower levels skip a few costly effects.
  let quality = 2;
  // touch device held sideways: full-screen court, score drawn on it, controls float over it
  const compactHud = true;
  let hudRightW = 0;

  // ---------- UI store ----------
  const listeners = new Set<() => void>();
  let ui: UiState = {
    loading: true,
    loader: { progress: 0.08, status: 'Loading…', tip: LOAD_TIPS[(Math.random() * LOAD_TIPS.length) | 0], done: false },
    state: 'menu',
    menuOpen: true,
    pauseOpen: false,
    overOpen: false,
    customizeOpen: false,
    suspended: false,
    selectedMode: 'singles',
    difficulty: 'medium',
    voiceOn: true,
    voiceAvailable: speech.ok,
    muted: false,
    banner: { id: 0, title: '', msg: '', kind: '', show: false },
    gameOver: { title: '', score: '', stats: '' },
    profile: defaultProfile(),
    online: null,
  };
  function setUi(patch: Partial<UiState>): void {
    ui = { ...ui, ...patch };
    listeners.forEach(fn => fn());
  }

  // =====================================================================
  //  Players (athletes)
  // =====================================================================
  function makeAthlete(id: string, team: Team, human: boolean, look: Look): Athlete {
    return {
      id, team, human,
      name: look.name, avatar: { ...look.avatar }, paddle: look.paddle,
      x: 0, y: 0, vx: 0, vy: 0, phase: 0, dustT: 0, jump: 0, swingAnim: 0,
      stroke: null, strokeT: 0, strokeRate: 3, tip: [],   // current stroke animation
      prep: 0, prepKind: 'drive_fh', split: 0, cheer: 0,  // backswing, split step, celebration
      lefty: false,
      swing: 0, swingType: 'drive', // human swing window
      plan: null, reactT: 0, skill: DIFFICULTY.medium, // bots
      court: 'R',
      en: newEnergy(), style: STEADY_STYLE, seat: -1, net: null,
    };
  }
  const player = makeAthlete('you', 'player', true, { ...ui.profile });
  const mate = makeAthlete('mate', 'player', false, BOTS.mate);   // Bot Player 3 (your doubles partner)
  const ai = makeAthlete('cpu1', 'ai', false, BOTS.cpu1);         // Bot Player 1
  const ai2 = makeAthlete('cpu2', 'ai', false, BOTS.cpu2);        // Bot Player 2
  mate.skill = PARTNER_SKILL;
  mate.lefty = true; // your partner plays left-handed

  // ---------- realistic random names for the computer players ----------
  const FIRST_NAMES = {
    male: ['James', 'John', 'Michael', 'David', 'Daniel', 'Carlos', 'Marco', 'Ethan', 'Lucas', 'Noah', 'Ryan', 'Kevin',
      'Brian', 'Jason', 'Mark', 'Paul', 'Adrian', 'Miguel', 'Leo', 'Samuel', 'Victor', 'Nathan', 'Oliver', 'Diego',
      'Andre', 'Kenji', 'Rafael', 'Thomas', 'Liam', 'Mateo', 'Omar', 'Felix'],
    female: ['Maria', 'Emma', 'Olivia', 'Sophia', 'Mia', 'Isabella', 'Grace', 'Chloe', 'Hannah', 'Sarah', 'Laura', 'Nina',
      'Elena', 'Camila', 'Ava', 'Lily', 'Rachel', 'Jessica', 'Andrea', 'Bianca', 'Yuki', 'Priya', 'Zoe', 'Sofia',
      'Clara', 'Leah', 'Maya', 'Julia'],
  };
  const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Garcia', 'Martinez', 'Lopez', 'Wilson', 'Anderson', 'Taylor',
    'Thomas', 'Moore', 'Martin', 'Lee', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Nelson',
    'Carter', 'Rivera', 'Cruz', 'Reyes', 'Santos', 'Kim', 'Nguyen', 'Patel', 'Rossi', 'Silva', 'Tanaka', 'Murphy',
    'Bennett', 'Hughes', 'Foster', 'Morgan', 'Reed', 'Ramos', 'Bautista'];

  // Give each CPU opponent a different playing style for the match (your partner plays steady)
  function assignBotStyles() {
    const pool = BOT_STYLES.slice();
    for (const b of [ai, ai2]) b.style = pool.splice((Math.random() * pool.length) | 0, 1)[0];
    mate.style = STEADY_STYLE;
  }

  // Give every computer player a different full name (called at the start of each game)
  function assignBotNames() {
    const used = new Set([player.name.toLowerCase()]);
    const usedLast = new Set<string>();
    for (const b of [ai, ai2, mate]) {
      const firsts = FIRST_NAMES[b.avatar.gender === 'female' ? 'female' : 'male'];
      let name = '';
      for (let i = 0; i < 50; i++) {
        const last = LAST_NAMES[(Math.random() * LAST_NAMES.length) | 0];
        name = `${firsts[(Math.random() * firsts.length) | 0]} ${last}`;
        if (!used.has(name.toLowerCase()) && !usedLast.has(last)) { usedLast.add(last); break; }
      }
      used.add(name.toLowerCase());
      b.name = name;
    }
  }
  const firstName = (a: Athlete) => a.name.split(' ')[0];

  // Names for messages, the scoreboard and the referee
  function teamLabel(team: Team) {
    if (team === 'player') return mode === 'doubles' ? `${player.name} & ${mate.name}` : player.name;
    return mode === 'doubles' ? `${ai.name} & ${ai2.name}` : ai.name;
  }
  // Short form for tight spaces (scoreboards): both partners' first names in doubles
  function teamShort(team: Team) {
    if (team === 'player') return mode === 'doubles' ? `${firstName(player)} & ${firstName(mate)}` : player.name;
    return mode === 'doubles' ? `${firstName(ai)} & ${firstName(ai2)}` : ai.name;
  }
  // Scoreboard rows: "HANA / PIA" in doubles, the full name in singles
  function boardName(team: Team) {
    const [a, b] = team === 'player' ? [player, mate] : [ai, ai2];
    return (mode === 'doubles' ? `${firstName(a)} / ${firstName(b)}` : a.name).toUpperCase();
  }
  const teamVerb = () => (mode === 'doubles' ? 'win' : 'wins');

  let mode: Mode = 'singles'; // the match being played
  let roster: Athlete[] = [player, ai];
  const teamOf = (team: Team) => roster.filter(a => a.team === team);
  const partnerOf = (a: Athlete) => roster.find(b => b.team === a.team && b !== a) || a;
  const teamCenter = (team: Team) => {
    const t = teamOf(team);
    return { x: t.reduce((s, a) => s + a.x, 0) / t.length, y: t.reduce((s, a) => s + a.y, 0) / t.length };
  };

  // =====================================================================
  //  Game state
  // =====================================================================
  let state: State = 'menu';
  let pausedFrom: State | null = null;
  let stateTimer = 0;
  let gameWinner: Team | null = null;

  const score: Record<Team, number> = { player: 0, ai: 0 };
  const streak = { team: null as Team | null, n: 0 }; // rallies won in a row
  let server: Team = 'player';    // serving team
  let serverAth: Athlete = player; // who is serving
  let serverNum = 1;        // doubles: 1st or 2nd server
  let shots = 0;            // hits in this rally (serve = 1)
  let bounces = 0;          // bounces since the last hit
  let lastHitter: Team | null = null; // team that hit last
  let serveBox: Box | null = null;    // target service box
  let serveHalf: [number, number] = [10, 20];
  let longestRally = 0;
  let pointsWon = 0;
  const interceptor: Record<Team, Athlete | null> = { player: null, ai: null }; // which bot chases the incoming ball

  const ball: Ball = { x: 10, y: 33, z: 0, vx: 0, vy: 0, vz: 0, held: true, netted: false, spin: 0, squash: 0 };

  let landing: { x: number; y: number } | null = null;
  let trail: TrailPt[] = [];

  // ---------- online play (see net.ts) ----------
  // Seats: 0 = host (team A), 1 = team B, 2 = team A, 3 = team B (singles: 0 and 1).
  // host: runs the match; other people's athletes move by their own reports.
  // guest: draws the host's match (mirrored when on team B, so everyone plays from the
  //        bottom of the screen); only its own movement is simulated here.
  let netRole: 'off' | 'host' | 'guest' = 'off';
  let netSend: ((m: HostMsg | GuestMsg) => void) | null = null;
  let netHold = false;              // host: play waits while someone is away
  let netClock = 0;                 // host: match time in ms (stops while waiting)
  let snapT = 0, snapSeq = 0;       // host: snapshot timer
  let mySeat = 0;
  let myTeamW: TeamW = 0;           // 0 = team A (the host's side), 1 = team B
  let seats: Athlete[] = [];        // online: the athlete in each seat
  let rallyLog: RallyW[] = [];      // winning team of every rally ('h' team A / 'g' team B), in order
  let lastRecv = 0;                 // guest: Date.now() of the last message from the host
  let inT = 0, lastInKey = '', lastInSent = 0; // guest: position report throttle
  let needLogAt = 0;                // guest: last time the rally log was requested
  let guestPointsWon = 0;
  let setupGen = 0;                 // counts serve setups (players are placed for each serve)
  let seenGen = -1;                 // guest: last serve setup seen
  let holdNames = '';               // host: who the match is waiting for
  let holdT = 0;
  const onlineEndListeners = new Set<(r: OnlineMatchEnd) => void>();
  const rallyListeners = new Set<() => void>();
  const isGuest = () => netRole === 'guest';
  const mirrored = () => isGuest() && myTeamW === 1;
  // wire team 0 = team A (the host's side), 1 = team B
  const toW = (t: Team): TeamW => (t === 'player' ? myTeamW : ((1 - myTeamW) as TeamW));
  const fromW = (w: TeamW): Team => (w === myTeamW ? 'player' : 'ai');
  // wire coordinates are the host's; team B's players see them mirrored
  const inX = (x: number) => (mirrored() ? COURT_W - x : x);
  const inY = (y: number) => (mirrored() ? COURT_L - y : y);
  const seatAth = (s: number): Athlete | null => (Number.isInteger(s) && s >= 0 && s < seats.length ? seats[s] : null);
  function netEmit(e: MatchEvent) {
    if (netRole === 'host' && netSend) netSend({ k: 'ev', e });
  }

  // ---------- juice / effects ----------
  let clock = 0;
  let shake = 0;
  let flash = 0;
  let fade = 0;
  let hitStop = 0;
  let rallyPop = 0;
  let particles: Particle[] = [];
  let confetti: Confetti[] = [];
  let floaters: Floater[] = [];
  const net = { wob: 0, x: 10 };

  function addShake(a: number) { shake = Math.max(shake, a); }

  function spawn(p: Partial<Particle> & { x: number; y: number; vx: number; vy: number }) {
    if (particles.length > 260 || (quality === 0 && Math.random() < 0.5)) return; // keep effects cheap
    particles.push({ t: 0, life: 0.5, size: 2, g: 24, z: 0, vz: 0, kind: 'spark', color: '#fff', ...p });
  }
  function sparks(x: number, y: number, z: number, n: number, colors: string[], power = 1) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(4, 14) * power;
      spawn({
        kind: 'spark', x, y, z,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(2, 10) * power,
        life: rand(0.25, 0.55), size: rand(1.5, 3), color: pick(colors),
      });
    }
  }
  function dust(x: number, y: number, n: number, strength = 1) {
    for (let i = 0; i < n; i++) {
      spawn({
        kind: 'dust', x: x + rand(-0.3, 0.3), y: y + rand(-0.3, 0.3), z: 0,
        vx: rand(-1.5, 1.5) * strength, vy: rand(-1.5, 1.5) * strength, vz: 0, g: 0,
        life: rand(0.35, 0.7), size: rand(2.5, 5) * (0.6 + strength * 0.5),
      });
    }
  }
  function floatText(x: number, y: number, text: string, color: string, size = 1) {
    floaters.push({ x, y, text, color, size, t: 0, life: 1.2 });
  }
  function confettiBurst(n: number) {
    if (quality === 0) n = Math.round(n * 0.4);
    const colors = ['#d7f23b', '#3aa0ff', '#ff5d5d', '#7cf2c4', '#ffb347', '#c8a6ff', '#ffffff'];
    for (let i = 0; i < n; i++) {
      confetti.push({
        x: rand(0, VIEW_W), y: rand(-VIEW_H * 0.5, -10),
        vx: rand(-40, 40), vy: rand(40, 160),
        rot: rand(0, Math.PI * 2), vr: rand(-8, 8),
        w: rand(5, 9), h: rand(8, 14), color: pick(colors),
        t: 0, life: rand(3, 5), wob: rand(0, 10),
      });
    }
  }

  // =====================================================================
  //  Referees — officials on stands at each end of the net.
  //  They make line calls, call faults and announce the score (with voice).
  // =====================================================================
  const refs: Ref[] = [
    { x: -5.3, y: NET_Y, face: 0, pitch: 0.9, pose: 'idle', poseT: 0, target: null, bubble: null, look: 0 },
    { x: COURT_W + 5.3, y: NET_Y, face: Math.PI, pitch: 1.15, pose: 'idle', poseT: 0, target: null, bubble: null, look: Math.PI },
  ];
  const headRef = refs[0];
  const nearRef = (x: number) => (x < COURT_W / 2 ? refs[0] : refs[1]);
  const CALL_COLORS = { in: '#1b8a3a', out: '#d62828', warn: '#c76a00', info: '#14213d' };

  function say(text: string, pitch = 1, interrupt = false) {
    if (!speech.ok || !speech.on || isMuted() || !text) return;
    speak(text, pitch, interrupt);
  }
  function hush() { hushSpeech(); }

  interface CallOpts { dur?: number; target?: { x: number; y: number }; color?: string; whistle?: boolean; speech?: string; interrupt?: boolean }
  // pose: idle | in | out | kitchen | fault | score | point
  function refCall(ref: Ref, pose: RefPose, text: string, o: CallOpts = {}) {
    const dur = o.dur || 1.7;
    ref.pose = pose;
    ref.poseT = dur;
    ref.target = o.target ? { x: o.target.x, y: o.target.y } : null;
    ref.bubble = { text, t: 0, life: dur + 0.2, color: o.color || CALL_COLORS.info };
    if (o.whistle) sfx.whistle();
    say(o.speech || text, ref.pitch, o.interrupt !== false);
    if (netRole === 'host') {
      netEmit({
        k: 'ref', r: ref === refs[0] ? 0 : 1, p: pose, x: text, c: o.color, d: o.dur, w: o.whistle, s: o.speech,
        i: o.interrupt, tg: o.target ? [r2(o.target.x), r2(o.target.y)] : undefined,
      });
    }
  }
  // Head referee announcement that tacks onto a call they just made, if any.
  function headAnnounce(text: string, target: { x: number; y: number }) {
    if (headRef.bubble && headRef.bubble.t < 0.05) {
      headRef.bubble.text += ' ' + text;
      say(text, headRef.pitch);
      netEmit({ k: 'refx', x: text });
    } else {
      refCall(headRef, 'point', text, { target, interrupt: false });
    }
  }

  function updateRefs(dt: number) {
    for (const r of refs) {
      if (r.poseT > 0) {
        r.poseT -= dt;
        if (r.poseT <= 0) { r.pose = 'idle'; r.target = null; }
      }
      if (r.bubble) {
        r.bubble.t += dt;
        if (r.bubble.t > r.bubble.life) r.bubble = null;
      }
      const want = Math.atan2(ball.y - r.y, ball.x - r.x); // eyes on the ball
      r.look = lerpAng(r.look, want, Math.min(1, dt * 8));
    }
  }

  function updateFx(dt: number) {
    updateRefs(dt);
    for (const p of particles) {
      p.t += dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vz -= p.g * dt;
      if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; }
      const drag = p.kind === 'dust' ? 3 : 1.5;
      p.vx *= 1 - drag * dt; p.vy *= 1 - drag * dt;
    }
    particles = particles.filter(p => p.t < p.life);

    for (const c of confetti) {
      c.t += dt;
      c.vy = Math.min(c.vy + 120 * dt, 180);
      c.x += (c.vx + Math.sin(clock * 3 + c.wob) * 30) * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
    }
    confetti = confetti.filter(c => c.t < c.life && c.y < VIEW_H + 20);

    for (const f of floaters) f.t += dt;
    floaters = floaters.filter(f => f.t < f.life);

    shake *= Math.exp(-dt * 9);
    if (shake < 0.1) shake = 0;
    flash = Math.max(0, flash - dt * 2.5);
    fade = Math.max(0, fade - dt * 2.2);
    net.wob = Math.max(0, net.wob - dt * 1.6);
    ball.squash = Math.max(0, ball.squash - dt * 7);
    rallyPop = Math.max(0, rallyPop - dt * 4);
    // touch controls ease back like the CSS transitions
    const k = 1 - Math.exp(-dt / 0.06);
    if (!joy.active) {
      joy.bx += (0 - joy.bx) * k; joy.by += (0 - joy.by) * k;
      joy.kx += (0 - joy.kx) * k; joy.ky += (0 - joy.ky) * k;
    }
  }

  // =====================================================================
  //  Input — touch controls (drawn on the court, like the browser's touch layout)
  // =====================================================================
  const joy = {
    active: false, id: -1, x: 0, y: 0, cx: 0, cy: 0, homeX: 0, homeY: 0, R: 60,
    bx: 0, by: 0, // base offset from its resting spot (px)
    kx: 0, ky: 0, // knob offset from the base centre (px)
  };
  interface Btn { kind: ShotType | 'hyper'; x: number; y: number; r: number; pressed: number }
  const buttons: Record<ShotType | 'hyper', Btn> = {
    lob: { kind: 'lob', x: 0, y: 0, r: 0, pressed: -1 },
    dink: { kind: 'dink', x: 0, y: 0, r: 0, pressed: -1 },
    drive: { kind: 'drive', x: 0, y: 0, r: 0, pressed: -1 },
    smash: { kind: 'smash', x: 0, y: 0, r: 0, pressed: -1 },
    hyper: { kind: 'hyper', x: 0, y: 0, r: 0, pressed: -1 },
  };
  const layout = { joySize: 120, zoneW: 0, zoneTop: 0, gap: 16 };

  // Sizes and spots from the browser's landscape touch CSS
  function layoutControls() {
    const vmin = Math.min(VIEW_W, VIEW_H) / 100;
    const vw = VIEW_W / 100;
    const joySize = clamp(27 * vmin, 100, 170);
    const btn = clamp(14 * vmin, 50, 84);
    const btnBig = clamp(21 * vmin, 72, 120);
    layout.joySize = joySize;
    // joystick zone: lower-left 42% x 72% of the screen
    layout.zoneW = VIEW_W * 0.42;
    layout.zoneTop = VIEW_H * 0.28;
    const zoneH = VIEW_H * 0.72;
    joy.R = joySize / 2;
    joy.homeX = Math.max(22, 5 * vw) + joy.R;
    joy.homeY = VIEW_H - Math.max(44, zoneH * 0.31) - joy.R;
    // shot pad: right 12px, bottom 10px, 2x2 grid with clear gaps between every button
    //   HYPER
    //   LOB    SMASH
    //   DINK   DRIVE (big, the main shot)
    const gap = clamp(4.5 * vmin, 16, 26); // space between buttons (scales with the screen)
    layout.gap = gap;
    const padRight = VIEW_W - 12;
    const padBottom = VIEW_H - 10;
    const col2X = padRight - btnBig / 2;
    buttons.drive.r = btnBig / 2;
    buttons.drive.x = col2X;
    buttons.drive.y = padBottom - btnBig / 2;
    buttons.smash.r = btn / 2;
    buttons.smash.x = col2X;
    buttons.smash.y = buttons.drive.y - btnBig / 2 - gap - btn / 2;
    const col1X = padRight - btnBig - gap - btn / 2;
    buttons.dink.r = btn / 2; buttons.dink.x = col1X; buttons.dink.y = padBottom - btn / 2;
    buttons.lob.r = btn / 2; buttons.lob.x = col1X; buttons.lob.y = buttons.dink.y - btn - gap;
    // HYPER sits above SMASH
    const pw = clamp(15 * vmin, 58, 80);
    buttons.hyper.r = pw / 2;
    buttons.hyper.x = col2X;
    buttons.hyper.y = buttons.smash.y - btn / 2 - gap - pw / 2;
  }

  const overlayUp = () => state === 'menu' || state === 'paused' || state === 'over' || ui.customizeOpen;
  const powerVisible = () => {
    const st = state === 'paused' ? pausedFrom : state;
    return st === 'serve' || st === 'rally' || st === 'point';
  };

  function joyMove(px: number, py: number) {
    let dx = px - joy.cx, dy = py - joy.cy;
    const R = joy.R;
    const d = Math.hypot(dx, dy);
    if (d > R * 1.3) { // thumb went well past the edge: bring the stick along
      const k = (d - R * 1.3) / d;
      joy.cx += dx * k; joy.cy += dy * k;
      dx = px - joy.cx; dy = py - joy.cy;
    }
    joy.bx = joy.cx - joy.homeX; joy.by = joy.cy - joy.homeY;
    const dd = Math.hypot(dx, dy);
    const full = R * 0.7;                     // full speed well inside the ring: short thumb travel
    const ux = dd ? dx / dd : 0, uy = dd ? dy / dd : 0;
    const amt = Math.min(1, dd / full);
    joy.x = ux * amt; joy.y = uy * amt;
    const kp = Math.min(dd, full) * 0.72;      // knob travel
    joy.kx = ux * kp; joy.ky = uy * kp;
  }
  function releaseJoystick() {
    joy.active = false; joy.id = -1; joy.x = 0; joy.y = 0;
  }

  function touchStart(id: number, x: number, y: number) {
    if (ui.loading || overlayUp()) return;
    ensureAudio();
    // Buttons: the one whose edge is nearest the finger wins. Each accepts a little
    // outside its edge, but never more than half the gap, so neighbours can't overlap.
    const slop = Math.min(10, layout.gap / 2 - 1);
    let best: (ShotType | 'hyper') | null = null, bestEdge = Infinity;
    for (const k of ['lob', 'dink', 'drive', 'smash', 'hyper'] as const) {
      if (k === 'hyper' && !powerVisible()) continue;
      const b = buttons[k];
      const edge = Math.hypot(x - b.x, y - b.y) - b.r; // < 0 inside the button
      if (edge <= slop && edge < bestEdge) { best = k; bestEdge = edge; }
    }
    if (best === 'hyper') {
      buttons.hyper.pressed = id;
      pressHyper();
      return;
    }
    if (best) {
      buttons[best].pressed = id;
      buzz(8);
      action(best);
      return;
    }
    // joystick zone (lower-left)
    if (!joy.active && x <= layout.zoneW && y >= layout.zoneTop) {
      joy.active = true;
      joy.id = id;
      joy.cx = clamp(x, joy.R * 0.6, layout.zoneW - joy.R * 0.6);
      joy.cy = clamp(y, layout.zoneTop + joy.R * 0.6, VIEW_H - joy.R * 0.6);
      joyMove(x, y);
    }
  }
  function touchMove(id: number, x: number, y: number) {
    if (joy.active && id === joy.id) joyMove(x, y);
  }
  function touchEnd(id: number) {
    if (joy.active && id === joy.id) releaseJoystick();
    for (const b of Object.values(buttons)) if (b.pressed === id) b.pressed = -1;
  }
  function releaseAllTouches() {
    releaseJoystick();
    for (const b of Object.values(buttons)) b.pressed = -1;
  }

  function autoPause() {
    releaseAllTouches();
    if (netRole !== 'off') return; // an online match can't be paused; the other player waits instead
    if (state === 'serve' || state === 'rally' || state === 'point') togglePause();
  }

  // Combined movement input (-1..1 on each axis)
  function moveInput() {
    if (joy.active) {
      const m = Math.hypot(joy.x, joy.y);
      if (m < 0.06) return { dx: 0, dy: 0 };                // tiny dead zone
      const k = Math.min(1, (m - 0.06) / 0.74);               // full speed from ~80% push
      const sp = 0.25 + 0.75 * (1 - (1 - k) * (1 - k));       // moves at once, ramps up fast
      return { dx: (joy.x / m) * sp, dy: (joy.y / m) * sp };
    }
    return { dx: 0, dy: 0 };
  }
  function aimDir() {
    if (joy.active) return joy.x > 0.35 ? 1 : joy.x < -0.35 ? -1 : 0;
    return 0;
  }

  function action(type: ShotType) {
    ensureAudio();
    if (netRole === 'guest') { // the host plays the shot; show the waiting swing here at once
      if (state === 'serve' && serverAth === player) netSend?.({ k: 'shot', ty: type, a: wireAim(aimDir()) });
      else if (state === 'rally') {
        queueSwing(player, type);
        netSend?.({ k: 'shot', ty: type, a: wireAim(aimDir()) });
      }
      return;
    }
    actionFor(player, type);
  }

  // A shot tap for a human athlete (you, or the guest's athlete on the host).
  function actionFor(p: Athlete, type: ShotType) {
    if (state === 'serve' && serverAth === p) {
      humanServe(p);
    } else if (state === 'rally') {
      queueSwing(p, type);
    }
  }

  function queueSwing(p: Athlete, type: ShotType) {
    p.swingType = type;
    const incoming = lastHitter !== p.team && !ball.netted && !ball.held;
    if (incoming) {
      // Queue the shot: the player gets set and swings when the ball reaches the paddle
      // (no need to time the tap to a fraction of a second, and never too early to be legal).
      p.swing = SHOT_BUFFER;
      p.queued = true;
    } else {
      p.swing = SWING_WINDOW; // nothing to hit: a quick practice swing
      p.queued = false;
      if (!p.stroke || p.strokeT > 0.7) startStroke(p, strokeKindFor(p, type), 0);
    }
  }

  // Your stick left/right on the host's court (flipped for team B, who see it mirrored).
  const wireAim = (a: number): -1 | 0 | 1 => {
    const s = a > 0 ? 1 : a < 0 ? -1 : 0;
    return (mirrored() ? -s : s) as -1 | 0 | 1;
  };
  // Aim of a human athlete in this game's frame.
  const aimOf = (p: Athlete) => (p === player ? aimDir() : p.net?.aim ?? 0);

  // Where (sideways) the player should stand so the incoming ball meets the paddle,
  // or null if it can't be worked out yet.
  function contactSpotX(p: Athlete = player): number | null {
    if (ball.held || ball.netted || Math.abs(ball.vy) < 1) return null;
    const lineY = p.y + (p.team === 'player' ? -0.8 : 0.8); // just in front of the body
    const t = (lineY - ball.y) / ball.vy;
    if (t < 0 || t > 1.3) return null;
    const bx = ball.x + ball.vx * t;
    return bx - domSign(p) * CONTACT_IDEAL * 0.8; // ball on the paddle side
  }

  // =====================================================================
  //  Shots & physics
  // =====================================================================

  // Give the ball a velocity so it lands at (tx, ty) after ~T seconds,
  // lengthening the flight (higher arc) until it clears the net.
  // g = downward pull on this shot: heavy topspin (Hyper drives and smashes) dips harder than gravity alone.
  function launch(tx: number, ty: number, T: number, minClear = 0.35, g = G) {
    const x0 = ball.x, y0 = ball.y, z0 = Math.max(ball.z, 0.3);
    let vx = 0, vy = 0, vz = 0;
    ball.g = g;
    for (let i = 0; i < 80; i++) {
      vx = (tx - x0) / T;
      vy = (ty - y0) / T;
      vz = (0.5 * g * T * T - z0) / T;
      if (Math.abs(vy) < 1e-3) break;
      const tn = (NET_Y - y0) / vy;
      if (tn <= 0 || tn >= T) break;
      const zn = z0 + vz * tn - 0.5 * g * tn * tn;
      if (zn >= NET_H + minClear) break;
      T += 0.04;
    }
    ball.z = z0;
    ball.vx = vx; ball.vy = vy; ball.vz = vz;
    ball.held = false;
  }

  function predictLanding() {
    const g = ball.g || G;
    const disc = ball.vz * ball.vz + 2 * g * ball.z;
    const t = (ball.vz + Math.sqrt(Math.max(0, disc))) / g;
    return { x: ball.x + ball.vx * t, y: ball.y + ball.vy * t };
  }

  // Shared shot maker. tx = intended x, err = accuracy spread (feet).
  //   drive: hard and low (the main shot)   dink: soft, into the kitchen
  //   lob:   high and deep                  smash: hardest hit; best on high balls, risky on low ones
  // While the player is in Hyper mode every shot is faster, more accurate and lands
  // in tougher spots, and opponents struggle to return it.
  function doHit(hitter: Athlete, type: ShotType, tx: number, err: number, netty = false) {
    hitter.cpt = { x: ball.x, y: ball.y, z: ball.z }; // the ball is at the paddle now
    const hyper = hitter.en.hyperT > 0; // people, and CPU players on Medium / Hard
    const strokeKind = strokeKindFor(hitter, type); // decided from the ball as it arrives
    const toTop = hitter.team === 'player';
    const deep = (d: number) => (toTop ? d : COURT_L - d);          // d feet from target baseline
    const nearNet = (d: number) => (toTop ? NET_Y - d : NET_Y + d); // d feet from net
    const smash = type === 'smash' || (type === 'drive' && ball.z > 4.8);
    const lowSmash = type === 'smash' && ball.z < 3; // hitting down on a low ball is hard to control
    let ty: number, T: number;

    if (type === 'dink') ty = nearNet(hyper ? rand(1.8, 3.2) : rand(2.5, 5));
    else if (type === 'lob') ty = deep(hyper ? rand(1.2, 3) : rand(2, 4.5));
    else if (smash) ty = deep(hyper ? rand(2.5, 6) : rand(5, 10));
    else ty = deep(hyper ? rand(2, 4.5) : rand(3, 6));

    // Paddle feel: power adds pace, control tightens accuracy
    const pd = paddleById(hitter.paddle);
    const powerF = 1 + (pd.power - 6) * 0.03;
    const controlF = 1 - (pd.control - 6) * 0.05;
    err *= controlF;
    if (lowSmash) err *= 1.7;
    if (hyper) err *= 0.45;

    tx += randn() * err * 0.6;
    ty += randn() * err * (type === 'dink' ? 0.4 : 0.7);
    const dist = Math.hypot(tx - ball.x, ty - ball.y);

    const boost = hyper ? 1.25 : 1; // Hyper: everything is faster
    if (type === 'dink') T = hyper ? 0.6 + dist / 34 : 0.7 + dist / 30;
    else if (type === 'lob') T = hyper ? 1.45 + dist / 76 : 1.6 + dist / 70;
    else if (smash) T = dist / ((lowSmash ? 52 : 58) * powerF * boost);
    else T = dist / (rand(38, 44) * powerF * boost);

    const hitX = ball.x, hitY = ball.y, hitZ = ball.z;
    if (netty) {
      // A mishit aimed to meet the net below the tape, whatever the contact height
      const dy = NET_Y - ball.y;
      const vy = Math.sign(dy) * rand(28, 38);
      const t = Math.abs(dy) / Math.abs(vy);
      const zAtNet = NET_H * rand(0.35, 0.85);
      ball.z = Math.max(ball.z, 0.4);
      ball.vx = (tx - ball.x) / Math.max(t * 2, 0.4);
      ball.vy = vy;
      ball.g = G;
      ball.vz = (zAtNet - ball.z + 0.5 * G * t * t) / t;
      ball.held = false;
    } else {
      // Hyper drives and smashes carry heavy topspin: they dip hard after the net
      const heavy = hyper && (type === 'drive' || type === 'smash');
      launch(tx, ty, T, heavy ? 0.2 : 0.35, heavy ? G * 1.8 : G);
    }
    ball.power = hyper; // Hyper shots are harder to read and return

    lastHitter = hitter.team;
    shots++;
    bounces = 0;
    longestRally = Math.max(longestRally, shots);
    landing = predictLanding();
    rallyPop = 1;
    // Bots were already in their backswing, so join the stroke near contact.
    // If you started swinging early, let your swing carry on.
    if (!(hitter.stroke && hitter.strokeT < 0.6)) startStroke(hitter, strokeKind, 0.35);
    splitStep(other(hitter.team));

    if (!hyper) addEnergy(hitter, ENERGY_PER_HIT); // CPU players only charge on Medium / Hard
    netEmit({ k: 'hit', s: hitter.seat, t: toW(hitter.team), ty: type, sk: strokeKind, sm: smash, hy: hyper,
      p: [r2(hitX), r2(hitY), r2(hitZ)], b: packBall(ball), n: shots });
    hitFx(hitter, type, smash, hyper, hitX, hitY, hitZ);
    assignInterceptors();
  }

  // Sound, sparks and text for a hit (also played by the guest for the host's hits).
  function hitFx(hitter: Athlete, type: ShotType, smash: boolean, hyper: boolean, hitX: number, hitY: number, hitZ: number) {
    const mine = hitter === player;
    if (smash) {
      sfx.smash();
      addShake(hyper ? 13 : 8);
      hitStop = hyper ? 0.12 : 0.07;
      flash = hyper ? 0.5 : 0.3;
      sparks(hitX, hitY, hitZ, 28, ['#ffb347', '#ffd166', '#ffffff', '#ff7b3a'], 1.4);
      floatText(hitter.x, hitter.y, hyper ? 'HYPER SMASH!' : 'SMASH!', hyper ? HYPER_COLOR : '#ffb347', hyper ? 1.5 : 1.2);
      if (mine) buzz(hyper ? [40, 30, 70] : 40);
    } else if (type === 'dink') {
      sfx.soft();
      sparks(hitX, hitY, hitZ, 5, ['#ffffff', '#9ef0b6'], 0.4);
      if (hyper) floatText(hitter.x, hitter.y, 'HYPER DINK!', HYPER_COLOR, 1.1);
      if (mine) buzz(10);
    } else {
      sfx.hit();
      sparks(hitX, hitY, hitZ, 10, ['#ffffff', '#e8f53b'], 0.7);
      if (hyper) floatText(hitter.x, hitter.y, type === 'lob' ? 'HYPER LOB!' : 'HYPER DRIVE!', HYPER_COLOR, 1.2);
      else if (type === 'lob') floatText(hitter.x, hitter.y, 'LOB', '#c8a6ff', 0.8);
      if (mine) buzz(15);
    }
    if (hyper) { // electric burst on every Hyper shot
      sfx.power();
      addShake(6);
      sparks(hitX, hitY, hitZ, 30, HYPER_SPARKS, 1.8);
    }
    if (shots === 10) floatText(10, NET_Y, 'EPIC RALLY!', '#d7f23b', 1.3);
  }

  // A human athlete's shot (aim comes from the stick, or the guest's reported stick).
  function humanHit(p: Athlete, type: ShotType) {
    const aim = aimOf(p);
    let tx: number;
    if (aim !== 0) tx = type === 'dink' ? 10 + aim * 6 : (aim > 0 ? COURT_W - 2 : 2);
    else tx = clamp(p.x, 3, COURT_W - 3);
    const dx = ball.x - p.x, dy = ball.y - p.y;
    const d = Math.hypot(dx, dy);
    // Cleanest at a natural arm's-length contact beside the body; sloppier at full
    // stretch, a little sloppier when the ball is jammed into the body or very low/high.
    const offIdeal = Math.max(0, Math.abs(d - CONTACT_IDEAL) - 0.6);
    const reachUsed = clamp(offIdeal / (REACH - CONTACT_IDEAL - 0.6), 0, 1);
    const awkwardZ = clamp((0.9 - ball.z) / 0.9, 0, 1) * 0.25 + clamp((ball.z - 6.2) / 1.3, 0, 1) * 0.2;
    const err = 0.5 + 0.85 * reachUsed + awkwardZ;
    // Step and reach toward the ball so the paddle meets it (like a real player lunging)
    const excess = d - CONTACT_IDEAL;
    if (excess > 0.05 && d > 0 && p === player) {
      const LUNGE_T = 0.12;
      p.lungeT = LUNGE_T;
      p.lungeVX = ((dx / d) * excess * 0.85) / LUNGE_T;
      p.lungeVY = ((dy / d) * excess * 0.85) / LUNGE_T;
    }
    doHit(p, type, tx, err);
    // swing timed so the paddle is at the ball now (contact is ~45% through the stroke)
    startStroke(p, strokeKindFor(p, type), 0.4);
  }

  function humanServe(p: Athlete) {
    if (!serveBox || serveWind) return;
    const box = serveBox;
    const aim = aimOf(p); // aimed when tapped
    startServeWind(p, () => {
      const cx = (box.x0 + box.x1) / 2;
      const tx = cx + aim * 3.2 + randn() * 0.8;
      const depth = rand(2.5, 6) + randn() * 0.8;
      const ty = p.team === 'player' ? depth : COURT_L - depth;
      launch(tx, ty, rand(1.05, 1.2));
      beginRallyFromServe(p);
      if (p === player) buzz(15);
    });
  }

  function botServe(b: Athlete) {
    if (serveWind) return;
    const box = serveBox as Box;
    startServeWind(b, () => {
      const e = b.skill.error * 0.35;
      const tx = rand(box.x0 + 1.5, box.x1 - 1.5) + randn() * e;
      const depth = rand(2.5, 6) + randn() * e;
      const ty = b.team === 'ai' ? COURT_L - depth : depth;
      launch(tx, ty, rand(1.05, 1.25));
      beginRallyFromServe(b);
    });
  }

  function beginRallyFromServe(who: Athlete) {
    state = 'rally';
    lastHitter = who.team;
    shots = 1;
    bounces = 0;
    netEmit({ k: 'serve', s: who.seat, t: toW(who.team), b: packBall(ball) });
    serveFx(who);
    assignInterceptors();
    syncState();
  }

  function serveFx(who: Athlete) {
    // the wind-up already brought the paddle to the ball: just carry on into the follow-through
    if (who.stroke === 'serve' && who.strokeT > 0.3) who.strokeRate = STROKE_RATE.serve;
    else startStroke(who, 'serve', SERVE_CONTACT_T);
    splitStep(other(who.team));
    landing = predictLanding();
    sfx.hit();
    sparks(ball.x, ball.y, ball.z, 8, ['#ffffff', '#e8f53b'], 0.6);
    hideBanner();
  }

  // Line calls and points shown as floating text (sent to the guest as well).
  function callText(x: number, y: number, text: string, color: string, size = 1) {
    floatText(x, y, text, color, size);
    netEmit({ k: 'float', x: r2(x), y: r2(y), tx: text, c: color, s: size });
  }

  function stepBall(dt: number) {
    if (ball.held) return;
    const prevY = ball.y, prevZ = ball.z;
    ball.vz -= (ball.g || G) * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;
    ball.spin += Math.hypot(ball.vx, ball.vy) * dt * 0.9;

    // Net collision
    if (!ball.netted && (prevY - NET_Y) * (ball.y - NET_Y) < 0 && ball.x > -1 && ball.x < COURT_W + 1) {
      const f = (NET_Y - prevY) / (ball.y - prevY);
      const zc = prevZ + (ball.z - prevZ) * f;
      if (zc < netTopAt(ball.x)) {
        ball.netted = true;
        ball.y = NET_Y + (prevY < NET_Y ? -0.3 : 0.3);
        ball.vy *= -0.15;
        ball.vx *= 0.3;
        ball.vz = Math.min(ball.vz, 0) * 0.3;
        landing = null;
        sfx.net();
        net.wob = 1;
        net.x = ball.x;
        addShake(4);
        floatText(ball.x, NET_Y, 'NET', '#ff7b7b');
        if (state === 'rally' && !isGuest()) { // the host decides points; the guest only shows the ball
          refCall(nearRef(ball.x), 'fault', 'Net!', { target: ball, color: CALL_COLORS.warn });
          endRally(other(lastHitter as Team), 'Into the net');
        }
      }
    }

    // Ground
    if (ball.z <= 0) {
      ball.z = 0;
      if (ball.vz < -1.5) {
        const impact = Math.min(1, -ball.vz / 15);
        ball.vz = -ball.vz * BOUNCE_Z;
        ball.vx *= BOUNCE_XY;
        ball.vy *= BOUNCE_XY;
        ball.squash = impact;
        sfx.bounce(impact);
        dust(ball.x, ball.y, 2 + Math.round(impact * 5), impact);
        onBounce();
      } else {
        ball.vz = 0;
        ball.vx *= 0.97;
        ball.vy *= 0.97;
      }
    }
  }

  function inCourt(x: number, y: number) {
    return x >= 0 && x <= COURT_W && y >= 0 && y <= COURT_L;
  }
  function inBox(b: Box, x: number, y: number) {
    return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  }

  function onBounce() {
    landing = null;
    if (state !== 'rally' || isGuest()) return;

    bounces++;
    const receiver = other(lastHitter as Team);
    const side = sideOf(ball.y);
    const ref = nearRef(ball.x);
    const spot = { x: ball.x, y: ball.y };
    const CLOSE = 1.5; // feet from a line that counts as a "close call"

    if (bounces === 1) {
      if (side !== receiver) {
        endRally(receiver, "Didn't clear the net");
      } else if (shots === 1) {
        const b = serveBox as Box;
        if (!inBox(b, ball.x, ball.y)) {
          const kitchenLand = ball.y > TOP_KITCHEN && ball.y < BOT_KITCHEN && ball.x >= 0 && ball.x <= COURT_W;
          callText(ball.x, ball.y, 'FAULT', '#ff7b7b');
          if (kitchenLand) {
            refCall(ref, 'kitchen', 'Fault — in the kitchen!', { target: spot, color: CALL_COLORS.warn, speech: 'Fault! Kitchen.', whistle: true });
          } else {
            refCall(ref, 'out', pick(["Fault — it's out!", 'Fault — outside!']), { target: spot, color: CALL_COLORS.out, whistle: true });
          }
          endRally(receiver, kitchenLand ? 'Serve in the kitchen' : 'Serve out');
        } else if (Math.min(ball.x - b.x0, b.x1 - ball.x, ball.y - b.y0, b.y1 - ball.y) < CLOSE) {
          refCall(ref, 'in', 'Inside!', { target: spot, color: CALL_COLORS.in });
        }
      } else if (!inCourt(ball.x, ball.y)) {
        callText(ball.x, ball.y, 'OUT', '#ff7b7b');
        refCall(ref, 'out', pick(['Out!', "It's out!", 'Outside!']), { target: spot, color: CALL_COLORS.out });
        endRally(receiver, 'Out!');
      } else {
        const baseline = receiver === 'ai' ? ball.y : COURT_L - ball.y;
        if (Math.min(ball.x, COURT_W - ball.x, baseline) < CLOSE) {
          refCall(ref, 'in', pick(['Inside!', 'Inside!', 'In!']), { target: spot, color: CALL_COLORS.in });
        }
      }
    } else {
      endRally(lastHitter as Team, missedText(receiver), receiver);
    }
  }
  const missedText = (by: Team) => (by === 'player' ? 'Missed it' : `${teamShort('ai')} missed it`);

  // (The player never faults by tapping early: a waiting shot holds until it is legal.)

  function endRally(winner: Team, reason: string, missedBy: Team | null = null) {
    if (state !== 'rally') return;
    state = 'point';
    stateTimer = 1.7;
    interceptor.player = interceptor.ai = null;

    const wc = teamCenter(winner);

    // Unreturned serve = ace
    const ace = shots === 1 && winner === lastHitter && bounces >= 2;
    if (ace) {
      reason = 'Ace!';
      callText(serverAth.x, serverAth.y, 'ACE!', '#d7f23b', 1.3);
      refCall(headRef, 'point', 'Ace!', { target: serverAth, color: CALL_COLORS.in, interrupt: false });
    }

    const doubles = mode === 'doubles';
    let msg: string;
    if (winner === server) {
      score[server]++;
      msg = `Point — ${teamLabel(winner)}`;
      // Doubles: the server and partner switch sides after winning a point
      if (doubles) {
        const p = partnerOf(serverAth);
        [serverAth.court, p.court] = [p.court, serverAth.court];
      }
    } else if (doubles && serverNum === 1) {
      serverNum = 2;
      serverAth = partnerOf(serverAth);
      msg = `Second server — ${serverAth.name}`;
      headAnnounce('Second server!', serverAth);
    } else {
      server = winner;
      serverNum = 1;
      // First server after a side out is whoever is in the right-hand court
      serverAth = teamOf(winner).find(a => a.court === 'R') || teamOf(winner)[0];
      msg = `Side out — ${serverAth.name} serves`;
      headAnnounce('Side out!', wc);
    }

    if (winner === 'player') pointsWon++;
    // runs of points: "ON FIRE!" after three in a row
    if (streak.team === winner) streak.n++; else { streak.team = winner; streak.n = 1; }
    if (streak.n === 3 || streak.n === 6) {
      const c = teamCenter(winner);
      callText(c.x, c.y, streak.n >= 6 ? 'UNSTOPPABLE!' : 'ON FIRE!', '#ff7b3a', 1.3);
    }
    for (const a of teamOf(winner)) if (!a.human) addEnergy(a, ENERGY_PER_POINT);
    for (const a of teamOf(winner)) if (a.human) addEnergy(a, ENERGY_PER_POINT);

    const lead = score[server] - score[other(server)];
    if (score[server] >= WIN_SCORE && lead >= 2) {
      gameWinner = server;
      stateTimer = 2.0;
    }

    if (netRole === 'host') {
      rallyLog.push({ w: winner === 'player' ? 'h' : 'g', t: Math.round(netClock) });
      netEmit({
        k: 'point', w: toW(winner), r: reason, mb: missedBy ? toW(missedBy) : -1, m: msg,
        i: rallyLog.length - 1, ts: Math.round(netClock), ace, gw: gameWinner ? toW(gameWinner) : -1,
      });
      rallyListeners.forEach(fn => { try { fn(); } catch { /* never breaks the game */ } });
    }
    pointFx(winner, reason, msg);
    syncState();
  }

  // Celebration, sounds and the banner for a finished rally.
  function pointFx(winner: Team, reason: string, msg: string) {
    for (const a of teamOf(winner)) {
      a.jump = 1;
      a.cheer = 1.3; // both arms up
      sparks(a.x, a.y, 2.5, 10, winner === 'player' ? ['#3aa0ff', '#9fd2ff', '#ffffff'] : ['#ff5d5d', '#ffb0b0', '#ffffff'], 0.8);
    }
    if (winner === 'player') { sfx.good(); buzz(25); } else { sfx.bad(); buzz([20, 60, 20]); }
    showBanner(reason, msg, winner === 'player' ? 'good' : 'bad');
    if (gameWinner === 'player') confettiBurst(80);
  }

  // =====================================================================
  //  Serve setup
  // =====================================================================
  function setupServe() {
    state = 'serve';
    serveWind = null;
    shots = 0;
    bounces = 0;
    lastHitter = null;
    landing = null;
    trail = [];
    fade = 0.6;
    ball.netted = false;
    ball.power = false;
    ball.g = G;
    ball.held = true;
    ball.vx = ball.vy = ball.vz = 0;
    for (const a of roster) {
      if (!a.human) continue;
      a.swing = 0;
      a.queued = false;
      a.lungeT = 0;
      a.mvx = a.mvy = 0;
    }
    interceptor.player = interceptor.ai = null;
    setupGen++;
    netEmit({ k: 'setup' });

    // Singles: serve from the right when the server's score is even.
    // Doubles: players stay in their courts (they switch after winning a point).
    if (mode === 'singles') {
      const c = score[server] % 2 === 0 ? 'R' : 'L';
      for (const a of roster) a.court = c;
    }

    const receiving = other(server);
    serveHalf = courtHalf(server, serverAth.court);
    const target = courtHalf(receiving, serverAth.court); // diagonal = same court letter
    serveBox = receiving === 'ai'
      ? { x0: target[0], x1: target[1], y0: 0, y1: TOP_KITCHEN }
      : { x0: target[0], x1: target[1], y0: BOT_KITCHEN, y1: COURT_L };

    for (const a of roster) {
      const h = courtHalf(a.team, a.court);
      a.x = (h[0] + h[1]) / 2;
      a.vx = a.vy = 0;
      a.plan = null;
      if (a.team === server || a.court === serverAth.court) a.y = behindBaseline(a.team); // server, partner, receiver
      else a.y = ownY(a.team, KITCHEN + 1); // receiver's partner waits at the kitchen line
    }
    if (!serverAth.human) stateTimer = 1.2;

    hideBanner();
    announceScore();
    syncState();
  }

  // Head referee calls the score before every serve: server's score first
  // (plus the server number in doubles).
  let freshGame = false;
  function announceScore() {
    const a = score[server], b = score[other(server)];
    const word = (n: number) => (n === 0 ? 'zero' : String(n));
    let text = `${a} – ${b}`;
    let spoken = `${word(a)}, ${word(b)}`;
    if (mode === 'doubles') {
      text += ` – ${serverNum}`;
      spoken += `, ${serverNum}`;
    }
    if (freshGame) {
      text += ' · Play!';
      spoken += '. Play!';
      freshGame = false;
    } else if (a >= WIN_SCORE - 1 && a > b) {
      text += ' · Game point';
      spoken += '. Game point!';
    }
    refCall(headRef, 'score', text, { target: serverAth, speech: spoken, interrupt: false, dur: 1.6 });
  }

  // =====================================================================
  //  Update — you
  // =====================================================================
  function animatePerson(p: Athlete, ox: number, oy: number, dt: number) {
    let vx = (p.x - ox) / dt, vy = (p.y - oy) / dt;
    if (Math.hypot(vx, vy) > 40) { vx = 0; vy = 0; } // teleport, not a sprint
    p.vx += (vx - p.vx) * Math.min(1, dt * 18);
    p.vy += (vy - p.vy) * Math.min(1, dt * 18);
    const sp = Math.hypot(p.vx, p.vy);
    p.phase += sp * dt * 1.1;

    // ----- gait: timed by distance, so feet don't skate -----
    const sm = (cur: number, tgt: number, rate: number) => cur + (tgt - cur) * (1 - Math.exp(-dt * rate));
    p.loco = sm(p.loco || 0, clamp(sp / 10, 0, 1), 9);
    p.runFrac = sm(p.runFrac || 0, clamp((sp - 6) / 6, 0, 1), 6);
    if (sp > 0.6) {
      p.latFrac = sm(p.latFrac || 0, Math.abs(p.vx) / (Math.abs(p.vx) + Math.abs(p.vy)), 7);
      const fwd = p.team === 'player' ? -p.vy : p.vy; // toward the net for this player
      p.dirX = sm(p.dirX || 0, p.vx / sp, 10);
      p.dirW = sm(p.dirW || 0, fwd / sp, 10);
    }
    const stride = lerp(2.0, 3.6, p.runFrac); // feet per step
    // shuffles use quicker, shorter steps
    const lat = (p.latFrac || 0) * (state === 'rally' ? 1 : 0);
    p.gait = (p.gait || 0) + ((sp * dt) / lerp(stride, 1.6, lat)) * Math.PI;
    // settle the feet back to a neutral stance when stopping
    if (sp < 0.6 && p.loco < 0.05) {
      const rest = Math.round(p.gait / Math.PI) * Math.PI;
      p.gait = sm(p.gait, rest, 6);
    }
    p.jump = Math.max(0, p.jump - dt * 2.2);
    p.split = Math.max(0, p.split - dt * 3.6);
    p.cheer = Math.max(0, p.cheer - dt);
    if (p.stroke) {
      p.strokeT += dt * p.strokeRate;
      if (p.strokeT >= 1) { p.stroke = null; p.strokeT = 0; p.tip = []; }
    }
    // Start the backswing early as the ball comes toward this player
    let prepTarget = 0;
    if (state === 'rally' && lastHitter && lastHitter !== p.team && !ball.netted && !p.stroke) {
      const d = Math.hypot(ball.x - p.x, ball.y - p.y);
      // by time to arrival, so a fast ball still gets a full, smooth backswing
      const tta = Math.abs(ball.vy) > 1 ? Math.max(0, (Math.abs(ball.y - p.y) - 1) / Math.abs(ball.vy)) : 9;
      prepTarget = Math.max(clamp(1 - (tta - 0.15) / 0.5, 0, 1), clamp(1 - (d - 2.5) / 7, 0, 1));
      const side = sideFor(p);
      if (ball.z > 5 && d < 10 && shots >= 2) p.prepKind = 'smash';
      else if (ball.z < 2 && Math.abs(p.y - NET_Y) < 10) p.prepKind = 'dink_' + side;
      else if (bounces === 0 && shots >= 3 && ball.z > 2.6) p.prepKind = 'volley_' + side;
      else p.prepKind = 'drive_' + side;
    }
    p.prep += (prepTarget - p.prep) * Math.min(1, dt * 9);
    updatePoseSmoothing(p, dt);
    if (sp > 7) {
      p.dustT -= dt;
      if (p.dustT <= 0) {
        p.dustT = 0.1;
        dust(p.x - p.vx * 0.04, p.y - p.vy * 0.04 + 0.3, 1, 0.5);
      }
    }
  }

  // ---------- the serve: a real underhand drop serve ----------
  // Body coordinates [u, z, w]: u toward the paddle hand, z up, w toward the net (feet).
  // Waiting: the free hand holds the ball out in front, beside the body (so it is
  // visible from behind). On the tap the paddle swings back while the free hand
  // carries the ball in front of the paddle-side hip and lets go; the ball drops and
  // the paddle meets it below the waist, then follows through up toward the target.
  const SERVE_HOLD = [-0.74, 3.2, 0.7];
  const SERVE_RELEASE = [0.64, 3.35, 0.75];
  const SERVE_CONTACT_Z = 2.2;                 // where the paddle face is at contact (see STROKES.serve)
  const SERVE_CARRY = 0.16;                    // s to bring the ball across
  const SERVE_FALL = Math.sqrt((2 * (SERVE_RELEASE[1] - SERVE_CONTACT_Z)) / G);
  const SERVE_WIND = SERVE_CARRY + SERVE_FALL; // tap -> contact
  const SERVE_CONTACT_T = 0.45;                // contact point within the serve stroke
  let serveWind: { who: Athlete; t: number; go: (() => void) | null } | null = null;

  /** Where the server's ball is (body coordinates), t seconds into the wind-up (-1: waiting). */
  function serveBallBody(t: number): number[] {
    if (t < 0) return [SERVE_HOLD[0], SERVE_HOLD[1] + Math.abs(Math.sin(clock * 2.2)) * 0.1, SERVE_HOLD[2]];
    if (t < SERVE_CARRY) {
      const k = ease(t / SERVE_CARRY);
      return [lerp(SERVE_HOLD[0], SERVE_RELEASE[0], k), lerp(SERVE_HOLD[1], SERVE_RELEASE[1], k) + Math.sin(Math.PI * k) * 0.12, lerp(SERVE_HOLD[2], SERVE_RELEASE[2], k)];
    }
    const f = Math.min(t, SERVE_WIND) - SERVE_CARRY;
    return [SERVE_RELEASE[0], SERVE_RELEASE[1] - 0.5 * G * f * f, SERVE_RELEASE[2]];
  }

  // Server holds the ball (or drops it, during the wind-up)
  function holdBallFor(a: Athlete) {
    const towardNet = a.team === 'ai' ? 1 : -1;
    const [u, z, w] = serveBallBody(serveWind && serveWind.who === a ? serveWind.t : -1);
    ball.x = a.x + domSign(a) * u;
    ball.y = a.y + towardNet * w;
    ball.z = z;
  }

  /** Start the serve motion; `go` launches the ball at contact (null on a guest: the host decides). */
  function startServeWind(p: Athlete, go: (() => void) | null) {
    if (serveWind) return;
    serveWind = { who: p, t: 0, go };
    startStroke(p, 'serve', 0);
    p.strokeRate = SERVE_CONTACT_T / SERVE_WIND; // the paddle reaches the ball as it drops into place
    if (go) netEmit({ k: 'wind', s: p.seat });
  }
  function tickServeWind(dt: number) {
    if (!serveWind) return;
    if (state !== 'serve') { serveWind = null; return; }
    serveWind.t += dt;
    const w = serveWind;
    holdBallFor(w.who);
    if (w.t >= SERVE_WIND) {
      if (w.go) { serveWind = null; w.go(); }
      else if (w.t > SERVE_WIND + 1) serveWind = null; // guest: the host's serve never came
    }
  }

  // ---------- strokes, handedness and footwork cues ----------
  // Your team faces away from the camera and the bots face it, so a right
  // hand is on the screen's right for your team and the screen's left for bots.
  function domSign(p: Athlete) { return (p.team === 'player' ? 1 : -1) * (p.lefty ? -1 : 1); }
  function sideFor(p: Athlete) { return domSign(p) * (ball.x - p.x) >= -0.3 ? 'fh' : 'bh'; }
  function strokeKindFor(p: Athlete, type: ShotType) {
    // an overhead only for a ball that is actually high; a "smash" at a low ball is a hard drive swing
    const near = Math.hypot(ball.x - p.x, ball.y - p.y) < REACH + 1;
    if ((type === 'smash' && (ball.z > 3.8 || !near)) || (type === 'drive' && ball.z > 4.8)) return 'smash';
    const side = sideFor(p);
    if (type === 'dink') return 'dink_' + side;
    if (type === 'lob') return 'lob_' + side;
    if (bounces === 0 && shots >= 3 && ball.z > 2.6) return 'volley_' + side;
    return 'drive_' + side;
  }
  const STROKE_RATE: Record<string, number> = { drive: 3.0, volley: 4.2, dink: 2.4, lob: 2.6, smash: 3.4, serve: 2.3 };
  function startStroke(p: Athlete, kind: string, fromT: number) {
    if (fromT === 0) p.cpt = null; // a swing from the start (serve, practice): no ball to reach yet
    p.stroke = kind;
    p.strokeT = fromT;
    p.strokeRate = STROKE_RATE[kind.split('_')[0]] || 3;
    p.tip = [];
    p.prep = 0;
    // a swing that starts at contact (a hit): the paddle is already on its way to the ball
    if (fromT >= 0.3 && p.vis) blendPose(p.vis, p.vis, poseFor(p), 0.6);
  }
  // Players hop into a balanced split step as the other side strikes the ball
  function splitStep(team: Team) {
    for (const a of teamOf(team)) if (!a.stroke) a.split = 1;
  }

  // =====================================================================
  //  Hyper — the special skill. An energy bar charges during play; at 100%
  //  tap HYPER to enter Hyper mode for 5 seconds: every Drive, Lob, Dink and
  //  Smash is faster, more accurate and harder to return.
  // =====================================================================
  const ENERGY_PER_SECOND = 3.5; // while a rally is live
  const ENERGY_PER_HIT = 7;      // each ball you hit
  const ENERGY_PER_POINT = 12;   // each rally your team wins
  const HYPER_SECONDS = 5;
  // One meter per human player. Against the CPU only yours is used.
  const energy = player.en; // your bar (drawn in the HUD and on the HYPER button)
  // humans whose meter runs: just you vs the CPU; everyone online
  const botHyperRate = () => (netRole === 'off' ? BOT_HYPER_RATE[ui.difficulty] : 0);
  const meterHolders = () => (netRole === 'off'
    ? [player, ...(botHyperRate() > 0 ? roster.filter(a => !a.human) : [])]
    : roster.filter(a => a.human));

  function resetEnergy() {
    for (const a of [player, mate, ai, ai2]) { const e = a.en; e.value = 0; e.hyperT = 0; e.denied = 0; e.fullPulse = 0; }
  }

  function addEnergy(a: Athlete, n: number) {
    const e = a.en;
    if (e.value >= 100 || e.hyperT > 0) return; // no charging while Hyper burns
    const rate = a.human ? 1 : botHyperRate(); // CPU players charge slower (Easy: never)
    if (rate <= 0) return;
    e.value = Math.min(100, e.value + n * rate);
    if (e.value >= 100) { // just became full
      netEmit({ k: 'hyper', s: a.seat, a: 'ready' });
      hyperReadyFx(a);
    }
  }

  function hyperReadyFx(a: Athlete) {
    if (a !== player) return; // only your own bar announces itself
    energy.fullPulse = 1;
    sfx.full();
    floatText(player.x, player.y, 'HYPER READY', HYPER_COLOR, 1);
    buzz(30);
  }

  // The HYPER button.
  function pressHyper() {
    ensureAudio();
    // Works during rallies, while waiting to serve and in the short pause after a point
    if (!(state === 'rally' || state === 'serve' || state === 'point')) return;
    if (netRole === 'guest') { // the host switches it on and tells us
      if (energy.hyperT > 0) return;
      if (energy.value < 100) { hyperDeniedFx(); return; }
      netSend?.({ k: 'hyper' });
      return;
    }
    activateHyper(player);
  }

  function activateHyper(a: Athlete) {
    if (!(state === 'rally' || state === 'serve' || state === 'point')) return;
    const e = a.en;
    if (e.hyperT > 0) return;
    if (e.value < 100) { // not charged: no effect, just feedback
      if (a === player) hyperDeniedFx();
      return;
    }
    e.hyperT = HYPER_SECONDS;
    netEmit({ k: 'hyper', s: a.seat, a: 'on' });
    hyperOnFx(a);
  }

  function hyperDeniedFx() {
    energy.denied = 0.45;
    sfx.deny();
    buzz(20);
  }

  function hyperOnFx(a: Athlete) {
    sfx.charge();
    sfx.power();
    addShake(6);
    if (a === player) { flash = 0.35; buzz([30, 20, 50]); }
    floatText(a.x, a.y, 'HYPER MODE!', HYPER_COLOR, 1.3);
    sparks(a.x, a.y, 3, 30, HYPER_SPARKS, 1.1);
  }

  function hyperOverFx(a: Athlete) {
    floatText(a.x, a.y, 'HYPER OVER', '#9fb0c3', 0.9);
  }

  function updateEnergy(dt: number) {
    for (const a of meterHolders()) {
      const e = a.en;
      if (e.hyperT > 0) {
        e.hyperT = Math.max(0, e.hyperT - dt);
        e.value = (100 * e.hyperT) / HYPER_SECONDS; // the bar drains as Hyper runs out
        e.auraT -= dt;
        if (e.auraT <= 0) { // electric sparks rising around the player
          e.auraT = 0.04;
          spawn({ kind: 'spark', x: a.x + rand(-0.8, 0.8), y: a.y + rand(-0.4, 0.4), z: rand(0.2, 1.8),
            vx: rand(-1, 1), vy: rand(-1, 1), vz: rand(6, 12), g: 4, life: rand(0.3, 0.5), size: rand(2, 3.5),
            color: pick(HYPER_SPARKS) });
        }
        if (e.hyperT <= 0) {
          e.value = 0;
          if (!isGuest()) { // guests hear about it from the host
            netEmit({ k: 'hyper', s: a.seat, a: 'over' });
            hyperOverFx(a);
          }
        }
      } else if (state === 'rally' && !isGuest()) {
        addEnergy(a, ENERGY_PER_SECOND * dt);
      }
    }
    energy.denied = Math.max(0, energy.denied - dt);
    energy.fullPulse = Math.max(0, energy.fullPulse - dt * 1.5);
  }

  function updatePlayer(dt: number) {
    const { dx, dy } = moveInput();
    // Ease toward the target speed: snappy to start and to stop, never jerky
    const tvx = dx * PLAYER_SPEED, tvy = dy * PLAYER_SPEED;
    const moving = dx !== 0 || dy !== 0;
    const k = 1 - Math.exp(-dt * (moving ? 30 : 32));
    player.mvx = (player.mvx || 0) + (tvx - (player.mvx || 0)) * k;
    player.mvy = (player.mvy || 0) + (tvy - (player.mvy || 0)) * k;
    tickSwing(player, dt);

    if (state === 'serve' && serverAth === player) {
      player.y = behindBaseline('player');
      if (!serveWind) player.x = clamp(player.x + player.mvx * 0.6 * dt, serveHalf[0] + 0.5, serveHalf[1] - 0.5); // planted while serving
      holdBallFor(player);
      return;
    }

    let mx = player.mvx * dt, my = player.mvy * dt;
    // the quick step toward the ball at contact
    if ((player.lungeT || 0) > 0) {
      const t = Math.min(dt, player.lungeT as number);
      mx += (player.lungeVX || 0) * t;
      my += (player.lungeVY || 0) * t;
      player.lungeT = (player.lungeT as number) - dt;
    }
    // receive assist: while a shot waits for the ball, ease sideways to put it on the paddle side
    const waiting = player.queued && player.swing > 0 && state === 'rally' && lastHitter !== 'player';
    if (waiting) {
      const sx = contactSpotX();
      if (sx !== null) {
        const off = sx - player.x;
        if (Math.abs(off) < 4.5) mx += clamp(off, -RECEIVE_ASSIST * dt, RECEIVE_ASSIST * dt);
      }
    }
    player.x = clamp(player.x + mx, X_MIN, X_MAX);
    player.y = clamp(player.y + my, NET_Y + 0.6, COURT_L + 5.5);

    if (!isGuest()) tryConnect(player); // the guest's shots are played by the host
  }

  // A shot tapped early holds while the ball is still on its way over (or has yet to
  // bounce for the two-bounce rule); its time only runs once the ball can be hit.
  // (Before, an early tap on a lob or a deep return could run out before the ball arrived.)
  function tickSwing(p: Athlete, dt: number) {
    if (p.swing <= 0) return;
    const waitingForBall = !!p.queued && state === 'rally' && lastHitter !== p.team && !ball.netted && !ball.held
      && (sideOf(ball.y) !== p.team || (bounces === 0 && shots < 3));
    if (!waitingForBall) p.swing -= dt;
  }

  // Connect with the ball while a shot is waiting (or during a practice swing).
  function tryConnect(p: Athlete) {
    if (state !== 'rally' || p.swing <= 0 || lastHitter === p.team || ball.held || ball.netted) return;
    if (sideOf(ball.y) !== p.team) return;
    // Never fault on an early tap: a waiting shot holds until it's legal to hit
    if (bounces === 0 && shots < 3) return;                     // two-bounce rule: let it bounce
    if (bounces === 0 && inKitchen(p.team, p.y)) return;       // no volleys in the kitchen
    const d = Math.hypot(ball.x - p.x, ball.y - p.y);
    if (d > REACH + (p.net ? NET_REACH_BONUS : 0) || ball.z > 7.5) return;

    // Best moment: when the ball is as close to the paddle as it will get. Hold on while it
    // is still coming closer, unless it's about to bounce a second time or time runs out.
    // Timed against the contact spot a little in front of the body (where real players
    // meet the ball), not the body's centre, so the ball is never hit once it's behind you.
    const tn = p.team === 'player' ? -1 : 1; // toward the net
    const cy = p.y + tn * 0.8;
    const look = 0.05;
    const nx = ball.x + ball.vx * look, ny = ball.y + ball.vy * look;
    const dc = Math.hypot(ball.x - p.x, ball.y - cy);
    const dcNext = Math.hypot(nx - p.x, ny - cy);
    const closing = dcNext < dc - 0.03;
    const inFrontNext = (ny - p.y) * tn > 0.25;
    const secondBounceSoon = bounces >= 1 && ball.z < 0.45 && ball.vz < 0;
    const lastChance = p.swing < 0.06 || Math.hypot(nx - p.x, ny - p.y) > REACH; // about to get away
    if (closing && dc > CONTACT_IDEAL && inFrontNext && !secondBounceSoon && !lastChance) return;
    // After the bounce, let the ball come up to a playable height instead of scooping it
    // off the floor - while it is still in front of you and within reach.
    if (bounces >= 1 && ball.vz > 0 && !lastChance && inFrontNext && ball.z < (p.swingType === 'dink' ? 0.9 : 1.6)) return;

    p.swing = 0;
    p.queued = false;
    humanHit(p, p.swingType);
  }

  // Host: another person's athlete follows their own reports of where they are, at
  // no more than a fast run (a modified app can't teleport), kept on their side of
  // the net, and plays their queued shots by the same rules as yours.
  // Room to catch up after reports arrive in a bunch (phone networks deliver unevenly),
  // while still far too slow to teleport.
  const REMOTE_MAX_SPEED = PLAYER_SPEED * 2.5;
  function updateRemote(a: Athlete, dt: number) {
    const n = a.net as NetAth;
    tickSwing(a, dt);
    const current = n.have && n.gen === setupGen; // ignore reports from before this serve's setup
    if (state === 'serve' && serverAth === a) {
      a.y = behindBaseline(a.team);
      if (current && !serveWind) a.x = clamp(n.x, serveHalf[0] + 0.5, serveHalf[1] - 0.5);
      holdBallFor(a);
      return;
    }
    if (current) moveToward(a, clamp(n.x, X_MIN, X_MAX), clampOwnY(a.team, n.y), REMOTE_MAX_SPEED, dt);
    tryConnect(a);
  }

  // =====================================================================
  //  Bots (CPU players and your partner)
  // =====================================================================

  // Simulate the ball forward and pick the first spot this bot can legally reach.
  function computePlan(bot: Athlete): Plan {
    const own = bot.team;
    const sk = bot.skill;
    let x = ball.x, y = ball.y, z = ball.z;
    let vx = ball.vx, vy = ball.vy, vz = ball.vz;
    let b = 0, t = 0;
    const dt = 1 / 60;
    const mustBounce = shots < 3;
    const gBall = ball.g || G;
    let fallback: Plan | null = null;

    for (let i = 0; i < 260; i++) {
      vz -= gBall * dt; x += vx * dt; y += vy * dt; z += vz * dt; t += dt;
      if (z <= 0) {
        z = 0;
        if (vz < -1.5) { vz = -vz * BOUNCE_Z; vx *= BOUNCE_XY; vy *= BOUNCE_XY; b++; }
        else vz = 0;
        if (b >= 2) break;
      }
      if (sideOf(y) !== own) continue;
      if (mustBounce && b === 0) continue;
      if (z < 0.15 || z > 5.8) continue;

      const volley = b === 0;
      const sx = clamp(x, X_MIN, X_MAX);
      let sy = own === 'ai' ? y - 0.9 : y + 0.9; // stand just behind the ball
      if (volley) { // never volley from inside the kitchen
        sy = own === 'ai' ? Math.min(sy, TOP_KITCHEN - 0.4) : Math.max(sy, BOT_KITCHEN + 0.4);
        if (Math.abs(y - sy) > sk.reach * 0.8) continue;
      }
      sy = clampOwnY(own, sy);
      const need = Math.max(0, Math.hypot(sx - bot.x, sy - bot.y) - 0.6) / (sk.speed * bot.style.speed) + sk.reaction * bot.style.react;
      const cand = { x: sx, y: sy, t, gap: need - t };
      if (need <= t) return cand;
      if (!fallback || cand.gap < fallback.gap) fallback = cand;
    }
    return fallback || { x: bot.x, y: bot.y, t: 0, gap: 99 };
  }

  // Decide who chases the ball that is coming over to a team.
  function assignInterceptors() {
    const hitter = lastHitter as Team;
    const recv = other(hitter);
    interceptor[hitter] = null;
    interceptor[recv] = null;
    const bots = teamOf(recv).filter(a => !a.human);
    for (const b of bots) {
      b.plan = computePlan(b);
      // reaction varies shot to shot (keeps bots from feeling robotic); a power shot is harder to read
      b.reactT = b.skill.reaction * b.style.react * rand(0.75, 1.25) * (comeback(b.team) ? 0.85 : 1) + (ball.power ? 0.1 : 0);
    }
    if (!bots.length) return;

    if (recv === 'ai') {
      // CPU team: whoever gets there with the most time to spare
      interceptor.ai = bots.reduce((best, b) => ((b.plan as Plan).gap < (best.plan as Plan).gap ? b : best));
    } else {
      // Your partner takes balls on their half and leaves your half to you
      const m = bots[0];
      const mid = (m.x + player.x) / 2;
      const mateLeft = m.x < player.x;
      const lx = (m.plan as Plan).x;
      interceptor.player = (mateLeft ? lx < mid : lx > mid) ? m : null;
    }
  }

  function homeFor(b: Athlete) {
    // The serving team stays back until the return has bounced (two-bounce rule)
    const mustBack = b.team === server && shots < 3 && state === 'rally';
    const y = mustBack ? behindBaseline(b.team) : ownY(b.team, clamp(b.skill.home + b.style.home, KITCHEN + 0.6, 19));
    let x: number;
    if (mode === 'singles') {
      x = 10 + (ball.x - 10) * 0.45;
    } else {
      const h = courtHalf(b.team, b.court);
      x = (h[0] + h[1]) / 2 + (ball.x - 10) * 0.3;
    }
    return { x, y };
  }

  // Weighted random pick: { drive: 2, dink: 1 } -> 'drive' two times in three.
  function pickWeighted(w: Record<ShotType, number>): ShotType {
    const entries = (Object.keys(w) as ShotType[]).map(k => [k, Math.max(0, w[k])] as const);
    let r = Math.random() * entries.reduce((s, [, v]) => s + v, 0);
    for (const [k, v] of entries) { if ((r -= v) <= 0) return k; }
    return 'drive';
  }

  // The bot's team is far behind: it digs in (reacts faster, fewer errors).
  const comeback = (team: Team) => score[other(team)] - score[team] >= 4;

  function botChooseShot(bot: Athlete) {
    const sk = bot.skill;
    const st = bot.style;
    const nearNet = Math.abs(bot.y - NET_Y) < 13;
    const lowBall = ball.z < 2.6;
    const opps = teamOf(other(bot.team));
    const oppsBack = opps.every(o => Math.abs(o.y - NET_Y) > 14);
    const oppsUp = opps.some(o => Math.abs(o.y - NET_Y) < 9);
    let type: ShotType;

    if (ball.z > st.smashAt && shots >= 2 && Math.random() < 0.55 + sk.smart * 0.4) type = 'smash'; // put it away
    else if (shots === 1) type = pickWeighted({ drive: 4 * st.drive, lob: 0.7 * st.lob, dink: 0.2 * st.dink, smash: 0 }); // return: deep
    else if (shots === 2) type = pickWeighted({ dink: 3 * sk.smart * st.dink, drive: 2 * (1 - sk.smart * 0.5) * st.drive, lob: 0.3 * st.lob, smash: 0 }); // third shot
    else if (nearNet && lowBall) type = pickWeighted({ dink: 3 * st.dink, drive: 1 * st.drive, lob: 0.35 * st.lob, smash: 0 }); // kitchen battle
    else if (oppsUp) type = pickWeighted({ drive: 1.6 * st.drive, lob: 1.1 * st.lob, dink: 0.6 * st.dink, smash: 0 }); // pass or lob them
    else if (oppsBack) type = pickWeighted({ dink: 1.7 * st.dink, drive: 1 * st.drive, lob: 0.25 * st.lob, smash: 0 }); // drop it short
    else type = pickWeighted({ drive: 2 * st.drive, dink: 0.8 * st.dink, lob: 0.45 * st.lob, smash: 0 });

    // Where to: a sharp angle, straight at a net player, or the biggest gap
    let tx: number;
    const netOpp = opps.find(o => Math.abs(o.y - NET_Y) < 9);
    if (type !== 'lob' && Math.random() < st.angle * sk.smart) {
      const leftGap = Math.min(...opps.map(o => Math.abs(1.4 - o.x)));
      const rightGap = Math.min(...opps.map(o => Math.abs(18.6 - o.x)));
      tx = leftGap > rightGap ? rand(1, 2.2) : rand(17.8, 19);
    } else if ((type === 'drive' || type === 'smash') && netOpp && Math.random() < st.body) {
      tx = netOpp.x + rand(-0.6, 0.6); // body shot: jam them
    } else {
      let best = 10, bestGap = -1;
      for (const cx of [2.5, 5, 7.5, 10, 12.5, 15, 17.5]) {
        const g = Math.min(...opps.map(o => Math.abs(cx - o.x)));
        if (g > bestGap) { bestGap = g; best = cx; }
      }
      tx = Math.random() < 0.4 + sk.smart * 0.5 ? best + rand(-1.5, 1.5) : rand(4, 16);
    }

    // A charged bot fires its own Hyper on an attacking shot
    if (bot.en.value >= 100 && bot.en.hyperT <= 0 && (type === 'smash' || type === 'drive' || ball.z > 3) && Math.random() < 0.7) {
      activateHyper(bot);
    }

    // Pressure makes mistakes: stretching for the ball or facing a fast shot
    const incoming = Math.hypot(ball.vx, ball.vy);
    const stretch = Math.hypot(ball.x - bot.x, ball.y - bot.y) / sk.reach;
    const fight = comeback(bot.team) ? 0.85 : 1;
    let err = sk.error * st.risk * fight * (0.7 + 0.5 * stretch + incoming / 70);
    let netty = false;
    const mishitChance = (0.03 + (1 - sk.smart) * 0.2 + (incoming > 45 ? 0.06 : 0) + (stretch > 0.85 ? 0.05 : 0)) * st.risk * fight
      + (ball.power ? 0.3 : 0);
    if (Math.random() < mishitChance) {
      if (Math.random() < 0.45) netty = true; // dumped into the net
      else err *= 3;                          // sprayed wide or long
    }
    doHit(bot, type, tx, err, netty);
  }

  function moveToward(o: Athlete, tx: number, ty: number, speed: number, dt: number) {
    const dx = tx - o.x, dy = ty - o.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.1) return;
    const step = Math.min(d, speed * dt);
    o.x += (dx / d) * step;
    o.y += (dy / d) * step;
  }

  function updateBot(b: Athlete, dt: number) {
    if (state === 'serve') {
      if (b === serverAth) {
        holdBallFor(b);
        stateTimer -= dt;
        if (stateTimer <= 0) botServe(b);
      }
      return;
    }

    const incoming = state === 'rally' && !!lastHitter && lastHitter !== b.team && !ball.netted;
    const chasing = incoming && interceptor[b.team] === b && !!b.plan;
    if (incoming && b.reactT > 0) {
      b.reactT -= dt;
      if (chasing) return; // still reading the shot
    }

    const tgt = chasing ? (b.plan as Plan) : homeFor(b);
    // a team on a run of points plays with extra pace ("on fire")
    const heat = streak.team === b.team && streak.n >= 3 ? 1.08 : 1;
    moveToward(b, tgt.x, tgt.y, b.skill.speed * b.style.speed * heat, dt);
    b.x = clamp(b.x, X_MIN, X_MAX);
    b.y = clampOwnY(b.team, b.y);

    // Hit?
    if (!incoming || b.reactT > 0 || sideOf(ball.y) !== b.team) return;
    const d = Math.hypot(ball.x - b.x, ball.y - b.y);
    if (d > b.skill.reach || ball.z > 6.5) return;
    if (bounces === 0 && shots < 3) return;                 // two-bounce rule
    if (bounces === 0 && inKitchen(b.team, b.y)) return;    // no volleys in the kitchen
    botChooseShot(b);
  }

  // Keep teammates from standing on top of each other
  function separate() {
    for (let i = 0; i < roster.length; i++) {
      for (let j = i + 1; j < roster.length; j++) {
        const a = roster[i], c = roster[j];
        if (a.team !== c.team) continue;
        if (a.human && c.human) continue; // two people steer themselves
        const dx = c.x - a.x, dy = c.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = 2.2;
        if (d >= min || d === 0) continue;
        const push = (min - d) / d;
        if (a.human) { c.x += dx * push; c.y += dy * push; }
        else if (c.human) { a.x -= dx * push; a.y -= dy * push; }
        else { a.x -= (dx * push) / 2; a.y -= (dy * push) / 2; c.x += (dx * push) / 2; c.y += (dy * push) / 2; }
      }
    }
  }

  function updateMenuDemo() {
    // Ball hops around on the court behind the menu
    const z = Math.abs(Math.sin(clock * 3.2)) * 5;
    if (ball.z > 0.4 && z <= 0.4) { ball.squash = 0.8; dust(ball.x, ball.y, 3, 0.7); }
    ball.z = z;
    ball.x = 10 + Math.sin(clock * 0.7) * 6;
    ball.y = 33 + Math.cos(clock * 0.5) * 6;
    ball.spin += 0.05;
  }

  function update(dt: number) {
    if (state === 'paused') return;
    clock += dt;

    if (hitStop > 0) { hitStop -= dt; updateFx(dt * 0.2); return; }
    updateFx(dt);

    if (state === 'menu') { updateMenuDemo(); return; }
    if (state === 'over') return;
    if (netRole === 'guest') { updateGuest(dt); return; }
    if (netRole === 'host' && netHold) { // someone is away: everything waits
      holdT += dt;
      if (holdT >= 0.5) { holdT = 0; sendSnapshot(); } // keep the others informed
      return;
    }

    const old = roster.map(a => [a.x, a.y]);
    updatePlayer(dt);
    if (netRole === 'host') for (const a of roster) if (a.net) updateRemote(a, dt);
    updateEnergy(dt);
    for (const a of roster) if (!a.human) updateBot(a, dt);
    tickServeWind(dt);
    if (state !== 'serve') separate();
    stepBall(dt);
    roster.forEach((a, i) => animatePerson(a, old[i][0], old[i][1], dt));

    if (state === 'point') {
      stateTimer -= dt;
      if (stateTimer <= 0) {
        if (gameWinner) endGame();
        else setupServe();
      }
    }
    if (netRole === 'host' && (state as State) !== 'over') {
      netClock += dt * 1000;
      snapT += dt * 1000;
      if (snapT >= SNAPSHOT_MS) { snapT = 0; sendSnapshot(); }
    }
  }

  // =====================================================================
  //  Online: host side
  // =====================================================================
  function sendSnapshot() {
    if (!netSend) return;
    const st = state === 'paused' ? (pausedFrom as State) : state;
    if (st !== 'serve' && st !== 'rally' && st !== 'point' && st !== 'over') return;
    const snap: Snapshot = {
      k: 'snap', q: ++snapSeq, st,
      sc: [score.player, score.ai], sv: toW(server), ss: serverAth.seat, sn: serverNum,
      lh: lastHitter ? toW(lastHitter) : -1,
      sh: shots, bn: bounces,
      ct: seats.map(a => a.court),
      p: seats.map(a => [r2(a.x), r2(a.y)] as [number, number]),
      b: packBall(ball),
      e: seats.map(a => [r2(a.en.value), r2(a.en.hyperT)] as [number, number]),
      gw: gameWinner ? toW(gameWinner) : -1, rc: rallyLog.length,
      hh: [r2(serveHalf[0]), r2(serveHalf[1])], ts: Math.round(netClock), sg: setupGen,
      hw: netHold ? holdNames.slice(0, 60) : '',
    };
    netSend(snap);
  }

  const lastReply = new Map<string, number>();
  const throttled = (key: string, now: number) => {
    if (now - (lastReply.get(key) ?? 0) < 1000) return true;
    lastReply.set(key, now);
    return false;
  };

  // A message from the player in `seat` (each player sends on their own channel,
  // so the seat is known for sure). Nothing they send is trusted beyond their input.
  function hostReceive(raw: unknown, seat: number) {
    const a = seatAth(seat);
    if (!a || a === player || !a.net) return;
    const m = parseGuestMsg(raw);
    if (!m) return;
    const now = Date.now();
    a.net.last = now;
    switch (m.k) {
      case 'in':
        a.net.x = m.x; a.net.y = m.y; a.net.aim = m.a; a.net.have = true;
        a.net.gen = Math.min(m.s, setupGen);
        break;
      case 'shot':
        if (state === 'serve' || state === 'rally') { a.net.aim = m.a; actionFor(a, m.ty); }
        break;
      case 'hyper':
        activateHyper(a);
        break;
      case 'hello': // catch them up at once (at most once a second each)
        if (!throttled(`hello${seat}`, now)) sendSnapshot();
        break;
      case 'need_log':
        if (!throttled(`log${seat}`, now)) netSend?.({ k: 'ev', e: { k: 'log', l: rallyLog.slice() } });
        break;
    }
  }

  // =====================================================================
  //  Online: guest side (draws the host's match, moves only you)
  // =====================================================================
  let lastSnap: Snapshot | null = null;

  // guest: where you were over the last second (to compare with the host's delayed view)
  const myTrail: { x: number; y: number; t: number }[] = [];
  let driftT = 0;

  function updateGuest(dt: number) {
    const old = roster.map(a => [a.x, a.y]);
    updatePlayer(dt);                            // your own movement is instant
    const nowT = Date.now();
    myTrail.push({ x: player.x, y: player.y, t: nowT });
    while (myTrail.length && nowT - myTrail[0].t > 1000) myTrail.shift();
    // everyone else glides to where the host last placed them
    const k = 1 - Math.exp(-dt * 18);
    for (const a of roster) {
      if (a === player || !a.net) continue;
      a.x += (a.net.x - a.x) * k;
      a.y += (a.net.y - a.y) * k;
    }
    tickServeWind(dt);
    if (ball.held) holdBallFor(serverAth);
    else stepBall(dt);                           // same physics as the host: smooth between hits
    updateEnergy(dt);
    roster.forEach((a, i) => animatePerson(a, old[i][0], old[i][1], dt));

    // report where you are (host's frame)
    inT += dt * 1000;
    const now = Date.now();
    const key = `${r2(player.x)},${r2(player.y)},${aimDir()},${seenGen}`;
    if ((inT >= INPUT_MS && key !== lastInKey) || now - lastInSent >= KEEPALIVE_MS) {
      inT = 0;
      lastInKey = key;
      lastInSent = now;
      netSend?.({ k: 'in', x: r2(inX(player.x)), y: r2(inY(player.y)), a: wireAim(aimDir()), s: seenGen });
    }
  }

  function setBallFromWire(b: BallW) {
    const m = mirrored() ? mirrorBall(b) : b;
    ball.x = m[0]; ball.y = m[1]; ball.z = m[2];
    ball.vx = m[3]; ball.vy = m[4]; ball.vz = m[5]; ball.g = m[6];
    ball.held = (m[7] & 1) !== 0;
    ball.netted = (m[7] & 2) !== 0;
    ball.power = (m[7] & 4) !== 0;
  }

  function guestReceive(raw: unknown) {
    const m = parseHostMsg(raw);
    if (!m) return;
    lastRecv = Date.now();
    if (m.k === 'snap') applySnapshot(m);
    else applyEvent(m.e);
  }

  function applySnapshot(s: Snapshot) {
    if (lastSnap && s.q <= lastSnap.q) return; // old or repeated
    const prevState = state;
    lastSnap = s;
    if (state === 'over' || state === 'menu') return;
    score.player = s.sc[myTeamW]; score.ai = s.sc[1 - myTeamW];
    server = fromW(s.sv);
    serverAth = seatAth(s.ss) ?? serverAth;
    serverNum = s.sn === 2 ? 2 : 1;
    lastHitter = s.lh === -1 ? null : fromW(s.lh);
    shots = s.sh;
    bounces = s.bn;
    s.ct.forEach((c, i) => { const a = seatAth(i); if (a) a.court = c === 'L' ? 'L' : 'R'; });
    serveHalf = mirrored() ? [COURT_W - s.hh[1], COURT_W - s.hh[0]] : [s.hh[0], s.hh[1]];
    gameWinner = s.gw === -1 ? null : fromW(s.gw);
    let mine: { x: number; y: number } | null = null;
    s.p.forEach((p, i) => {
      const a = seatAth(i);
      if (!a || !Array.isArray(p)) return;
      const x = inX(p[0]), y = inY(p[1]);
      if (a === player) mine = { x, y };
      else if (a.net) { a.net.x = x; a.net.y = y; }
    });
    s.e.forEach((e, i) => { const a = seatAth(i); if (a && Array.isArray(e)) { a.en.value = e[0]; a.en.hyperT = e[1]; } });

    const me = mine as { x: number; y: number } | null;
    if (s.sg !== seenGen) { // a new serve: the host placed everyone
      seenGen = s.sg;
      if (me) { player.x = me.x; player.y = me.y; }
      for (const a of roster) if (a !== player && a.net) { a.x = a.net.x; a.y = a.net.y; }
      player.mvx = player.mvy = 0;
      player.swing = 0; player.queued = false;
      myTrail.length = 0;
      driftT = 0;
    } else if (me) {
      // The host's copy of you is always a round trip behind while you run, so compare it
      // with where you WERE recently, not where you are now. Only if the host keeps you
      // somewhere you never were (it refused a move) do we ease you over to it.
      const behind = Math.min(Math.hypot(me.x - player.x, me.y - player.y),
        ...myTrail.map(p => Math.hypot(me.x - p.x, me.y - p.y)));
      driftT = behind > 2.5 ? driftT + SNAPSHOT_MS / 1000 : 0;
      if (driftT > 0.5) {
        if (behind > 12) { player.x = me.x; player.y = me.y; } // far off: jump
        else { player.x += (me.x - player.x) * 0.3; player.y += (me.y - player.y) * 0.3; } // glide
      }
    }

    const ballHeld = (s.b[7] & 1) !== 0;
    if (ballHeld) {
      ball.held = true; ball.vx = ball.vy = ball.vz = 0;
    } else {
      // our ball follows the host's trajectory; correct it if it drifted (a missed hit)
      const w = mirrored() ? mirrorBall(s.b) : s.b;
      if (ball.held || Math.hypot(w[0] - ball.x, w[1] - ball.y, w[2] - ball.z) > 2) setBallFromWire(s.b);
    }

    const st = s.st === 'over' ? 'point' : s.st; // 'over' arrives as its own event
    if (st !== prevState) {
      state = st;
      if (st === 'serve') { landing = null; trail = []; }
      syncState();
    }
    // missed a rally result: ask the host for the whole list
    if (rallyLog.length < s.rc && Date.now() - needLogAt > 1500) {
      needLogAt = Date.now();
      netSend?.({ k: 'need_log' });
    }
  }

  // The referee standing at the host's left is on team B's right.
  const refFromWire = (r: number) => refs[mirrored() ? 1 - r : r] ?? refs[0];

  function applyEvent(e: MatchEvent) {
    if (state === 'menu') return;
    switch (e.k) {
      case 'hit': {
        const team = fromW(e.t);
        const h = seatAth(e.s) ?? teamOf(team)[0];
        setBallFromWire(e.b);
        lastHitter = team;
        shots = e.n;
        bounces = 0;
        landing = predictLanding();
        rallyPop = 1;
        h.cpt = { x: ball.x, y: ball.y, z: ball.z };
        if (!(h.stroke && h.strokeT < 0.6)) startStroke(h, e.sk, 0.35);
        splitStep(other(team));
        if (h === player) { player.swing = 0; player.queued = false; startStroke(player, e.sk, 0.4); }
        hitFx(h, e.ty, e.sm, e.hy, inX(e.p[0]), inY(e.p[1]), e.p[2]);
        break;
      }
      case 'serve': {
        const team = fromW(e.t);
        serveWind = null;
        setBallFromWire(e.b);
        state = 'rally';
        lastHitter = team;
        shots = 1;
        bounces = 0;
        serveFx(seatAth(e.s) ?? serverAth);
        syncState();
        break;
      }
      case 'ref': {
        refCall(refFromWire(e.r), e.p as RefPose, e.x, {
          color: e.c, dur: e.d, whistle: e.w, speech: e.s, interrupt: e.i,
          target: e.tg ? { x: inX(e.tg[0]), y: inY(e.tg[1]) } : undefined,
        });
        break;
      }
      case 'refx': {
        const ref = refFromWire(0); // the head referee
        if (ref.bubble) ref.bubble.text += ' ' + e.x;
        say(e.x, ref.pitch);
        break;
      }
      case 'float':
        floatText(inX(e.x), inY(e.y), e.tx, e.c, e.s);
        break;
      case 'point': {
        const w = fromW(e.w);
        state = 'point';
        if (e.gw !== -1) gameWinner = fromW(e.gw);
        if (w === 'player') guestPointsWon++;
        const entry: RallyW = { w: e.w === 0 ? 'h' : 'g', t: e.ts };
        if (e.i === rallyLog.length) rallyLog.push(entry);
        else if (e.i > rallyLog.length && Date.now() - needLogAt > 500) { needLogAt = Date.now(); netSend?.({ k: 'need_log' }); }
        const reason = e.mb === -1 ? e.r : missedText(fromW(e.mb));
        pointFx(w, reason, e.m);
        syncState();
        rallyListeners.forEach(fn => { try { fn(); } catch { /* never breaks the game */ } });
        break;
      }
      case 'wind': { // the server started the serve motion
        const a = seatAth(e.s);
        if (a && state === 'serve' && a === serverAth) startServeWind(a, null);
        break;
      }
      case 'setup':
        serveWind = null;
        landing = null;
        trail = [];
        fade = 0.6;
        ball.netted = false;
        ball.power = false;
        hideBanner();
        break;
      case 'hyper': {
        const a = seatAth(e.s);
        if (!a) break;
        if (e.a === 'on') { a.en.hyperT = HYPER_SECONDS; hyperOnFx(a); }
        else if (e.a === 'ready') hyperReadyFx(a);
        else { a.en.hyperT = 0; a.en.value = 0; hyperOverFx(a); }
        break;
      }
      case 'log': {
        // keep what we saw ourselves; take only the rallies we missed
        const l = Array.isArray(e.l) ? e.l : [];
        const agrees = rallyLog.every((r, i) => l[i] && l[i].w === r.w);
        if (agrees && l.length >= rallyLog.length) rallyLog = l.map(r => ({ w: r.w === 'g' ? 'g' : 'h', t: Number(r.t) || 0 }));
        break;
      }
      case 'over': {
        score.player = e.sc[myTeamW]; score.ai = e.sc[1 - myTeamW];
        gameWinner = fromW(e.w);
        longestRally = e.lr;
        pointsWon = guestPointsWon;
        endGame();
        break;
      }
    }
  }

  // =====================================================================
  //  Rendering — 2D perspective view from behind your baseline
  //  World: x across the court (0..20 ft), y along it (0 = far baseline,
  //  44 = your baseline), z = height. proj() is a pinhole camera standing
  //  behind your baseline and looking down the court, so the court is
  //  drawn as a trapezoid with everything scaled by distance.
  // =====================================================================
  function fitCamera() {
    const W = VIEW_W, H = VIEW_H;
    // Blend smoothly from a high "portrait" camera (tall screens) to a lower
    // broadcast camera (wide screens), so every screen shape frames the court well.
    const t = clamp((W / H - 0.6) / (1.5 - 0.6), 0, 1);
    cam.y = COURT_L + lerp(40, 32, t);
    cam.h = lerp(40, 22, t);
    const nearY = COURT_L + lerp(4.5, 2.2, t), farY = -4;
    const dN = cam.y - nearY, dF = cam.y - farY;
    const top = lerp(0.38, 0.3, t), bot = lerp(0.985, 0.99, t);
    const fV = ((bot - top) * H) / (cam.h / dN - cam.h / dF);
    // keep both sidelines (+ run-off) on screen; with floating touch controls,
    // leave room at the sides so the joystick and buttons don't cover the near corners
    const reserve = compactHud ? Math.min(W * 0.18, 175) * (W < 640 ? 1.9 : 1.5) : 0; // tiny phones need more room
    const fW = (0.98 * (W - reserve) * (cam.y - 46)) / 27;
    cam.f = Math.min(fV, fW);
    cam.hor = bot * H - (cam.h * cam.f) / dN;
    cam.cx = W / 2;
    // the roof always sits well above the camera (tall screens use a higher camera)
    HALL.ceil = Math.max(27, cam.h + 9);
  }

  function proj(x: number, y: number, z = 0) {
    const d = Math.max(1, cam.y - y);
    const s = cam.f / d; // pixels per foot at this distance
    return { x: cam.cx + (x - cam.x) * s, y: cam.hor + (cam.h - z) * s, s };
  }

  type P3 = number[];
  function pathPts(pts: P3[]) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = proj(pts[i][0], pts[i][1], pts[i][2] || 0);
      if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.closePath();
  }
  function fillPts(pts: P3[], style: string | CanvasGradient) { pathPts(pts); ctx.fillStyle = style; ctx.fill(); }
  const groundQuad = (x0: number, y0: number, x1: number, y1: number, z = 0): P3[] => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  function groundEllipsePath(x: number, y: number, rx: number, ry: number, n = 24) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = proj(x + Math.cos(a) * rx, y + Math.sin(a) * ry, 0);
      if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.closePath();
  }

  function rr(x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- indoor sports hall ----------
  // A single-court indoor facility: maple floor, sport-court surround, padded
  // walls, high windows, steel trusses and LED panels, divider curtains and benches.
  const HALL = { back: -16, left: -30, right: 50, ceil: 27, pad: 7 };
  const hallNear = () => cam.y - 3;                     // floor/walls stop just in front of the camera
  const LIGHTS: { x: number; y: number }[] = [];        // LED panels in the ceiling
  for (const y of [-10, 2, 14, 26, 38]) for (const x of [-14, 1, 19, 34]) LIGHTS.push({ x, y });
  const DIVIDER_X = [-12, COURT_W + 12];                 // mesh curtains separating the court
  const BENCHES = [                                      // player benches along the sidelines
    { x: DIVIDER_X[0] + 2.2, y: 13, facing: 1 }, { x: DIVIDER_X[0] + 2.2, y: 33, facing: 1 },
    { x: DIVIDER_X[1] - 2.2, y: 13, facing: -1 }, { x: DIVIDER_X[1] - 2.2, y: 33, facing: -1 },
  ];

  function line3(a: P3, b: P3, color: string, width: number) {
    const p = proj(a[0], a[1], a[2]), q = proj(b[0], b[1], b[2]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  function drawCeiling() {
    const { left: L, right: R, back: B, ceil: C } = HALL;
    const N = hallNear();
    fillPts([[L, B, C], [R, B, C], [R, N, C], [L, N, C]], '#262c36');
    // steel roof trusses running across the hall
    for (let y = B + 5; y < N - 2; y += 10) {
      fillPts([[L, y, C - 0.2], [R, y, C - 0.2], [R, y + 0.7, C - 0.2], [L, y + 0.7, C - 0.2]], '#3b4350');
      line3([L, y + 0.35, C - 1.4], [R, y + 0.35, C - 1.4], '#4a5361', 1.5);
    }
    // LED high-bay panels with a soft glow
    for (const l of LIGHTS) {
      if (l.y > N - 6) continue;
      const c = proj(l.x, l.y, C - 0.6);
      const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.s * 5);
      glow.addColorStop(0, 'rgba(255,250,225,0.35)');
      glow.addColorStop(1, 'rgba(255,250,225,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.s * 5, 0, Math.PI * 2); ctx.fill();
      fillPts([[l.x - 1.6, l.y - 0.7, C - 0.6], [l.x + 1.6, l.y - 0.7, C - 0.6], [l.x + 1.6, l.y + 0.7, C - 0.6], [l.x - 1.6, l.y + 0.7, C - 0.6]], '#fffbea');
    }
  }

  function drawBackWall() {
    const { left: L, right: R, back: B, ceil: C, pad } = HALL;
    // painted block wall
    fillPts([[L, B, pad], [R, B, pad], [R, B, C], [L, B, C]], '#d5dae1');
    for (let z = pad + 1.35; z < C; z += 1.35) line3([L, B, z], [R, B, z], 'rgba(0,0,0,0.05)', 1);
    // high windows letting daylight in (kept in the upper part of the wall)
    const wz1 = C - 3.5, wz0 = wz1 - 4;
    const a = proj(-26, B, wz1), b = proj(46, B, wz0);
    const wg = ctx.createLinearGradient(0, a.y, 0, b.y);
    wg.addColorStop(0, '#bfe0f6'); wg.addColorStop(1, '#8fbfe0');
    ctx.fillStyle = wg;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    for (let x = -26; x <= 46; x += 4) line3([x, B, wz0], [x, B, wz1], '#5d6b7c', Math.max(1, a.s * 0.18));
    line3([-26, B, (wz0 + wz1) / 2], [46, B, (wz0 + wz1) / 2], '#5d6b7c', Math.max(1, a.s * 0.12));
    // safety padding along the bottom of the wall
    fillPts([[L, B, 0], [R, B, 0], [R, B, pad], [L, B, pad]], '#1f3c63');
    for (let x = L + 5; x < R; x += 5) line3([x, B, 0.15], [x, B, pad - 0.15], 'rgba(0,0,0,0.3)', 1);
    fillPts([[L, B, pad - 0.45], [R, B, pad - 0.45], [R, B, pad], [L, B, pad]], '#2f80ed');
    // banners
    drawBanner(-17, -6, 9.5, 13.2, '#1f3c63', '#d7f23b', 'PICKLEBALL CLUB');
    drawBanner(26, 37, 9.5, 13.2, '#d7f23b', '#1f3c63', 'COURT 1');
  }

  function drawBanner(x0: number, x1: number, z0: number, z1: number, bg: string, fg: string, text: string) {
    const B = HALL.back + 0.05;
    const tl = proj(x0, B, z1), br = proj(x1, B, z0);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(tl.x + 3, tl.y + 3, br.x - tl.x, br.y - tl.y);
    ctx.fillStyle = bg;
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.font = `900 ${Math.max(6, tl.s * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fg;
    ctx.fillText(text, (tl.x + br.x) / 2, (tl.y + br.y) / 2 + 1, br.x - tl.x - tl.s);
  }

  function drawSideWalls() {
    const { left: L, right: R, back: B, ceil: C, pad } = HALL;
    const N = hallNear();
    for (const x of [L, R]) {
      fillPts([[x, B, pad], [x, N, pad], [x, N, C], [x, B, C]], '#c9cfd8');
      fillPts([[x, B, 0], [x, N, 0], [x, N, pad], [x, B, pad]], '#1b3557');
      fillPts([[x, B, pad - 0.45], [x, N, pad - 0.45], [x, N, pad], [x, B, pad]], '#2f80ed');
    }
  }

  function drawFloor() {
    const { left: L, right: R, back: B } = HALL;
    const N = hallNear();
    // maple hardwood
    fillPts([[L, B, 0], [R, B, 0], [R, N, 0], [L, N, 0]], '#c89a62');
    for (let x = L; x < R; x += 2.4) fillPts([[x, B, 0], [x + 1.2, B, 0], [x + 1.2, N, 0], [x, N, 0]], 'rgba(120,70,30,0.06)');
    for (let x = L; x <= R; x += 0.6) line3([x, B, 0], [x, N, 0], 'rgba(95,55,25,0.16)', 0.8);
    // varnish shine from the windows, strongest near the back wall
    const a = proj(0, B, 0), b = proj(0, B + 22, 0);
    const sg = ctx.createLinearGradient(0, a.y, 0, b.y);
    sg.addColorStop(0, 'rgba(255,255,255,0.22)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    fillPts([[L, B, 0], [R, B, 0], [R, B + 22, 0], [L, B + 22, 0]], sg);
    // cushioned tournament surround (out-of-bounds area) around the court
    fillPts(groundQuad(-10, -10, COURT_W + 10, COURT_L + 10), '#2c7353');
    const sg2 = ctx.createLinearGradient(0, proj(0, -10, 0).y, 0, proj(0, COURT_L + 10, 0).y);
    sg2.addColorStop(0, 'rgba(255,255,255,0.08)');
    sg2.addColorStop(1, 'rgba(0,0,0,0.12)');
    fillPts(groundQuad(-10, -10, COURT_W + 10, COURT_L + 10), sg2);
    fillPts(groundQuad(-10, -10, COURT_W + 10, -9.75), 'rgba(255,255,255,0.35)');
  }

  // Black mesh curtains on both sides, as used between courts in indoor facilities
  function drawDividers() {
    const y0 = HALL.back + 0.5, y1 = hallNear() - 7, h = 10;
    for (const x of DIVIDER_X) {
      fillPts([[x, y0, 0], [x, y1, 0], [x, y1, h], [x, y0, h]], 'rgba(14,17,23,0.55)');
      for (let z = 1; z < h; z += 1) line3([x, y0, z], [x, y1, z], 'rgba(255,255,255,0.06)', 1);
      for (let y = y0; y < y1; y += 2) line3([x, y, 0.4], [x, y, h], 'rgba(255,255,255,0.06)', 1);
      fillPts([[x, y0, 0], [x, y1, 0], [x, y1, 0.45], [x, y0, 0.45]], 'rgba(8,10,14,0.85)'); // weighted hem
      line3([x, y0, h], [x, y1, h], '#9aa3ad', 2.5);                                     // top pipe
      for (let y = y0 + 1; y < y1; y += 14) line3([x, y, 0], [x, y, h + 0.3], '#7d8793', 2); // support posts
    }
  }

  // Player bench along a sideline with a towel, a water bottle and a paddle bag
  function drawBench(x: number, y: number, facing: number) {
    const L = 3.2, D = 0.7, H = 1.5;
    const xi = x + facing * D; // edge facing the court
    fillPts([[xi, y - L, 0], [xi, y + L, 0], [xi, y + L, H], [xi, y - L, H]], '#5c3c22');
    fillPts([[x - D, y - L, H], [x + D, y - L, H], [x + D, y + L, H], [x - D, y + L, H]], '#9a6a3d');
    fillPts([[x - D, y + L, 0], [x + D, y + L, 0], [x + D, y + L, H], [x - D, y + L, H]], '#6e4828');
    fillPts([[x - 0.5, y - 1.8, H + 0.02], [x + 0.5, y - 1.8, H + 0.02], [x + 0.5, y - 0.4, H + 0.02], [x - 0.5, y - 0.4, H + 0.02]], '#f1f3f6'); // towel
    const bt = proj(x, y + 1.2, H), s = bt.s; // water bottle
    ctx.fillStyle = '#2f80ed';
    ctx.fillRect(bt.x - s * 0.13, bt.y - s * 0.75, s * 0.26, s * 0.75);
    ctx.fillStyle = '#e8edf3';
    ctx.fillRect(bt.x - s * 0.09, bt.y - s * 0.9, s * 0.18, s * 0.15);
    const bg = proj(x - facing * 1.5, y + 0.5, 0), s2 = bg.s; // paddle bag on the floor
    ctx.fillStyle = '#20252e';
    rr(bg.x - s2 * 0.9, bg.y - s2 * 1.1, s2 * 1.8, s2 * 1.1, s2 * 0.3);
    ctx.fill();
    ctx.fillStyle = '#d7f23b';
    ctx.fillRect(bg.x - s2 * 0.9, bg.y - s2 * 0.7, s2 * 1.8, s2 * 0.12);
  }

  // Pools of light from the ceiling panels on the court and floor
  function drawLightPools() {
    for (const l of LIGHTS) {
      if (l.y > hallNear() - 6) continue;
      const c = proj(l.x, l.y, 0);
      const r = c.s * 9;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(1, 0.42);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(255,248,220,0.13)');
      g.addColorStop(1, 'rgba(255,248,220,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  // ---------- court ----------
  // Regulation lines: 2 inches wide, white, painted inside the court's measurements
  // (the outer edge of each boundary line is the court's edge).
  const LINE_W = 2 / 12;
  function courtLine(x0: number, y0: number, x1: number, y1: number) {
    const w = LINE_W / 2;
    const q = x0 === x1 ? groundQuad(x0 - w, y0, x0 + w, y1) : groundQuad(x0, y0 - w, x1, y0 + w);
    fillPts(q, '#f6f8fb');
  }

  // Text painted flat on the court (like a stencilled logo)
  function paintText(text: string, x: number, y: number, sizeFt: number, color: string, weight = 900) {
    const p = proj(x, y, 0);
    const far = proj(x, y - 1, 0);
    const squash = clamp((p.y - far.y) / p.s, 0.2, 1); // foreshortening of the floor
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, squash);
    ctx.font = `${weight} ${Math.max(6, p.s * sizeFt)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // A tournament court: 20 x 44 ft, 7 ft non-volley zone ("kitchen") each side of the net,
  // centre lines from the kitchen line to the baseline, blue playing surface, lighter
  // kitchen, green surround (drawn in drawFloor).
  function drawCourtSurface() {
    fillPts(groundQuad(0, 0, COURT_W, COURT_L), '#2458a4');
    fillPts(groundQuad(0, TOP_KITCHEN, COURT_W, BOT_KITCHEN), '#2f6fbe');
    // lighting: the far end catches more of the overhead lights
    const far = proj(10, 0, 0), near = proj(10, COURT_L, 0);
    const lg = ctx.createLinearGradient(0, far.y, 0, near.y);
    lg.addColorStop(0, 'rgba(255,255,255,0.10)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    lg.addColorStop(1, 'rgba(0,0,0,0.10)');
    fillPts(groundQuad(0, 0, COURT_W, COURT_L), lg);
    // a faint border band just outside the lines, like the paint edge on real courts
    for (const [x0, y0, x1, y1] of [[-0.35, -0.35, COURT_W + 0.35, 0], [-0.35, COURT_L, COURT_W + 0.35, COURT_L + 0.35],
      [-0.35, 0, 0, COURT_L], [COURT_W, 0, COURT_W + 0.35, COURT_L]]) {
      fillPts(groundQuad(x0, y0, x1, y1), 'rgba(10,30,60,0.35)');
    }

    // boundary lines (inside the court), kitchen lines, centre lines
    const w = LINE_W / 2;
    courtLine(w, 0, w, COURT_L);
    courtLine(COURT_W - w, 0, COURT_W - w, COURT_L);
    courtLine(0, w, COURT_W, w);
    courtLine(0, COURT_L - w, COURT_W, COURT_L - w);
    courtLine(0, TOP_KITCHEN, COURT_W, TOP_KITCHEN);
    courtLine(0, BOT_KITCHEN, COURT_W, BOT_KITCHEN);
    courtLine(10, 0, 10, TOP_KITCHEN);
    courtLine(10, BOT_KITCHEN, 10, COURT_L);

    // stencils: KITCHEN in each non-volley zone, the event wordmark behind each baseline
    for (const ky of [TOP_KITCHEN + 3.5, BOT_KITCHEN - 3.5]) paintText('KITCHEN', 10, ky, 1.4, 'rgba(255,255,255,0.18)', 800);
    paintText('PICKLEBALL HYPER', 10, -4.2, 2.2, 'rgba(255,255,255,0.55)');
    paintText('PICKLEBALL HYPER', 10, COURT_L + 4.2, 2.2, 'rgba(255,255,255,0.4)');
  }

  // Animated highlights drawn over the (cached) court each frame
  function drawCourtOverlays() {
    if (state === 'serve' && serveBox) {
      const a = 0.12 + 0.08 * Math.sin(clock * 5);
      fillPts(groundQuad(serveBox.x0, serveBox.y0, serveBox.x1, serveBox.y1), `rgba(215,242,59,${a})`);
    }
    if (state === 'rally' && lastHitter === 'ai' && bounces === 0 && shots >= 3 && inKitchen('player', player.y)) {
      fillPts(groundQuad(0, NET_Y, COURT_W, BOT_KITCHEN), `rgba(255,80,80,${0.14 + 0.06 * Math.sin(clock * 14)})`);
    }
  }

  function drawNet() {
    const wobAt = (fx: number) => {
      if (net.wob <= 0) return 0;
      const d = Math.abs(fx - net.x);
      return Math.sin(d * 1.2 - clock * 30) * net.wob * 0.25 * Math.exp(-d * 0.18);
    };
    const L = proj(-1, NET_Y, 0), Rr = proj(COURT_W + 1, NET_Y, 0);
    const s = L.s;
    const zToY = (z: number) => L.y - z * s;

    // Regulation net: 36 in at the posts (22 ft apart, 1 ft outside each sideline),
    // sagging to 34 in at the centre where a white centre strap holds it down.
    const POST_H = 3.0, CENTER_H = 34 / 12;
    const topAt = netTopAt; // the same height the ball collides with

    // shadow on the ground
    fillPts(groundQuad(-1, NET_Y, COURT_W + 1, NET_Y + 1.1), 'rgba(0,0,0,0.18)');
    if (use3D) return; // the net itself is drawn by the 3D layer, in depth with the players
    // dark see-through mesh (tournament nets are black)
    ctx.fillStyle = 'rgba(8,10,14,0.42)';
    ctx.beginPath();
    for (let i = 0; i <= 44; i++) {
      const fx = -1 + i * 0.5;
      const X = L.x + (fx + 1) * s, Y = zToY(topAt(fx) + wobAt(fx));
      if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    }
    ctx.lineTo(Rr.x, zToY(0.05)); ctx.lineTo(L.x, zToY(0.05)); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(210,218,230,0.22)';
    ctx.lineWidth = Math.max(0.5, s * 0.03);
    ctx.beginPath();
    for (let fx = -1; fx <= COURT_W + 1; fx += 0.5) {
      const X = L.x + (fx + 1) * s;
      ctx.moveTo(X, zToY(0.12)); ctx.lineTo(X, zToY(topAt(fx) - 0.1 + wobAt(fx)));
    }
    for (let z = 0.3; z < CENTER_H; z += 0.4) { ctx.moveTo(L.x, zToY(z)); ctx.lineTo(Rr.x, zToY(z)); }
    ctx.stroke();
    // bottom band
    ctx.strokeStyle = 'rgba(20,24,32,0.9)';
    ctx.lineWidth = Math.max(1.5, s * 0.1);
    ctx.beginPath(); ctx.moveTo(L.x, zToY(0.08)); ctx.lineTo(Rr.x, zToY(0.08)); ctx.stroke();
    // centre strap (2 in wide, white)
    const cX = L.x + (COURT_W / 2 + 1) * s;
    ctx.fillStyle = '#f4f6f9';
    ctx.fillRect(cX - s * 0.085, zToY(CENTER_H + wobAt(COURT_W / 2)), s * 0.17, (CENTER_H + wobAt(COURT_W / 2)) * s);
    // white top tape (follows the sag), with a thin dark edge for depth
    for (const [col, wdt, dz] of [['rgba(0,0,0,0.35)', 0.26, -0.03], ['#ffffff', 0.2, 0]] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(2, s * wdt);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (let i = 0; i <= 44; i++) {
        const fx = -1 + i * 0.5;
        const X = L.x + (fx + 1) * s, Y = zToY(topAt(fx) - 0.08 + dz + wobAt(fx));
        if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      }
      ctx.stroke();
    }
    // round black posts with silver caps
    for (const X of [L.x, Rr.x]) {
      const pg = ctx.createLinearGradient(X - s * 0.16, 0, X + s * 0.16, 0);
      pg.addColorStop(0, '#3a414c'); pg.addColorStop(0.45, '#151a21'); pg.addColorStop(1, '#0b0e13');
      ctx.fillStyle = pg;
      ctx.fillRect(X - s * 0.15, zToY(POST_H + 0.12), s * 0.3, (POST_H + 0.12) * s);
      ctx.fillStyle = '#c9d0d8';
      ctx.fillRect(X - s * 0.17, zToY(POST_H + 0.2), s * 0.34, s * 0.1);
    }
  }

  // ---------- players ----------
  const PADDLE_RES = 28;

  // ---------- body poses ----------
  // Smooth curve through keyframes (Catmull-Rom), so swings flow instead of jerking
  function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  function sampleKeys(keys: number[][], t: number): number[] {
    const n = keys.length;
    if (t <= keys[0][0]) return keys[0].slice(1);
    if (t >= keys[n - 1][0]) return keys[n - 1].slice(1);
    let i = 0;
    while (t > keys[i + 1][0]) i++;
    const k = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
    const a = keys[Math.max(0, i - 1)], b = keys[i], c = keys[i + 1], d = keys[Math.min(n - 1, i + 2)];
    const out: number[] = [];
    for (let j = 1; j < b.length; j++) out.push(catmull(a[j], b[j], c[j], d[j], k));
    return out;
  }
  const mirrorKeys = (keys: number[][], k = 1) => keys.map(([t, u, z, w, a]) => [t, -u * k, z, w, -a]);

  // Paddle-hand paths: [t, u, z, w, angle°]
  //   u = across the body toward the paddle hand (ft), z = height (ft),
  //   w = toward the net (+) / away from it (-) (ft),
  //   angle: 0 tip up, 90 pointing out to the paddle side, 180 tip down.
  // Contact is around t = 0.45: slow backswing, fast swing, easing follow-through.
  const STROKES: Record<string, number[][]> = {
    drive_fh: [[0, 1.15, 3.3, -0.75, 110], [0.24, 1.2, 3.18, -0.62, 106], [0.45, 0.85, 3.5, 0.6, 72], [0.66, 0.25, 4.15, 0.8, 28], [1, -0.55, 4.9, 0.3, -35]],
    drive_bh: [[0, -0.95, 3.45, -0.4, -108], [0.24, -1.02, 3.35, -0.32, -102], [0.45, -0.65, 3.6, 0.6, -66], [0.66, -0.05, 4.1, 0.78, -20], [1, 0.75, 4.75, 0.3, 38]],
    dink_fh: [[0, 0.62, 2.6, -0.15, 150], [0.3, 0.66, 2.48, -0.1, 153], [0.5, 0.5, 2.56, 0.55, 140], [1, 0.36, 3.2, 0.85, 118]],
    volley_fh: [[0, 0.72, 4.15, 0.12, 50], [0.3, 0.8, 4.2, 0.02, 54], [0.45, 0.62, 4.15, 0.75, 34], [1, 0.52, 4.02, 0.85, 26]],
    lob_fh: [[0, 0.95, 2.45, -0.5, 140], [0.25, 1.0, 2.28, -0.45, 146], [0.45, 0.65, 2.62, 0.5, 120], [1, 0.25, 5.6, 0.4, 12]],
    smash: [[0, 0.5, 5.9, -0.6, 195], [0.25, 0.48, 6.05, -0.72, 200], [0.4, 0.5, 6.6, 0.3, 8], [0.6, 0.35, 5.4, 0.8, -40], [1, -0.45, 3.4, 0.5, -120]],
    // underhand pendulum: paddle back and low, face meets the dropped ball below the waist in
    // front of the paddle-side hip (t = SERVE_CONTACT_T), then low-to-high toward the target
    serve: [[0, 0.85, 2.7, -0.45, 170], [0.22, 0.95, 2.55, -1.0, 162], [0.45, 0.55, 2.85, 0.75, 172], [0.68, 0.45, 3.7, 1.05, 105], [1, 0.2, 4.8, 0.6, 25]],
  };
  STROKES.dink_bh = mirrorKeys(STROKES.dink_fh, 0.88);
  STROKES.volley_bh = mirrorKeys(STROKES.volley_fh, 0.75);
  STROKES.lob_bh = mirrorKeys(STROKES.lob_fh, 0.85);

  // Whole body per stroke (forehand view; mirrored for backhands)
  //   off   = free-hand path [t, u, z, w]
  //   step  = which foot steps toward the net during the swing, and how far (ft)
  //   crouch1 / lean1 = where the legs and trunk finish (lob: legs drive up; smash: fold down through the ball)
  interface BodyDef { crouch: number; lean: number; crouch1?: number; lean1?: number; stance: number; turn0: number; turn1: number; step: 'off' | 'dom'; stepW: number; off: number[][] }
  const BODY: Record<string, BodyDef> = {
    // athletic stance, step in, firm swing, weight through the ball
    drive: { crouch: 0.48, lean: 0.28, crouch1: 0.38, lean1: 0.45, stance: 0.86, turn0: 0.85, turn1: -0.5, step: 'off', stepW: 0.55,
      off: [[0, -0.2, 4.0, 0.5], [0.45, -0.6, 4.1, 0.3], [1, -1.0, 4.2, -0.2]] },
    volley: { crouch: 0.5, lean: 0.35, stance: 0.82, turn0: 0.3, turn1: -0.1, step: 'off', stepW: 0.25,
      off: [[0, 0.0, 3.9, 0.6], [1, -0.55, 4.0, 0.4]] },
    // low stance, soft short swing, balanced
    dink: { crouch: 0.82, lean: 0.5, crouch1: 0.76, lean1: 0.52, stance: 0.95, turn0: 0.25, turn1: -0.1, step: 'dom', stepW: 0.45,
      off: [[0, -1.0, 3.0, 0.2], [1, -1.1, 3.1, 0.1]] },
    // open stance, paddle low to high, the legs lift the ball
    lob: { crouch: 0.66, lean: 0.32, crouch1: 0.14, lean1: 0.02, stance: 0.92, turn0: 0.5, turn1: -0.4, step: 'off', stepW: 0.3,
      off: [[0, -0.7, 3.3, 0.3], [1, -0.95, 4.6, 0]] },
    // tall, reach up, full swing, hit down
    smash: { crouch: 0.06, lean: -0.18, crouch1: 0.32, lean1: 0.48, stance: 0.66, turn0: 0.75, turn1: -0.6, step: 'off', stepW: 0.25,
      off: [[0, -0.3, 6.3, 0.5], [0.4, -0.4, 6.0, 0.4], [1, -0.75, 3.6, -0.2]] },
    serve: { crouch: 0.26, lean: 0.2, crouch1: 0.14, lean1: 0.3, stance: 0.62, turn0: 0.45, turn1: -0.4, step: 'off', stepW: 0.35,
      off: [[0, 0.4, 3.1, 0.6], [0.35, 0.42, 2.85, 0.6], [1, -0.8, 3.7, 0]] },
  };

  // Receiving stances (what is coming decides the stance):
  // Ready: knees bent, weight forward, paddle up in front, free hand near the paddle
  const READY: Pose = { hand: [0.4, 3.85, 0.7, 14], off: [0.02, 3.95, 0.6], crouch: 0.44, lean: 0.32, stance: 0.86, turn: 0, step: [0, 0, 0, 0] };
  // vs a drive: athletic, paddle in front of the chest, ready to counter
  const READY_DRIVE: Pose = { hand: [0.32, 3.6, 0.95, 24], off: [-0.06, 3.7, 0.8], crouch: 0.52, lean: 0.38, stance: 0.92, turn: 0, step: [0, 0, 0, 0] };
  // vs a dink: low, soft paddle out in front near the knees, ready to block gently
  // (paddle out in front, tip forward and slightly up, face open: like a real dink ready position)
  const READY_LOW: Pose = { hand: [0.34, 3.0, 1.0, 38], off: [-0.22, 3.15, 0.8], crouch: 0.74, lean: 0.46, stance: 0.98, turn: 0, step: [0, 0, 0, 0] };
  // vs a lob / high ball: tall and ready high, paddle up, prepared for an overhead
  const READY_HIGH: Pose = { hand: [0.5, 4.9, 0.35, 6], off: [-0.25, 4.6, 0.45], crouch: 0.26, lean: 0.12, stance: 0.82, turn: 0.2, step: [0, 0, 0, 0] };
  // Between points: relaxed, paddle hanging by the side
  const IDLE: Pose = { hand: [0.72, 3.0, 0.05, 168], off: [-0.66, 3.0, 0], crouch: 0.06, lean: 0.04, stance: 0.48, turn: 0, step: [0, 0, 0, 0] };
  const CHEER: Pose = { hand: [0.5, 6.5, 0, 8], off: [-0.5, 6.4, 0], crouch: 0, lean: -0.05, stance: 0.55, turn: 0, step: [0, 0, 0, 0] };
  // Server waiting: staggered feet (front foot opposite the paddle), paddle back and low,
  // ball held out in front in the free hand (the hand follows the ball, see drawAthlete)
  const SERVE_WAIT: Pose = { hand: [0.85, 2.7, -0.45, 170], off: [-0.74, 3.0, 0.7], crouch: 0.26, lean: 0.2, stance: 0.62, turn: 0.35, step: [-0.15, 0.45, 0, 0] };

  function strokePose(kind: string, t: number): Pose {
    const base = kind.split('_')[0];
    const bh = kind.endsWith('_bh');
    const B = BODY[base] || BODY.drive;
    const h = sampleKeys(STROKES[kind] || STROKES.drive_fh, t);
    const o = sampleKeys(B.off, t);
    if (bh) o[0] = -o[0];
    const transfer = ease(clamp(t / 0.5, 0, 1));            // weight moves forward into contact
    const lift = t < 0.4 ? Math.sin(Math.PI * (t / 0.4)) * 0.16 : 0;
    const stepDom = (B.step === 'dom') !== bh;             // backhands step with the other foot
    const sw = B.stepW * transfer;
    return {
      hand: h,
      off: o,
      crouch: lerp(B.crouch, B.crouch1 ?? B.crouch, ease(clamp(t, 0, 1))),
      lean: lerp(B.lean, B.lean1 ?? B.lean, ease(clamp(t, 0, 1))) + 0.1 * Math.sin(Math.PI * clamp(t, 0, 1)),
      stance: B.stance,
      turn: lerp(B.turn0, B.turn1, ease(clamp(t, 0, 1))) * (bh ? -1 : 1),
      step: stepDom ? [sw, -0.12 * transfer, lift, 0] : [-0.12 * transfer, sw, 0, lift],
    };
  }

  function clonePose(a: Pose): Pose {
    return { hand: a.hand.slice(), off: a.off.slice(), crouch: a.crouch, lean: a.lean, stance: a.stance, turn: a.turn, step: a.step.slice() };
  }
  // Blend pose a toward b by t (in place on `into`)
  function blendPose(into: Pose, a: Pose, b: Pose, t: number): Pose {
    for (const key of ['hand', 'off', 'step'] as const) for (let i = 0; i < a[key].length; i++) into[key][i] = lerp(a[key][i], b[key][i], t);
    for (const key of ['crouch', 'lean', 'stance', 'turn'] as const) into[key] = lerp(a[key], b[key], t);
    return into;
  }

  // ---- the paddle goes to the ball ----
  const CONTACT_T = 0.45; // contact point inside every stroke path
  const smooth01 = (a: number, b: number, x: number) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  /** A world point in this athlete's body coordinates [u toward the paddle hand, z, w toward the net]. */
  function toBody(p: Athlete, x: number, y: number, z: number): number[] {
    return [(x - p.x) * domSign(p), z, (y - p.y) * (p.team === 'ai' ? 1 : -1)];
  }
  /** Where the paddle face is for a hand [u, z, w, angle]: the face centre sits 0.66 ft out along the paddle. */
  function faceOf(hand: number[]): number[] {
    const a = (hand[3] * Math.PI) / 180;
    return [hand[0] + Math.sin(a) * 0.66, hand[1] + Math.cos(a) * 0.66, hand[2]];
  }
  /**
   * Bend a stroke so the paddle face really meets the ball: the hand path is shifted
   * toward the contact point (most at contact, none at the start and end of the
   * swing), and the legs bend for a low ball / stretch for a high one, like a player.
   */
  function reachFor(pose: Pose, kind: string, target: number[], k: number) {
    if (k <= 0.001) return pose;
    const key = sampleKeys(STROKES[kind] || STROKES.drive_fh, CONTACT_T);
    // a low ball: the paddle tips down to scoop under it (forehand angles are positive, backhand negative)
    const low = kind === 'smash' ? 0 : clamp((1.7 - target[1]) / 1.3, 0, 1);
    if (low > 0) {
      const sg = key[3] >= 0 ? 1 : -1;
      const tipped = sg * lerp(Math.abs(key[3]), 148, low);
      pose.hand[3] += (tipped - key[3]) * k;
      key[3] = tipped;
    }
    const f = faceOf(key);
    const du = clamp(target[0] - f[0], -1.6, 1.6);
    const dz = clamp(target[1] - f[1], -3.2, 2.4);
    const dw = clamp(target[2] - f[2], -1.8, 2.2); // late contact: reach back
    pose.hand[0] += du * k;
    pose.hand[1] += dz * k;
    pose.hand[2] += dw * k;
    if (dz < -0.3) { // bend the knees (and a little the waist), not just the arm
      pose.crouch = Math.min(1, pose.crouch + Math.min(0.5, (-dz - 0.3) * 0.34) * k);
      pose.lean += Math.min(0.2, (-dz - 0.3) * 0.08) * k;
    }
    else if (dz > 0.8) pose.crouch = Math.max(0, pose.crouch - Math.min(0.25, (dz - 0.8) * 0.15) * k);
    pose.lean += clamp(-dz * 0.05, -0.08, 0.12) * k;
    return pose;
  }
  /** Where the incoming ball should meet this player's paddle (body coordinates), or null. */
  function predictedContact(p: Athlete): number[] | null {
    if (ball.held || ball.netted || Math.abs(ball.vy) < 1) return null;
    const lineY = p.y + (p.team === 'player' ? -CONTACT_IDEAL * 0.6 : CONTACT_IDEAL * 0.6);
    let tt = (lineY - ball.y) / ball.vy;
    if (tt < 0 || tt > 1.6) tt = 0;
    const g = ball.g || G;
    let z = ball.z + ball.vz * tt - 0.5 * g * tt * tt;
    if (z < 0) z = Math.min(3.5, -z * BOUNCE_Z + 0.6); // it will bounce first: roughly where it comes up to
    return toBody(p, ball.x + ball.vx * tt, ball.y + ball.vy * tt, clamp(z, 0.4, 7));
  }

  function poseFor(p: Athlete): Pose {
    if (p.cheer > 0) return CHEER;
    if (p.stroke) {
      const pose = strokePose(p.stroke, p.strokeT);
      if (p.cpt && p.stroke !== 'serve') {
        const t = p.strokeT;
        const k = t < CONTACT_T ? smooth01(0.1, CONTACT_T, t) : 1 - smooth01(CONTACT_T + 0.05, 0.85, t);
        reachFor(pose, p.stroke, toBody(p, p.cpt.x, p.cpt.y, p.cpt.z), k);
      }
      return pose;
    }
    const st = state === 'paused' ? pausedFrom : state; // hold the pose while paused
    if (st === 'serve' && p === serverAth) return SERVE_WAIT;
    const active = st === 'rally' || st === 'serve';
    const base = active ? receivePose(p, st) : IDLE;
    if (p.prep > 0.01) { // early backswing, set at the height the ball will arrive
      const pose = blendPose(clonePose(base), base, strokePose(p.prepKind, 0), p.prep);
      const c = predictedContact(p);
      if (c) {
        const f = faceOf(sampleKeys(STROKES[p.prepKind] || STROKES.drive_fh, CONTACT_T));
        const dz = clamp(c[1] - f[1], -2, 2);
        pose.hand[1] += dz * 0.6 * p.prep;
        pose.hand[0] += clamp(c[0] - f[0], -1, 1) * 0.3 * p.prep;
        if (dz < -0.3) pose.crouch = Math.min(0.9, pose.crouch + Math.min(0.3, (-dz - 0.3) * 0.25) * p.prep);
      }
      return pose;
    }
    return base;
  }

  /** The receiving stance for what the other side is sending (or a plain ready stance). */
  function receivePose(p: Athlete, st: string): Pose {
    const incoming = st === 'rally' && !!lastHitter && lastHitter !== p.team && !ball.netted && !ball.held;
    if (!incoming) return READY;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (ball.z > 6.5 || ball.vz > 12) return READY_HIGH;                     // lob / high ball
    if (speed < 24 && Math.abs(p.y - NET_Y) < 11 && ball.z < 4) return READY_LOW; // soft ball at the kitchen
    if (speed > 36) return READY_DRIVE;                                      // hard drive
    return READY;
  }

  // Ease every athlete's displayed pose toward its target so movements flow.
  // Critically damped springs: limbs accelerate out of a pose and settle into the next
  // one like a body does (no robotic snap at the start, no overshoot at the end).
  function springTo(x: number[], v: number[], t: number[], w: number, dt: number) {
    const e = Math.exp(-w * dt);
    for (let i = 0; i < x.length; i++) {
      const d = x[i] - t[i], k = v[i] + w * d;
      x[i] = t[i] + (d + k * dt) * e;
      v[i] = (v[i] - w * k * dt) * e;
    }
  }
  function updatePoseSmoothing(p: Athlete, dt: number) {
    const target = poseFor(p);
    if (!p.vis || !p.visV) {
      p.vis = clonePose(target);
      p.visV = { hand: [0, 0, 0, 0], off: [0, 0, 0], crouch: 0, lean: 0, stance: 0, turn: 0, step: [0, 0, 0, 0] };
      return;
    }
    const V = p.visV, X = p.vis;
    const swing = !!p.stroke;
    // the paddle hand during a swing: a fast direct follow, so the face is at the ball on contact
    if (swing) {
      const r = p.strokeT < 0.6 ? 50 : 22;
      const k = 1 - Math.exp(-dt * r);
      for (let i = 0; i < 4; i++) { X.hand[i] = lerp(X.hand[i], target.hand[i], k); V.hand[i] = 0; }
    } else springTo(X.hand, V.hand, target.hand, p.cheer > 0 ? 9 : 13, dt);
    // free arm trails the body a little; legs and trunk carry the weight
    const wb = swing ? 17 : p.cheer > 0 ? 8 : 10.5;
    springTo(X.off, V.off, target.off, wb * 0.9, dt);
    springTo(X.step, V.step, target.step, wb * 1.1, dt);
    const a = [X.crouch, X.lean, X.stance, X.turn], av = [V.crouch, V.lean, V.stance, V.turn];
    springTo(a, av, [target.crouch, target.lean, target.stance, target.turn], wb, dt);
    [X.crouch, X.lean, X.stance, X.turn] = a;
    [V.crouch, V.lean, V.stance, V.turn] = av;
  }

  // Two-bone limb (hip-knee-ankle, shoulder-elbow-hand) solved in 3D body space
  // [u toward the paddle hand, z up, w toward the net]. `pole` is the way the middle
  // joint points (knees forward and a little out, elbows down and back), so a bend
  // foreshortens like a real limb when it is projected.
  function ik3(a: number[], b: number[], L1: number, L2: number, pole: number[]) {
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    let d = Math.hypot(dx, dy, dz) || 0.001;
    const max = (L1 + L2) * 0.998;
    let e = b;
    if (d > max) { const k = max / d; dx *= k; dy *= k; dz *= k; d = max; e = [a[0] + dx, a[1] + dy, a[2] + dz]; }
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const along = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    const pd = pole[0] * ux + pole[1] * uy + pole[2] * uz;
    let px = pole[0] - ux * pd, py = pole[1] - uy * pd, pz = pole[2] - uz * pd;
    let pl = Math.hypot(px, py, pz);
    if (pl < 1e-4) { px = -uy; py = ux; pz = 0; pl = Math.hypot(px, py) || 1; }
    return { j: [a[0] + ux * along + (px / pl) * h, a[1] + uy * along + (py / pl) * h, a[2] + uz * along + (pz / pl) * h], e };
  }

  let heldBallDrawn = false;
  function drawAthlete(p: Athlete, decalsOnly = false) {
    const av = legacy2D(p.avatar);
    const away = p.team === 'player';      // your team shows its back to the camera
    const dom = domSign(p);                // screen side of the paddle hand
    const fs = away ? 1 : -1;              // net side is up the screen for you, down for the bots
    const g = proj(p.x, p.y, 0);
    const s = g.s;
    const K = cam.h / Math.max(5, cam.y - p.y); // how much 1 ft toward the net rises on screen
    const pose = p.vis || poseFor(p);
    const skin = av.skin, shirt = av.shirt;
    const st = state === 'paused' ? pausedFrom : state;
    const inRally = st === 'rally';

    // ----- locomotion amounts (all smoothed in animatePerson) -----
    const loco = (p.loco || 0) * (p.stroke ? 0.3 : 1) * (p.cheer > 0 ? 0 : 1);
    const run = p.runFrac || 0;
    const shuffle = clamp(p.latFrac || 0, 0, 1) * (inRally ? 1 : 0) * (1 - 0.6 * run);
    const gaitK = loco * (1 - shuffle);
    const shufK = loco * shuffle;
    const dirX = p.dirX || 0, dirW = p.dirW || 0;
    const travelU = Math.sign(p.vx || 0) * dom; // shuffle direction in body coordinates

    // Gait cycle: each foot plants and rolls back, then lifts and swings through
    const footCycle = (side: number) => {
      const c = wrap01((p.gait || 0) / (Math.PI * 2) + (side > 0 ? 0 : 0.5));
      if (c < 0.5) return { along: lerp(0.5, -0.5, c / 0.5), lift: 0 };
      const q = (c - 0.5) / 0.5;
      return { along: lerp(-0.5, 0.5, ease(q)), lift: Math.sin(Math.PI * q) };
    };
    // Side-shuffle: lead foot reaches, trail foot gathers — never crossing
    const shufC = wrap01((p.gait || 0) / (Math.PI * 2));
    const shuffleFoot = (lead: boolean) => {
      if (lead) return shufC < 0.5 ? { off: ease(shufC / 0.5), lift: Math.sin((Math.PI * shufC) / 0.5) } : { off: 1 - (shufC - 0.5) / 0.5, lift: 0 };
      return shufC < 0.5 ? { off: -shufC / 0.5, lift: 0 } : { off: -(1 - ease((shufC - 0.5) / 0.5)), lift: 0.6 * Math.sin((Math.PI * (shufC - 0.5)) / 0.5) };
    };

    const domStep = footCycle(1);
    const domFwd = domStep.along * 2 * gaitK; // -1..1, how far forward the paddle-side foot is

    // body bob, hip sway, lean
    const hopJ = p.jump > 0 ? Math.sin((1 - p.jump) * Math.PI) * 1.0 : 0;
    const hopS = p.split > 0 ? Math.sin((1 - p.split) * Math.PI) * 0.3 : 0;
    const bob = gaitK * lerp(0.04, 0.13, run) * (0.5 - 0.5 * Math.cos(2 * (p.gait || 0))) + shufK * 0.06 * Math.abs(Math.sin(Math.PI * 2 * shufC));
    const lift = hopJ + hopS + bob;
    const hipSway = gaitK * 0.07 * Math.sin(p.gait || 0) + shufK * 0.09 * travelU;
    const crouch = pose.crouch + shufK * 0.12 - gaitK * run * 0.12;
    const lean = pose.lean + gaitK * run * 0.14;
    const turn = pose.turn + gaitK * 0.12 * Math.sin(p.gait || 0);
    const breathe = inRally ? 0 : Math.sin(clock * 2 + p.x) * 0.02;
    const latLean = clamp(p.vx, -15, 15) * 0.01;

    // body coords -> screen (u across toward paddle hand, z up, w toward the net)
    const S2 = (u: number, z: number, w = 0): number[] => [
      g.x + (u * dom + (z > 2.6 ? latLean * (z - 2.6) * 0.5 : 0)) * s,
      g.y - (z + lift + w * K * fs) * s,
    ];

    // ----- shadow and "you" ring -----
    const shK = 1 - hopJ * 0.2;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(g.x + s * 0.25, g.y + s * 0.05, s * 0.95 * shK, s * 0.3 * shK, 0, 0, Math.PI * 2);
    ctx.fill();
    if (p.human && p.en.hyperT > 0) { // Hyper mode: electric ring under the player
      const pulse = 0.5 + 0.5 * Math.sin(clock * 14);
      ctx.strokeStyle = `rgba(124,242,255,${0.6 + 0.35 * pulse})`;
      ctx.lineWidth = Math.max(2, s * 0.14);
      groundEllipsePath(p.x, p.y, 1.6 + pulse * 0.35, 1.6 + pulse * 0.35);
      ctx.stroke();
      ctx.fillStyle = `rgba(124,242,255,${0.14 + 0.08 * pulse})`;
      groundEllipsePath(p.x, p.y, 2.2, 2.2);
      ctx.fill();
    }
    if (p === player && p.queued && p.swing > 0) { // a shot is ready and waiting for the ball
      const r = 1.95 + 0.25 * Math.sin(clock * 12);
      ctx.strokeStyle = 'rgba(215,242,59,0.9)';
      ctx.lineWidth = Math.max(2, s * 0.12);
      groundEllipsePath(p.x, p.y, r, r);
      ctx.stroke();
    }
    if (p.human) {
      ctx.strokeStyle = `rgba(255,255,255,${0.65 + 0.25 * Math.sin(clock * 4)})`;
      ctx.lineWidth = Math.max(1.5, s * 0.09);
      groundEllipsePath(p.x, p.y, 1.35, 1.35);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(58,160,255,0.55)';
      groundEllipsePath(p.x, p.y, 1.75, 1.75);
      ctx.stroke();
    }
    if (decalsOnly) return; // 3D players: only the shadow and rings on the ground are drawn here
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // ===== a 3D skeleton in body space [u, z, w], projected with S2 =====
    // Real proportions for a ~5'10" player: hip joint ~2.9 ft, shoulders ~4.7 ft,
    // head ~0.6 ft wide; limbs are tapered and shaded so the figure reads as a solid body.
    const P = (v: number[]) => S2(v[0], v[1], v[2]);
    const fem = av.gender === 'female';
    const lerp3 = (a: number[], b: number[], t: number) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    const lerp2 = (a: number[], b: number[], t: number) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
    // rotate an offset (u, w) around the vertical axis by a, then add it to c
    const rotY = (c: number[], u: number, z: number, w: number, a: number) =>
      [c[0] + u * Math.cos(a) + w * Math.sin(a), c[1] + z, c[2] - u * Math.sin(a) + w * Math.cos(a)];
    const THIGH = 1.42, SHIN = 1.36, ANKLE = 0.27, UPPER = 1.0, FORE = 0.98;

    // A tapered, shaded body segment (thigh, calf, upper arm...): rounded ends, a muscle
    // bulge near `at`, lit from the upper left like the court lights.
    const rich = quality > 0;
    const seg = (a: number[], b: number[], ra: number, rb: number, col: string, bulge = 0, at = 0.35) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 0.001;
      const nx = -dy / L, ny = dx / L;
      const RA = Math.max(0.6, ra * s), RB = Math.max(0.6, rb * s);
      const rm = lerp(RA, RB, at) * (1 + bulge);
      const co = Math.max(rm, 2 * rm - (RA + RB) / 2);
      const mx = a[0] + dx * at, my = a[1] + dy * at;
      const th = Math.atan2(ny, nx);
      if (rich) {
        const ls = nx * -0.55 + ny * -0.83 > 0 ? 1 : -1; // the side facing the light
        const gr = ctx.createLinearGradient(mx + nx * rm * ls, my + ny * rm * ls, mx - nx * rm * ls, my - ny * rm * ls);
        gr.addColorStop(0, shade(col, 0.16)); gr.addColorStop(0.42, col); gr.addColorStop(1, shade(col, -0.3));
        ctx.fillStyle = gr;
      } else ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(a[0] + nx * RA, a[1] + ny * RA);
      ctx.quadraticCurveTo(mx + nx * co, my + ny * co, b[0] + nx * RB, b[1] + ny * RB);
      ctx.arc(b[0], b[1], RB, th, th + Math.PI, true);
      ctx.quadraticCurveTo(mx - nx * co, my - ny * co, a[0] - nx * RA, a[1] - ny * RA);
      ctx.arc(a[0], a[1], RA, th + Math.PI, th, true);
      ctx.closePath();
      ctx.fill();
    };

    // ----- feet -----
    const stanceNow = lerp(pose.stance, 0.36, gaitK * 0.85) + (p.split > 0 ? 0.15 * (1 - p.split) : 0);
    const feet = [-1, 1].map(side => {
      let u = side * stanceNow;
      let w = side > 0 ? pose.step[0] : pose.step[1];
      let z = side > 0 ? pose.step[2] : pose.step[3];
      // walking / running
      const fc = footCycle(side);
      const stride = lerp(0.9, 2.1, run) * gaitK;
      u += dirX * dom * fc.along * stride;
      w += dirW * fc.along * stride;
      z += fc.lift * lerp(0.22, 0.62, run) * gaitK;
      // shuffling
      if (shufK > 0.01) {
        const lead = (side > 0) === (travelU > 0);
        const sf = shuffleFoot(lead);
        u += travelU * sf.off * 0.55 * shufK;
        z += sf.lift * 0.22 * shufK;
      }
      return { side, u, w, z, kick: fc.lift * gaitK };
    });
    // farther foot first
    feet.sort((a, b) => (away ? b.w - a.w : a.w - b.w));

    // ----- pelvis: sits back as the knees bend (athletic stance), turns less than the shoulders -----
    const hipTurn = turn * 0.42;
    const hipBack = -crouch * 0.3;
    const hipHW = fem ? 0.3 : 0.28;
    const hipJoint = (side: number, z: number) => rotY([hipSway, z, hipBack], side * hipHW, 0, 0, hipTurn);
    let hipZ = 2.92 - crouch * 0.62 + breathe;
    // a wide stance or a long stride lowers the pelvis, so planted feet stay on the floor
    const maxLeg = (THIGH + SHIN) * 0.985;
    for (const f of feet) {
      const h = hipJoint(f.side, 0);
      const dh = Math.hypot(f.u - h[0], f.w - h[2]);
      if (dh < maxLeg) hipZ = Math.min(hipZ, f.z + ANKLE + Math.sqrt(maxLeg * maxLeg - dh * dh));
    }
    const legs = feet.map(f => {
      const hip = hipJoint(f.side, hipZ);
      const k = ik3(hip, [f.u, f.z + ANKLE, f.w], THIGH, SHIN, [f.side * 0.62, 0.05, 1]); // knees forward and out over the toes
      return { f, ank3: k.e, hip: P(hip), knee: P(k.j), foot: P(k.e) };
    });
    const shoe = SHOES[av.shoes] || SHOES.white;
    const guard = (c: string) => !!c && c !== 'none';
    const shortsC = av.shortsColor || shade(shirt, -0.62);
    const sStyle = av.shortsStyle || 'classic';
    const sLen = ({ classic: 0.5, long: 0.78, compression: 0.38, skort: 0.25 } as Record<string, number>)[sStyle] ?? 0.5;
    const legSkin = shade(skin, -0.03);
    for (const L of legs) {
      const f = L.f, ank = L.ank3;
      // shoe: heel to toe along the foot, toes turned a little out; it rolls onto the toes as it lifts
      const heelUp = f.kick > 0.25 || f.z > 0.12;
      const pitch = heelUp ? 0.2 : 0;
      const floorZ = ank[1] - ANKLE;
      const heel = P([ank[0] - f.side * 0.03, floorZ + 0.13 + pitch, ank[2] - 0.24]);
      const toe = P([ank[0] + f.side * 0.1, floorZ + 0.1 - pitch * 0.4, ank[2] + 0.46]);
      seg([heel[0], heel[1] + s * 0.05], [toe[0], toe[1] + s * 0.05], 0.14, 0.13, shoe.sole);
      seg(heel, toe, 0.14, 0.125, shoe.upper);
      ctx.strokeStyle = shoe.accent;
      ctx.lineWidth = Math.max(1, s * 0.05);
      ctx.beginPath(); ctx.moveTo(lerp(heel[0], toe[0], 0.2), lerp(heel[1], toe[1], 0.2) - s * 0.02); ctx.lineTo(lerp(heel[0], toe[0], 0.75), lerp(heel[1], toe[1], 0.75) - s * 0.02); ctx.stroke();
      // calf (muscle high on the shin), sock, thigh
      seg(L.knee, L.foot, 0.17, 0.09, shade(skin, -0.09), 0.26, 0.28);
      seg(L.foot, lerp2(L.foot, L.knee, 0.2), 0.095, 0.11, '#f3f3f0');
      seg(L.hip, L.knee, 0.265, 0.17, legSkin, 0.1, 0.3);
      if (guard(av.kneeGuard)) seg(lerp2(L.hip, L.knee, 0.8), lerp2(L.knee, L.foot, 0.22), 0.2, 0.185, av.kneeGuard);
      if (sStyle !== 'skort') seg(L.hip, lerp2(L.hip, L.knee, sLen), 0.29, sStyle === 'compression' ? 0.21 : 0.255, shortsC);
    }
    // shorts / skort over the pelvis
    const pc = [hipSway, hipZ, hipBack];
    const skirt = sStyle === 'skort';
    const pp = (u: number, z: number) => P(rotY(pc, u, z, 0, hipTurn));
    const wbL = pp(-(hipHW + 0.2), 0.36), wbR = pp(hipHW + 0.2, 0.36);
    const hpL = pp(-(hipHW + (skirt ? 0.42 : 0.27)), skirt ? -0.78 : -0.08), hpR = pp(hipHW + (skirt ? 0.42 : 0.27), skirt ? -0.78 : -0.08);
    const crotch = pp(0, skirt ? -0.92 : -0.34);
    ctx.fillStyle = shortsC;
    ctx.beginPath();
    ctx.moveTo(wbL[0], wbL[1]); ctx.lineTo(wbR[0], wbR[1]); ctx.lineTo(hpR[0], hpR[1]);
    ctx.quadraticCurveTo(crotch[0], crotch[1], hpL[0], hpL[1]);
    ctx.closePath(); ctx.fill();
    seg(wbL, wbR, 0.06, 0.06, shade(shortsC, -0.25)); // waistband

    // ----- trunk: leans from the hips toward the net, shoulders turn more than the hips -----
    const pelvTop = [hipSway, hipZ + 0.22, hipBack];
    const TORSO = 1.56;
    const spZ = Math.cos(lean), spW = Math.sin(lean);
    const along = (k: number) => [pelvTop[0], pelvTop[1] + spZ * TORSO * k, pelvTop[2] + spW * TORSO * k];
    const shC3 = along(1);
    const halfW = fem ? 0.54 : 0.6;
    const midTurn = (turn + hipTurn) / 2;
    const dip = clamp((pose.hand[1] - 3.7) * 0.07, -0.14, 0.1); // the paddle shoulder drops for a low ball
    const shoulderDom = rotY(shC3, halfW, dip, 0, turn), shoulderOff = rotY(shC3, -halfW, -dip * 0.5, 0, turn);
    const bodyW = shC3[2] * 0.6 + hipBack * 0.4;
    const shirtStyle = av.shirtStyle || 'polo';
    const trim = av.shirtAccent || '#f5f5f2';
    const tank = shirtStyle === 'tank';

    // ----- arms -----
    const hand = pose.hand.slice();
    let off = pose.off.slice();
    if (gaitK > 0.01) {
      // free arm swings opposite the paddle-side leg; elbow bends more when running
      const armWalk = [-0.62, 3.05 + 0.08 * Math.abs(domFwd), 0.45 * domFwd];
      const armRun = [-0.5, 3.7 + 0.25 * domFwd, 0.75 * domFwd];
      const tgt = [lerp(armWalk[0], armRun[0], run), lerp(armWalk[1], armRun[1], run), lerp(armWalk[2], armRun[2], run)];
      const k = gaitK * (inRally ? 0.75 : 1);
      off = [lerp(off[0], tgt[0], k), lerp(off[1], tgt[1], k), lerp(off[2], tgt[2], k)];
      // paddle arm: keeps the paddle up in a rally, swings loosely otherwise
      if (inRally) { hand[1] += 0.06 * Math.sin(2 * (p.gait || 0)) * gaitK; hand[2] -= 0.25 * domFwd; }
      else { hand[2] -= 0.4 * domFwd; }
    }
    if (shufK > 0.01) { hand[1] += 0.05 * Math.sin(Math.PI * 2 * shufC) * shufK; }
    // Serving: the free hand holds the ball out in front, carries it across and lets it drop
    const winding = !!serveWind && serveWind.who === p;
    const servingBall = st === 'serve' && p === serverAth && ball.held && (!p.stroke || winding);
    let ballW = 0; // the ball's distance in front of the body (toward the net)
    if (servingBall) {
      ballW = (ball.y - p.y) * (p.team === 'ai' ? 1 : -1);
      const wt = winding ? (serveWind as { t: number }).t : -1;
      if (wt >= SERVE_CARRY) { // let go: the open hand stays up, then clears the swing
        const k = clamp((wt - SERVE_CARRY) / SERVE_FALL, 0, 1);
        off = [lerp(SERVE_RELEASE[0] - 0.12, -0.3, ease(k)), SERVE_RELEASE[1] - 0.18 - 0.35 * k, lerp(SERVE_RELEASE[2], 0.45, k)];
      } else { // palm under the ball, exactly where the ball is drawn
        const bp = proj(ball.x, ball.y, ball.z);
        off = [((bp.x - g.x) / s) * dom, (g.y - bp.y) / s - lift - ballW * K * fs - 0.18, ballW];
      }
    }

    const arm = (sh0: number[], tgt: number[], side: number) => {
      let sh = sh0;
      // a long reach pulls the shoulder blade along instead of leaving the hand short
      const d = Math.hypot(tgt[0] - sh[0], tgt[1] - sh[1], tgt[2] - sh[2]);
      const max = (UPPER + FORE) * 0.98;
      if (d > max) sh = lerp3(sh, tgt, Math.min(0.42, d - max) / d);
      const up = clamp((tgt[1] - sh[1]) / 1.1, 0, 1);        // hand above the shoulder: elbow out and up
      const across = clamp((-tgt[0] * side) / 0.7, 0, 1);   // hand across the body: elbow forward
      const pole = [
        side * lerp(lerp(0.5, 0.85, up), -0.15, across),
        lerp(lerp(-1, 0.3, up), -0.5, across),
        lerp(lerp(-0.4, -0.45, up), 0.7, across),
      ];
      const j = ik3(sh, tgt, UPPER, FORE, pole);
      return { sh: P(sh), el: P(j.j), hd: P(j.e) };
    };
    const offArm = arm(shoulderOff, off, -1);
    const domArm = arm(shoulderDom, hand, 1);
    type ArmPts = ReturnType<typeof arm>;

    const drawLimbs = (A: ArmPts) => {
      seg(A.el, A.hd, 0.1, 0.068, shade(skin, -0.06), 0.16, 0.25);   // forearm
      seg(A.sh, A.el, 0.15, 0.1, shade(skin, -0.01), 0.12, 0.35);    // upper arm
      if (guard(av.elbowGuard)) seg(lerp2(A.sh, A.el, 0.8), lerp2(A.el, A.hd, 0.22), 0.145, 0.13, av.elbowGuard);
      if (tank) { seg(A.sh, lerp2(A.sh, A.el, 0.32), 0.17, 0.15, skin); return; } // bare deltoid
      const end = lerp2(A.sh, A.el, 0.5);
      seg(A.sh, end, 0.2, 0.16, shirtStyle === 'raglan' ? trim : shade(shirt, -0.04));
      if (shirtStyle !== 'raglan') seg(lerp2(A.sh, A.el, 0.44), end, 0.165, 0.16, trim); // sleeve hem
    };
    // A loose hand (fingers together, slightly longer than wide)
    const drawOpenHand = (A: ArmPts) => {
      const ang = Math.atan2(A.hd[1] - A.el[1], A.hd[0] - A.el[0]);
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.ellipse(A.hd[0] + Math.cos(ang) * s * 0.07, A.hd[1] + Math.sin(ang) * s * 0.07, s * 0.13, s * 0.085, ang, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(shade(skin, -0.35), 0.5);
      ctx.lineWidth = Math.max(0.6, s * 0.025);
      ctx.stroke();
    };

    const ang = (hand[3] * Math.PI) / 180;
    const pdx = dom * Math.sin(ang), pdy = -Math.cos(ang); // paddle direction on screen
    const drawPaddleArm = () => {
      drawLimbs(domArm);
      const spr = paddleSprite(p.paddle, PADDLE_RES);
      const k = (s * 0.95) / PADDLE_RES;
      ctx.save();
      ctx.translate(domArm.hd[0] + pdx * s * 0.66, domArm.hd[1] + pdy * s * 0.66);
      ctx.rotate(Math.atan2(pdy, pdx));
      ctx.drawSprite(spr.sprite, -spr.ox * k, (-spr.h * k) / 2, spr.w * k, spr.h * k);
      ctx.restore();
      // fist wrapped around the grip
      const ga = Math.atan2(pdy, pdx);
      ctx.save();
      ctx.translate(domArm.hd[0] + pdx * s * 0.04, domArm.hd[1] + pdy * s * 0.04);
      ctx.rotate(ga);
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.12, s * 0.135, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(shade(skin, -0.4), 0.55);
      ctx.lineWidth = Math.max(0.6, s * 0.03);
      ctx.beginPath(); ctx.moveTo(s * 0.035, -s * 0.1); ctx.lineTo(s * 0.035, s * 0.1); ctx.stroke(); // knuckles
      ctx.restore();
    };
    const drawOffArm = () => { drawLimbs(offArm); drawOpenHand(offArm); };

    // paddle-tip motion trail during a stroke
    if (p.stroke) {
      p.tip.push([domArm.hd[0] + pdx * s * 1.2, domArm.hd[1] + pdy * s * 1.2]);
      if (p.tip.length > 8) p.tip.shift();
      for (let i = 1; i < p.tip.length; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${(i / p.tip.length) * 0.4})`;
        ctx.lineWidth = Math.max(1.5, s * 0.24 * (i / p.tip.length));
        ctx.beginPath(); ctx.moveTo(p.tip[i - 1][0], p.tip[i - 1][1]); ctx.lineTo(p.tip[i][0], p.tip[i][1]); ctx.stroke();
      }
    }

    // Anything on the far side of the body from the camera is drawn first
    const hidden = (w: number) => (away ? w > bodyW + 0.1 : w < bodyW - 0.1);
    // the server's ball is drawn with the body so it sits in front of / behind it correctly
    // (it used to be painted over the back of a player facing away from the camera)
    if (servingBall && hidden(ballW)) { drawBall(); heldBallDrawn = true; }
    if (hidden(off[2])) drawOffArm();
    if (hidden(hand[2])) drawPaddleArm();

    // neck and head (the head carries forward over the chest with the lean)
    const neckBase = rotY(shC3, 0, 0.2, 0, turn);
    const headC = [shC3[0] * 0.8, shC3[1] + 0.3 * spZ + 0.5, shC3[2] + 0.3 * spW + 0.08];
    seg(P(neckBase), P([headC[0], headC[1] - 0.3, headC[2] - 0.02]), 0.125, 0.11, shade(skin, -0.12));

    // shirt: waist -> lats/chest -> armpits -> shoulder caps -> trapezius -> neck
    if (quality === 0) ctx.fillStyle = shirt;
    else {
      const tg = ctx.createLinearGradient(g.x - s * 0.7, 0, g.x + s * 0.7, 0);
      tg.addColorStop(0, shade(shirt, 0.14 - turn * 0.08));
      tg.addColorStop(0.55, shade(shirt, -0.04 - turn * 0.08));
      tg.addColorStop(1, shade(shirt, -0.26 - turn * 0.08));
      ctx.fillStyle = tg;
    }
    const waistW = fem ? 0.4 : 0.45;
    // each side: waist -> lat -> armpit -> round deltoid over the real shoulder joint -> trapezius -> neck
    const side3 = (sd: number) => {
      const dz = sd > 0 ? dip : -dip * 0.5;
      const o = tank ? 0.62 : 1;
      return {
        W: P(rotY(pelvTop, sd * waistW, -0.04, 0, hipTurn)),
        C: P(rotY(along(0.5), sd * halfW * (fem ? 0.86 : 0.98), 0, 0, midTurn)),
        A: P(rotY(along(0.78), sd * halfW * (tank ? 0.76 : 0.98), dz * 0.6, 0, turn)),
        D: P(rotY(shC3, sd * (halfW * o + (tank ? 0 : 0.13)), dz - 0.12, 0, turn)),
        Dc: P(rotY(shC3, sd * (halfW * o + (tank ? 0.02 : 0.14)), dz + 0.16, 0, turn)),
        T: P(rotY(shC3, sd * halfW * o * 0.72, dz + 0.2, 0, turn)),
        Tc: P(rotY(shC3, sd * 0.3, 0.27, 0, turn)),
        N: P(rotY(shC3, sd * (tank ? 0.15 : 0.18), 0.34, 0, turn)),
      };
    };
    const LT = side3(-1), RT = side3(1);
    ctx.beginPath();
    ctx.moveTo(LT.W[0], LT.W[1]);
    ctx.quadraticCurveTo(LT.C[0], LT.C[1], LT.A[0], LT.A[1]);
    ctx.lineTo(LT.D[0], LT.D[1]);
    ctx.quadraticCurveTo(LT.Dc[0], LT.Dc[1], LT.T[0], LT.T[1]);
    ctx.quadraticCurveTo(LT.Tc[0], LT.Tc[1], LT.N[0], LT.N[1]);
    ctx.lineTo(RT.N[0], RT.N[1]);
    ctx.quadraticCurveTo(RT.Tc[0], RT.Tc[1], RT.T[0], RT.T[1]);
    ctx.quadraticCurveTo(RT.Dc[0], RT.Dc[1], RT.D[0], RT.D[1]);
    ctx.lineTo(RT.A[0], RT.A[1]);
    ctx.quadraticCurveTo(RT.C[0], RT.C[1], RT.W[0], RT.W[1]);
    ctx.closePath();
    ctx.fill();
    if (shirtStyle === 'raglan') { // contrasting shoulder panels from the collar
      ctx.fillStyle = trim;
      for (const T of [LT, RT]) {
        ctx.beginPath(); ctx.moveTo(T.N[0], T.N[1]); ctx.quadraticCurveTo(T.Tc[0], T.Tc[1], T.T[0], T.T[1]); ctx.quadraticCurveTo(T.Dc[0], T.Dc[1], T.D[0], T.D[1]); ctx.lineTo(T.A[0], T.A[1]);
        ctx.lineTo(lerp(T.A[0], T.N[0], 0.35), lerp(T.A[1], T.N[1], 0.35)); ctx.closePath(); ctx.fill();
      }
    }
    // soft shading: the shirt drapes into the waistband
    if (rich) {
      const wa = P(along(0)), wb2 = P(along(0.35));
      const sg = ctx.createLinearGradient(0, wa[1], 0, wb2[1]);
      sg.addColorStop(0, 'rgba(0,0,0,0.22)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(LT.W[0], LT.W[1]); ctx.lineTo(RT.W[0], RT.W[1]); ctx.lineTo(RT.W[0], wb2[1]); ctx.lineTo(LT.W[0], wb2[1]); ctx.closePath();
      ctx.fill();
    }
    const q = s * 0.8; // collar details, scaled to the slimmer neck
    const c = P(rotY(shC3, 0, 0.33, 0, turn));
    if (!away) { // neckline on the front
      ctx.fillStyle = shade(skin, -0.08);
      ctx.strokeStyle = trim;
      ctx.lineWidth = Math.max(1, q * 0.07);
      if (shirtStyle === 'polo') {
        ctx.beginPath(); ctx.moveTo(c[0] - q * 0.18, c[1]); ctx.lineTo(c[0] + q * 0.18, c[1]); ctx.lineTo(c[0], c[1] + q * 0.32); ctx.closePath(); ctx.fill();
        ctx.fillStyle = trim; // collar points
        ctx.beginPath(); ctx.moveTo(c[0] - q * 0.22, c[1] - q * 0.02); ctx.lineTo(c[0] - q * 0.02, c[1] + q * 0.3); ctx.lineTo(c[0] - q * 0.14, c[1] + q * 0.3); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(c[0] + q * 0.22, c[1] - q * 0.02); ctx.lineTo(c[0] + q * 0.02, c[1] + q * 0.3); ctx.lineTo(c[0] + q * 0.14, c[1] + q * 0.3); ctx.closePath(); ctx.fill();
      } else if (shirtStyle === 'vneck') {
        ctx.beginPath(); ctx.moveTo(c[0] - q * 0.18, c[1]); ctx.lineTo(c[0] + q * 0.18, c[1]); ctx.lineTo(c[0], c[1] + q * 0.36); ctx.closePath(); ctx.fill(); ctx.stroke();
      } else if (tank) {
        ctx.beginPath(); ctx.ellipse(c[0], c[1], q * 0.22, q * 0.2, 0, 0, Math.PI); ctx.fill(); ctx.stroke();
      } else { // crew / raglan
        ctx.beginPath(); ctx.ellipse(c[0], c[1], q * 0.17, q * 0.1, 0, 0, Math.PI); ctx.fill(); ctx.stroke();
      }
    } else if (shirtStyle === 'polo') { // polo collar band seen from behind
      ctx.fillStyle = trim;
      ctx.fillRect(c[0] - q * 0.24, c[1] - q * 0.04, q * 0.48, Math.max(1.5, q * 0.13));
    } else { // spine and shoulder blades
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = Math.max(1, s * 0.045);
      const a = P(along(0.9)), b = P(along(0.15));
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }

    const hd = P(headC);
    drawHeadBillboard(ctx, av, hd[0], hd[1], s * 0.315, away ? 'back' : 'front', p.gait || p.phase, quality === 0);

    if (!hidden(off[2])) drawOffArm();
    if (!hidden(hand[2])) drawPaddleArm();
    if (servingBall && !hidden(ballW)) { drawBall(); heldBallDrawn = true; }
  }

  // ---------- referees on umpire chairs ----------
  const REF_LOOK: HeadLook = { skin: '#d9a27a', hair: 'short', hairColor: '#2a2420', facial: 'none', headwear: 'cap', hatColor: '#141414' };

  function refArmDirs(r: Ref, sh: { x: number; y: number }, s: number): ArmDir[] {
    // directions in screen space; {dx,dy,len} or {up:true}
    const toward = (): { dx: number; dy: number } => {
      if (!r.target) return { dx: r.x < 10 ? 1 : -1, dy: 0.2 };
      const t = proj(r.target.x, r.target.y, 0.5);
      const v = { dx: t.x - sh.x, dy: t.y - sh.y };
      const d = Math.hypot(v.dx, v.dy) || 1;
      return { dx: v.dx / d, dy: v.dy / d };
    };
    const idle = (side: number): ArmDir => ({ dx: side * 0.35, dy: 0.94, len: 1.1 * s });
    const courtSide = r.x < 10 ? 1 : -1;
    switch (r.pose) {
      case 'in': {
        const w = Math.sin(clock * 16) * 0.35;
        return [{ dx: -1, dy: 0.25 + w, len: 1.5 * s }, { dx: 1, dy: 0.25 + w, len: 1.5 * s }];
      }
      case 'out': {
        const t = toward();
        const point: ArmDir = { ...t, len: 1.7 * s, flag: '#ff3b3b' };
        const wide: ArmDir = { dx: -Math.sign(t.dx || 1), dy: -0.1, len: 1.4 * s };
        return t.dx >= 0 ? [wide, point] : [point, wide];
      }
      case 'kitchen': {
        const t = toward();
        const point: ArmDir = { ...t, len: 1.7 * s, flag: '#ffd60a' };
        return t.dx >= 0 ? [idle(-1), point] : [point, idle(1)];
      }
      case 'fault':
        return courtSide > 0 ? [idle(-1), { up: true, len: 1.6 * s, flag: '#ffd60a' }] : [{ up: true, len: 1.6 * s, flag: '#ffd60a' }, idle(1)];
      case 'score': {
        const t = toward();
        const point: ArmDir = { ...t, len: 1.5 * s };
        return t.dx >= 0 ? [{ up: true, len: 1.5 * s }, point] : [point, { up: true, len: 1.5 * s }];
      }
      case 'point': {
        const t = toward();
        const point: ArmDir = { ...t, len: 1.6 * s };
        return t.dx >= 0 ? [idle(-1), point] : [point, idle(1)];
      }
      default:
        return [idle(-1), idle(1)];
    }
  }

  function drawFlag(hx: number, hy: number, dx: number, dy: number, color: string, s: number) {
    const poleX = hx + dx * s * 0.9, poleY = hy + dy * s * 0.9;
    const nx = -dy, ny = dx;
    const wave = Math.sin(clock * 18) * s * 0.12;
    const w = s * 0.6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(hx + dx * s * 0.25, hy + dy * s * 0.25);
    ctx.lineTo(poleX, poleY);
    ctx.lineTo(poleX + nx * w + dx * wave, poleY + ny * w + dy * wave);
    ctx.lineTo(hx + dx * s * 0.3 + nx * w * 0.9 - dx * wave, hy + dy * s * 0.3 + ny * w * 0.9 - dy * wave);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = Math.max(1, s * 0.07);
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(poleX, poleY); ctx.stroke();
  }

  function drawRef(r: Ref) {
    const g = proj(r.x, r.y, 0);
    const s = g.s;
    const P = (dx: number, dz: number) => [g.x + dx * s, g.y - dz * s];
    const seatZ = 4.2;

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(g.x + s * 0.3, g.y, s * 1.1, s * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    if (use3D) return; // the umpire, chair and flags are drawn by the 3D layer

    // umpire chair: legs, rungs, seat and backrest
    ctx.strokeStyle = '#8a94a3';
    ctx.lineWidth = Math.max(1.5, s * 0.12);
    ctx.lineCap = 'round';
    const lb = P(-0.85, 0), lt = P(-0.6, seatZ), rb = P(0.85, 0), rt = P(0.6, seatZ);
    ctx.beginPath();
    ctx.moveTo(lb[0], lb[1]); ctx.lineTo(lt[0], lt[1]);
    ctx.moveTo(rb[0], rb[1]); ctx.lineTo(rt[0], rt[1]);
    for (let z = 0.9; z < seatZ; z += 0.9) {
      const k = z / seatZ;
      const a = P(-0.85 + 0.25 * k, z), b = P(0.85 - 0.25 * k, z);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    const back0 = P(-0.75, seatZ + 2.1);
    ctx.fillStyle = '#4d5866';
    rr(back0[0], back0[1], s * 1.5, s * 2.1, s * 0.15); ctx.fill();

    // legs (dark trousers) hanging from the seat
    ctx.fillStyle = '#1d2430';
    const lg = P(-0.38, seatZ + 0.1);
    ctx.fillRect(lg[0], lg[1], s * 0.76, s * 1.5);
    ctx.fillStyle = '#111';
    const sh = P(-0.42, seatZ - 1.4);
    ctx.fillRect(sh[0], sh[1], s * 0.84, s * 0.22);
    const seat = P(-0.8, seatZ + 0.2);
    ctx.fillStyle = '#566170';
    ctx.fillRect(seat[0], seat[1], s * 1.6, s * 0.3);

    // striped shirt
    const tA = P(-0.5, seatZ + 2.05), tH = 1.8 * s, tW = 1.0 * s;
    ctx.save();
    rr(tA[0], tA[1], tW, tH, s * 0.22);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = '#111';
    for (let x = tA[0] + s * 0.06; x < tA[0] + tW; x += s * 0.24) ctx.fillRect(x, tA[1], s * 0.11, tH);
    ctx.restore();

    // arms with gestures and flags
    const shoulders = [{ x: g.x - s * 0.5, y: g.y - (seatZ + 1.85) * s }, { x: g.x + s * 0.5, y: g.y - (seatZ + 1.85) * s }];
    const arms = refArmDirs(r, shoulders[1], s);
    arms.forEach((a, i) => {
      const shp = shoulders[i];
      let dx: number, dy: number;
      if (a.up) { dx = Math.sin(clock * 9) * 0.22; dy = -1; const d = Math.hypot(dx, dy); dx /= d; dy /= d; }
      else { dx = a.dx || 0; dy = a.dy || 0; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d; }
      const ex = shp.x + dx * a.len, ey = shp.y + dy * a.len;
      ctx.strokeStyle = '#d9a27a';
      ctx.lineWidth = Math.max(1.5, s * 0.2);
      ctx.beginPath(); ctx.moveTo(shp.x, shp.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = Math.max(1.8, s * 0.26);
      ctx.beginPath(); ctx.moveTo(shp.x, shp.y); ctx.lineTo(shp.x + dx * a.len * 0.3, shp.y + dy * a.len * 0.3); ctx.stroke();
      if (a.flag) drawFlag(ex, ey, dx, dy, a.flag, s);
      ctx.fillStyle = '#d9a27a';
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(1, s * 0.12), 0, Math.PI * 2); ctx.fill();
    });

    // head (looks toward the ball)
    const hd = P(0, seatZ + 2.5);
    drawHeadBillboard(ctx, REF_LOOK, hd[0], hd[1], s * 0.38, 'front');
    if (r.poseT > 0 && r.pose !== 'idle') { // whistle glint
      ctx.fillStyle = `rgba(255,255,255,${0.4 + 0.4 * Math.sin(clock * 20)})`;
      ctx.beginPath(); ctx.arc(hd[0], hd[1] + s * 0.45, Math.max(1, s * 0.1), 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------- ball ----------
  // Drawn size of the ball (ft). A real ball is ~0.12 ft across; it's drawn larger so it
  // stays easy to follow on a phone (was 0.21, now ~20% bigger).
  const BALL_R = 0.25;
  function drawBallShadow() {
    const g = proj(ball.x, ball.y, 0);
    const r = Math.max(3, BALL_R * 0.95 * g.s);
    const a = clamp(0.38 - ball.z * 0.025, 0.08, 0.38);
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.beginPath(); ctx.ellipse(g.x, g.y, r * 1.25, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawBall() {
    const speed = Math.hypot(ball.vx, ball.vy);
    const hot = !ball.held && speed > 48;
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      const tp = proj(t.x, t.y, t.z);
      const k = (i + 1) / trail.length;
      ctx.fillStyle = t.power ? `rgba(255,70,25,${k * 0.6})` : t.hot ? `rgba(255,140,50,${k * 0.45})` : `rgba(240,250,120,${k * 0.3})`;
      ctx.beginPath(); ctx.arc(tp.x, tp.y, Math.max(1.4, (t.power ? 0.38 : 0.2) * tp.s * k) + 0.5, 0, Math.PI * 2); ctx.fill();
    }
    const g = proj(ball.x, ball.y, ball.z);
    const r = Math.max(3.6, BALL_R * g.s);
    const sq = ball.squash;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.scale(1 + 0.4 * sq, 1 - 0.35 * sq);
    if (hot) { // glow (a soft disc instead of a blur, which is slow on phones)
      ctx.fillStyle = ball.power ? 'rgba(255,80,30,0.45)' : 'rgba(255,154,60,0.35)';
      ctx.beginPath(); ctx.arc(0, 0, r * (ball.power ? 2.8 : 2), 0, Math.PI * 2); ctx.fill();
    }
    if (use3D) { ctx.restore(); return; } // the ball itself is 3D
    const grad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, 0.5, 0, 0, r);
    grad.addColorStop(0, '#fbffc4');
    grad.addColorStop(1, '#c6d81c');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(ball.spin);
    ctx.fillStyle = 'rgba(90,100,0,0.55)';
    for (const [ox, oy] of [[-0.4, 0.1], [0.3, -0.3], [0.15, 0.45], [0.05, -0.05]]) {
      ctx.beginPath(); ctx.arc(ox * r, oy * r, r * 0.15, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      const k = p.t / p.life;
      const g = proj(p.x, p.y, p.z);
      if (p.kind === 'spark') {
        const e = proj(p.x - p.vx * 0.035, p.y - p.vy * 0.035, p.z - p.vz * 0.035);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = Math.max(1, (p.size * g.s) / 22);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(e.x, e.y); ctx.stroke();
      } else {
        ctx.globalAlpha = 0.38 * (1 - k);
        ctx.fillStyle = '#eef3f8';
        ctx.beginPath(); ctx.arc(g.x, g.y, ((p.size * g.s) / 18) * (1 + k * 1.5), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawLanding() {
    if (!landing || state !== 'rally') return;
    const r = 0.7 + Math.sin(clock * 12) * 0.1;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.lineDashOffset = -clock * 20;
    groundEllipsePath(landing.x, landing.y, r, r, 20);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function outlinedText(text: string, x: number, y: number, color: string, size: number) {
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(3, size * 0.28);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  const textScale = (s: number) => clamp(s / 20, 0.75, 1.35);

  function drawFloaters() {
    for (const f of floaters) {
      const k = f.t / f.life;
      const g = proj(f.x, f.y, 7);
      const pop = 1 + 0.6 * Math.max(0, 1 - k * 6);
      ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      outlinedText(f.text, g.x, g.y - k * 34, f.color, 16 * f.size * pop * textScale(g.s));
    }
    ctx.globalAlpha = 1;
  }

  function drawNameTags() {
    for (const p of roster) {
      const hop = p.jump > 0 ? Math.sin((1 - p.jump) * Math.PI) * 1.1 : 0;
      const g = proj(p.x, p.y, 6.35 + hop);
      const fs = Math.round(10 * textScale(g.s));
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(p.name).width + 10, h = fs + 5;
      ctx.fillStyle = 'rgba(10,16,26,0.72)';
      rr(g.x - w / 2, g.y - h / 2, w, h, h / 2);
      ctx.fill();
      ctx.strokeStyle = p.team === 'player' ? 'rgba(58,160,255,0.95)' : 'rgba(255,93,93,0.95)';
      ctx.lineWidth = p.human ? 1.8 : 1.1;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, g.x, g.y + 0.5);
    }
  }

  function drawCues() {
    if (state === 'serve') {
      const s0 = serverAth;
      const pr = 1.5 + 0.2 * Math.sin(clock * 6);
      ctx.strokeStyle = 'rgba(215,242,59,0.8)';
      ctx.lineWidth = 2;
      groundEllipsePath(s0.x, s0.y, pr, pr);
      ctx.stroke();
      if (serverAth === player) {
        const g = proj(player.x, player.y, 7.6);
        ctx.globalAlpha = 0.65 + 0.35 * Math.sin(clock * 5);
        outlinedText('TAP DRIVE TO SERVE', g.x, g.y, '#d7f23b', 14 * textScale(g.s));
        ctx.globalAlpha = 1;
      }
    }
    if (state === 'rally' && lastHitter === 'ai' && bounces === 0) {
      let text: string | null = null, color = '';
      if (shots < 3) { text = 'LET IT BOUNCE'; color = '#d7f23b'; }
      else if (inKitchen('player', player.y)) { text = 'NO VOLLEY IN KITCHEN'; color = '#ff7b7b'; }
      if (text) {
        const g = proj(player.x, player.y, 7.6);
        outlinedText(text, g.x, g.y, color, 14 * textScale(g.s));
      }
    }
  }

  // Small vector glyphs (Skia text has no emoji fallback)
  function boltPath(x: number, yBottom: number, h: number) {
    const w = h * 0.62, y = yBottom - h;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.62, y);
    ctx.lineTo(x + w * 0.05, y + h * 0.56);
    ctx.lineTo(x + w * 0.45, y + h * 0.56);
    ctx.lineTo(x + w * 0.3, y + h);
    ctx.lineTo(x + w * 0.95, y + h * 0.4);
    ctx.lineTo(x + w * 0.55, y + h * 0.4);
    ctx.closePath();
    return w;
  }

  // Broadcast-style scoreboard (fits between the energy bar on the left and the Menu buttons
  // on the right), styled like a tournament TV graphic:
  //   ▌ HANA / PIA          ● 2 │ 7 │   <- team rows: colour bar, names, serve marker (+ server
  //   ▌ REX / GIL               │ 4 │      number in doubles), score cell (lime = serving side)
  //   DOUBLES · TO 11     GAME POINT   7–4–2   <- footer: format, game point, the official call
  function drawCompactScore() {
    if (!hudRightW) hudRightW = 130;
    const sc = clamp(VIEW_H / 400, 0.85, 1.4);
    const top = 6;
    const rowH = Math.round(20 * sc), footH = Math.round(13 * sc), gapRow = 1;
    const energyW = clamp(VIEW_W * 0.3, 120, 210);
    const side = Math.max(energyW + 26, hudRightW + 22);
    const maxW = Math.max(210 * sc, VIEW_W - side * 2);
    const doubles = mode === 'doubles';
    const bar = Math.round(5 * sc), pad = Math.round(8 * sc), cellW = Math.round(34 * sc);
    const serveW = Math.round((doubles ? 24 : 15) * sc);
    const nameF = Math.round(11 * sc), scoreF = Math.round(16 * sc), footF = Math.round(8.5 * sc);
    ctx.save();
    ctx.font = `900 ${nameF}px system-ui, sans-serif`;
    const nameMax = Math.max(44 * sc, maxW - bar - pad * 3 - serveW - cellW);
    const fit = (t: string) => {
      if (ctx.measureText(t).width <= nameMax) return t;
      let s = t;
      while (s.length > 1 && ctx.measureText(s + '…').width > nameMax) s = s.slice(0, -1);
      return s + '…';
    };
    const names: Record<Team, string> = { player: fit(boardName('player')), ai: fit(boardName('ai')) };
    const nameW = Math.max(ctx.measureText(names.player).width, ctx.measureText(names.ai).width, 70 * sc);
    const W = Math.round(bar + pad + nameW + pad + serveW + pad + cellW);
    const H = rowH * 2 + gapRow + footH;
    const x0 = Math.round(VIEW_W / 2 - W / 2);
    const rad = 7 * sc;

    // panel: drop shadow, then clip everything to the rounded outline
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    rr(x0 + 2, top + 3, W, H, rad); ctx.fill();
    ctx.save();
    rr(x0, top, W, H, rad); ctx.clip();

    const teams: Team[] = ['player', 'ai'];
    teams.forEach((team, i) => {
      const y = top + i * (rowH + gapRow);
      const serving = server === team && (state === 'serve' || state === 'rally' || state === 'point');
      const bg = ctx.createLinearGradient(0, y, 0, y + rowH);
      bg.addColorStop(0, '#1b2740'); bg.addColorStop(1, '#111a2b');
      ctx.fillStyle = bg;
      ctx.fillRect(x0, y, W, rowH);
      // team colour bar
      ctx.fillStyle = team === 'player' ? '#2f80ed' : '#e04848';
      ctx.fillRect(x0, y, bar, rowH);
      // names
      ctx.font = `900 ${nameF}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = serving ? '#ffffff' : 'rgba(238,243,248,0.78)';
      ctx.fillText(names[team], x0 + bar + pad, y + rowH / 2 + 0.5);
      // serve marker: a little ball (+ the server number in doubles)
      const sx = x0 + bar + pad + nameW + pad;
      if (serving) {
        const br = rowH * 0.2;
        const bx = sx + br + 1, by = y + rowH / 2;
        ctx.fillStyle = '#d7f23b';
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(90,100,0,0.6)';
        for (const [ox, oy] of [[-0.35, -0.2], [0.3, 0.25], [0.1, -0.45]]) {
          ctx.beginPath(); ctx.arc(bx + ox * br, by + oy * br, br * 0.17, 0, Math.PI * 2); ctx.fill();
        }
        if (doubles) {
          ctx.font = `900 ${Math.round(nameF * 0.95)}px system-ui, sans-serif`;
          ctx.fillStyle = '#d7f23b';
          ctx.textAlign = 'left';
          ctx.fillText(String(serverNum), bx + br + 3 * sc, by + 0.5);
        }
      }
      // score cell
      const cx = x0 + W - cellW;
      ctx.fillStyle = serving ? '#d7f23b' : '#26365a';
      ctx.fillRect(cx, y, cellW, rowH);
      ctx.fillStyle = serving ? '#0b111a' : '#ffffff';
      ctx.font = `900 ${scoreF}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(score[team]), cx + cellW / 2, y + rowH / 2 + 1);
    });
    // thin divider between the rows and before the score cells
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x0, top + rowH, W, gapRow);

    // footer strip
    const fy = top + rowH * 2 + gapRow;
    ctx.fillStyle = '#080d16';
    ctx.fillRect(x0, fy, W, footH);
    ctx.fillStyle = '#d7f23b';
    ctx.fillRect(x0, fy, W, Math.max(1, sc)); // accent line
    const a = score[server], b = score[other(server)];
    const gamePoint = state !== 'over' && a >= WIN_SCORE - 1 && a > b;
    ctx.font = `800 ${footF}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const fmid = fy + footH / 2 + 0.5;
    ctx.textAlign = 'left';
    const fmt = `${doubles ? 'DOUBLES' : 'SINGLES'}${netRole !== 'off' ? ' · ONLINE' : ''}`;
    ctx.fillStyle = gamePoint ? '#ff5d5d' : '#9fb0c3'; // game point flagged in red
    ctx.fillText(gamePoint ? 'GAME POINT' : `${fmt} · TO 11`, x0 + bar + pad, fmid);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#d7f23b';
    ctx.font = `900 ${Math.round(footF * 1.05)}px system-ui, sans-serif`;
    ctx.fillText(doubles ? `${a}–${b}–${serverNum}` : `${a}–${b}`, x0 + W - pad * 0.75, fmid);
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1;
    rr(x0 + 0.5, top + 0.5, W - 1, H - 1, rad); ctx.stroke();
    ctx.restore();
  }

  // Hyper energy bar (top-left of the court in the touch layout)
  function drawEnergyBar() {
    const st = state === 'paused' ? pausedFrom : state;
    if (!(st === 'serve' || st === 'rally' || st === 'point')) return;
    const armed = energy.hyperT > 0; // Hyper mode running
    const full = energy.value >= 100 && !armed;
    const w = clamp(VIEW_W * 0.3, 120, 210), h = 12;
    const shakeX = energy.denied > 0 ? Math.sin(clock * 80) * 5 * (energy.denied / 0.45) : 0;
    const x = 14 + shakeX, y = compactHud ? 52 : VIEW_H - h - 14;
    const pulse = 0.5 + 0.5 * Math.sin(clock * (armed ? 16 : 7));
    ctx.save();
    // dark backing panel behind the label and bar so it reads cleanly over the wall
    ctx.fillStyle = 'rgba(10,16,26,0.62)';
    rr(x - 8, y - 22, w + 16, h + 30, 10);
    ctx.fill();
    // labels: "⚡ HYPER"
    ctx.font = '900 11px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.textAlign = 'left';
    ctx.fillStyle = HYPER_COLOR;
    const bw = boltPath(x, y - 5, 11);
    ctx.fill();
    ctx.strokeText('HYPER', x + bw + 4, y - 4);
    ctx.fillStyle = full || armed ? HYPER_COLOR : '#e8edf3';
    ctx.fillText('HYPER', x + bw + 4, y - 4);
    const right = armed ? `ACTIVE ${energy.hyperT.toFixed(1)}s` : full ? 'TAP HYPER' : `${Math.floor(energy.value)}%`;
    ctx.textAlign = 'right';
    ctx.strokeText(right, x + w, y - 4);
    ctx.fillStyle = armed || full ? `rgba(${Math.round(124 + 100 * pulse)},242,255,1)` : (energy.denied > 0 ? '#ff7b7b' : '#c9d3df');
    ctx.fillText(right, x + w, y - 4);
    // glow when ready
    if (full || armed) {
      ctx.strokeStyle = `rgba(124,242,255,${0.35 + 0.5 * pulse})`;
      ctx.lineWidth = 2 + pulse * 2;
      rr(x - 4, y - 4, w + 8, h + 8, (h + 8) / 2);
      ctx.stroke();
    }
    // track
    ctx.fillStyle = 'rgba(10,16,26,0.78)';
    rr(x - 2, y - 2, w + 4, h + 4, (h + 4) / 2);
    ctx.fill();
    // fill (clipped to the rounded track)
    ctx.save();
    rr(x, y, w, h, h / 2);
    ctx.clip();
    const fw = (w * energy.value) / 100;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, full || armed ? '#19b7d6' : '#3aa0ff');
    g.addColorStop(1, full || armed ? '#d7f23b' : HYPER_COLOR);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, fw, h);
    if (full) { // moving shine stripes
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      const off = (clock * 60) % 16;
      for (let sx = x - 16 + off; sx < x + w; sx += 16) {
        ctx.beginPath(); ctx.moveTo(sx, y + h); ctx.lineTo(sx + 6, y); ctx.lineTo(sx + 11, y); ctx.lineTo(sx + 5, y + h); ctx.closePath(); ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; // top highlight
    ctx.fillRect(x, y, fw, h * 0.35);
    ctx.restore();
    // quarter ticks
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (const q of [0.25, 0.5, 0.75]) ctx.fillRect(x + w * q - 0.5, y + 2, 1, h - 4);
    ctx.restore();
  }

  function drawRallyCounter() { // screen-space, unaffected by the camera pan
    if ((state === 'rally' || state === 'point') && shots >= 3) {
      ctx.save();
      ctx.translate(14, 20);
      ctx.scale(1 + rallyPop * 0.35, 1 + rallyPop * 0.35);
      outlinedText(`RALLY ${shots}`, 34, 0, shots >= 10 ? '#d7f23b' : '#ffffff', 14);
      ctx.restore();
    }
  }

  function drawRefBubbles() {
    for (const r of refs) {
      const b = r.bubble;
      if (!b) continue;
      const k = b.t;
      const pop = k < 0.12 ? 0.5 + (k / 0.12) * 0.62 : k < 0.24 ? 1.12 - ((k - 0.12) / 0.12) * 0.12 : 1;
      const alpha = Math.min(1, (b.life - k) / 0.3);
      ctx.font = '800 13px system-ui, sans-serif';
      const w = ctx.measureText(b.text).width + 20, h = 26;
      const a = proj(r.x, r.y, 7.4);
      const bx = clamp(a.x, w / 2 + 6 - cam.pan, VIEW_W - w / 2 - 6 - cam.pan); // keep on screen despite the pan
      const by = clamp(a.y - 22, h / 2 + 4, VIEW_H - h);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(bx, by);
      ctx.scale(pop, pop);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      rr(-w / 2 + 2, -h / 2 + 3, w, h, 11); ctx.fill();
      ctx.fillStyle = '#ffffff';
      rr(-w / 2, -h / 2, w, h, 11); ctx.fill();
      const tx = clamp(a.x - bx, -w / 2 + 12, w / 2 - 12);
      ctx.beginPath();
      ctx.moveTo(tx - 6, h / 2 - 1); ctx.lineTo(tx + 6, h / 2 - 1); ctx.lineTo(tx, h / 2 + 9);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2;
      rr(-w / 2, -h / 2, w, h, 11); ctx.stroke();
      ctx.fillStyle = b.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.text, 0, 1);
      ctx.restore();
    }
  }

  function drawConfetti() {
    for (const c of confetti) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(1, Math.sin(clock * 8 + c.wob) || 0.001);
      ctx.globalAlpha = c.t > c.life - 0.6 ? (c.life - c.t) / 0.6 : 1;
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- on-screen touch controls ----------
  function drawControls() {
    if (overlayUp()) return; // no controls on top of menus, pause or game over
    // joystick (base rests centre-left; jumps under the thumb)
    const R = joy.R;
    const bx = joy.homeX + joy.bx, by = joy.homeY + joy.by;
    ctx.save();
    ctx.globalAlpha = joy.active ? 1 : 0.85;
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, R);
    bg.addColorStop(0, 'rgba(10,16,26,0.35)');
    bg.addColorStop(0.7, 'rgba(10,16,26,0.12)');
    bg.addColorStop(1, 'rgba(10,16,26,0.12)');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = joy.active ? 'rgba(58,160,255,0.6)' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, R - 1, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(bx, by, R * 0.56, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    const kr = R * 0.44;
    const kx = bx + joy.kx, ky = by + joy.ky;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.arc(kx, ky + 6, kr, 0, Math.PI * 2); ctx.fill();
    const kg = ctx.createRadialGradient(kx - kr * 0.3, ky - kr * 0.4, 0, kx, ky, kr);
    kg.addColorStop(0, '#7cc2ff');
    kg.addColorStop(1, '#2a7fd6');
    ctx.fillStyle = kg;
    ctx.beginPath(); ctx.arc(kx, ky, kr, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // shot buttons
    const shot = (b: Btn, label: string, c0: string, c1: string, fontK: number) => {
      const pressed = b.pressed >= 0;
      const scale = pressed ? 0.95 : 1;
      const r = b.r * scale;
      const cx = b.x, cy = b.y + (pressed ? 4 : 0);
      ctx.save();
      ctx.globalAlpha = 0.93;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(cx, cy + (pressed ? 4 : 10), r * 1.04, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(cx, cy + (pressed ? 2 : 6), r, 0, Math.PI * 2); ctx.fill();
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, 0, cx, cy, r * 1.15);
      g.addColorStop(0, pressed ? shade(c0, 0.15) : c0);
      g.addColorStop(1, pressed ? shade(c1, 0.15) : c1);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = `900 ${Math.round(b.r * 2 * fontK)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy);
      ctx.restore();
    };
    shot(buttons.lob, 'LOB', '#c8a6ff', '#8d5cf0', 0.2);
    shot(buttons.dink, 'DINK', '#9ef0b6', '#3fbf6b', 0.2);
    shot(buttons.drive, 'DRIVE', '#f1ff8a', '#c5dc1b', 0.16);
    shot(buttons.smash, 'SMASH', '#ffc59a', '#ff5a1f', 0.18);

    // HYPER: its ring shows the charge (and drains while Hyper mode runs)
    if (powerVisible()) {
      const b = buttons.hyper;
      const v = Math.floor(energy.value);
      const armed = energy.hyperT > 0, full = v >= 100 && !armed;
      const deny = energy.denied > 0 ? Math.sin(clock * 160) * 4 : 0;
      const cx = b.x + deny, cy = b.y, R2 = b.r;
      ctx.save();
      if (full || armed) { // pulsing glow
        const period = armed ? 0.35 : 0.9;
        const ph = (clock % period) / period;
        const spread = 10 * ph;
        ctx.fillStyle = `rgba(124,242,255,${0.7 * (1 - ph)})`;
        ctx.beginPath(); ctx.arc(cx, cy, R2 + spread, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath(); ctx.arc(cx, cy, R2, 0, Math.PI * 2); ctx.fill();
      if (v > 0) {
        ctx.fillStyle = HYPER_COLOR;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R2, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(100, v)) / 100);
        ctx.closePath();
        ctx.fill();
      }
      const ir = R2 - 5;
      const ig = ctx.createRadialGradient(cx - ir * 0.3, cy - ir * 0.4, 0, cx, cy, ir * 1.15);
      if (armed) { ig.addColorStop(0, '#f3ffb0'); ig.addColorStop(1, '#19b7d6'); }
      else if (full) { ig.addColorStop(0, '#c8fbff'); ig.addColorStop(1, '#19b7d6'); }
      else { ig.addColorStop(0, '#3b4656'); ig.addColorStop(1, '#161d28'); }
      ctx.fillStyle = ig;
      ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2); ctx.fill();
      const vmin = Math.min(VIEW_W, VIEW_H) / 100;
      ctx.font = `900 ${Math.round(clamp(2.6 * vmin, 10, 13))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = armed || full ? '#06222a' : '#9fb0c3';
      ctx.fillText(armed ? `${Math.ceil(energy.hyperT)}s` : 'HYPER', cx, cy);
      ctx.restore();
    }
  }

  // ---------- cached scenery ----------
  // The hall and court lines barely change, so they are recorded once into a
  // picture and reused every frame. It is wider than the screen so the camera
  // pan can slide it without re-recording.
  const bgCache: { sprite: Sprite | null; key: string; margin: number } = { sprite: null, key: '', margin: 0 };
  let vignette: CanvasGradient | null = null;

  const maxPan = () => (13 * 0.35 * cam.f) / (cam.y - 28);
  function renderScenery() {
    ctx.fillStyle = '#1b2029';
    ctx.fillRect(-400, -40, VIEW_W + 800, VIEW_H + 80);
    drawCeiling();
    drawBackWall();
    drawSideWalls();
    drawFloor();
    // (the on-screen scoreboard replaces the wall scoreboard in the touch layout)
    drawCourtSurface();
    drawLightPools();
    drawDividers();
    for (const b of BENCHES) drawBench(b.x, b.y, b.facing);
  }
  function drawScenery() {
    const key = [VIEW_W, VIEW_H, cam.f.toFixed(2), cam.hor.toFixed(2), quality].join('|');
    if (key !== bgCache.key || !bgCache.sprite) {
      const m = Math.ceil(maxPan()) + 12;
      const W = VIEW_W + m * 2;
      const saved = { ctx, w: VIEW_W, cx: cam.cx };
      try {
        bgCache.sprite = recordSprite(W, VIEW_H, g => {
          ctx = g; VIEW_W = W; cam.cx = saved.cx + m;
          renderScenery();
        });
      } finally {
        ctx = saved.ctx; VIEW_W = saved.w; cam.cx = saved.cx;
      }
      bgCache.key = key;
      bgCache.margin = m;
    }
    const sp = bgCache.sprite as Sprite;
    ctx.drawSprite(sp, -bgCache.margin, 0, sp.w, sp.h);
  }

  function draw() {
    // The camera pans (turns) to follow you like a broadcast camera. A small turn
    // shifts the whole picture sideways evenly, so it is applied as a screen offset.
    const target = state === 'menu' ? 0 : -(player.x - COURT_W / 2) * 0.35 * (cam.f / (cam.y - 28));
    cam.pan += (target - cam.pan) * 0.06;

    const ox = cam.pan + (shake > 0 ? rand(-shake, shake) : 0), oy = shake > 0 ? rand(-shake, shake) : 0;
    view3D.ox = ox; view3D.oy = oy;
    ctx.save();
    ctx.translate(ox, oy);

    heldBallDrawn = false;
    if (!use3D) { // in 3D the hall, court, shadows, people, umpires and net are all drawn by the 3D layer
      drawScenery();
      drawCourtOverlays();
      drawLanding();
      drawBallShadow();
      // People and the net, far to near (the server draws the ball it is holding)
      const items: { y: number; draw: () => void }[] = roster.map(a => ({ y: a.y, draw: () => drawAthlete(a) }));
      for (const r of refs) items.push({ y: r.y - 0.01, draw: () => drawRef(r) });
      items.push({ y: NET_Y, draw: drawNet });
      items.sort((a, b) => a.y - b.y);
      for (const it of items) it.draw();
    }

    if (use3D) { // everything from here on is drawn over the 3D players
      ctx.restore();
      frontPic = null;
      const c2 = frontRecorder.beginRecording(Skia.XYWHRect(0, 0, VIEW_W, VIEW_H));
      if (!frontCtx) frontCtx = new Ctx2D(c2);
      else frontCtx.reset(c2);
      ctx = frontCtx;
      ctx.save();
      ctx.translate(ox, oy);
    }

    drawParticles();
    if (!heldBallDrawn) drawBall();
    drawNameTags();
    drawFloaters();
    drawCues();
    drawRefBubbles();
    ctx.restore();
    drawRallyCounter();
    drawEnergyBar();
    if (compactHud && state !== 'menu') drawCompactScore();

    // Vignette (gradient built once per size) + screen effects
    if (quality > 0) {
      if (!vignette) {
        vignette = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, Math.min(VIEW_W, VIEW_H) * 0.45, VIEW_W / 2, VIEW_H / 2, Math.max(VIEW_W, VIEW_H) * 0.75);
        vignette.addColorStop(0, 'rgba(0,0,0,0)');
        vignette.addColorStop(1, 'rgba(0,0,0,0.28)');
      }
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    if (flash > 0) { ctx.fillStyle = `rgba(255,240,200,${flash * 0.35})`; ctx.fillRect(0, 0, VIEW_W, VIEW_H); }
    if (fade > 0) { ctx.fillStyle = `rgba(5,10,18,${fade * 0.6})`; ctx.fillRect(0, 0, VIEW_W, VIEW_H); }
    drawConfetti();
    drawControls();
  }

  // =====================================================================
  //  UI
  // =====================================================================
  let bannerId = 0;
  function showBanner(title: string, msg: string, kind: 'good' | 'bad' | '') {
    setUi({ banner: { id: ++bannerId, title, msg, kind, show: true } });
  }
  function hideBanner() {
    if (ui.banner.show) setUi({ banner: { ...ui.banner, show: false } });
  }
  function syncState() {
    if (ui.state !== state) setUi({ state });
  }

  function applyProfile(p: Profile) {
    player.name = p.name;
    player.avatar = { ...p.avatar };
    player.paddle = p.paddle;
    setUi({ profile: cloneProfile(p) });
  }

  function toggleMute() {
    setMuted(!isMuted());
    if (isMuted()) hush();
    setUi({ muted: isMuted() });
  }

  // Set up who is on court for the chosen mode and stand them in their courts.
  function setMode(m: Mode) {
    mode = m;
    roster = m === 'doubles' ? [player, mate, ai, ai2] : [player, ai];
    player.court = 'R'; ai.court = 'R';
    mate.court = 'L'; ai2.court = 'L';
    for (const a of roster) {
      const h = courtHalf(a.team, a.court);
      a.x = (h[0] + h[1]) / 2;
      a.y = behindBaseline(a.team);
      a.vx = a.vy = 0;
    }
  }

  function startGame() {
    if (netRole !== 'off') return; // an online match is started by the lobby, not here
    ensureAudio();
    hush();
    freshGame = true;
    const AI = DIFFICULTY[ui.difficulty];
    ai.skill = AI;
    ai2.skill = AI;
    setMode(ui.selectedMode);
    assignBotNames(); // fresh opponents (and partner) every game
    assignBotStyles(); // ...each with their own way of playing
    resetEnergy();
    score.player = 0;
    score.ai = 0;
    streak.team = null; streak.n = 0;
    server = 'player';
    serverAth = player;
    serverNum = mode === 'doubles' ? 2 : 1; // doubles starts "0-0-2": one server only
    gameWinner = null;
    longestRally = 0;
    pointsWon = 0;
    particles = [];
    confetti = [];
    floaters = [];
    ball.squash = 0;
    releaseAllTouches();
    setUi({ menuOpen: false, overOpen: false, pauseOpen: false, suspended: false }); // a new game replaces any paused match
    setupServe();
    // introduce the opponents' styles above their heads
    for (const b of teamOf('ai')) floatText(b.x, b.y, b.style.title, '#ffb347', 0.95);
  }

  function endGame() {
    state = 'over';
    hideBanner();
    const won = gameWinner === 'player';
    const winner = gameWinner as Team;
    const winLine = `${teamLabel(winner)} ${teamVerb()}`;
    const diff = ui.difficulty;
    const label = netRole !== 'off'
      ? `Online ${mode === 'doubles' ? '2 vs 2' : '1 vs 1'} · vs ${teamLabel('ai')}`
      : `${mode === 'doubles' ? 'Doubles' : 'Singles'} · ${diff[0].toUpperCase() + diff.slice(1)}`;
    setUi({
      overOpen: true,
      state,
      gameOver: {
        title: won ? `${winLine}! 🏆` : `${winLine}`,
        score: `${score.player} – ${score.ai}`,
        stats: `Rallies won: ${pointsWon} · Longest rally: ${longestRally} shots · ${label}`,
      },
    });
    if (won) { sfx.win(); confettiBurst(220); buzz([30, 50, 30, 50, 60]); } else sfx.bad();

    const hi = Math.max(score.player, score.ai), lo = Math.min(score.player, score.ai);
    const wc = teamCenter(winner);
    if (netRole === 'host') netEmit({ k: 'over', w: toW(winner), sc: [score.player, score.ai], lr: longestRally });
    if (!isGuest()) { // the guest gets the host's call
      refCall(headRef, 'point', `Game! ${winLine} ${hi}–${lo}`, {
        target: wc, dur: 3, whistle: true,
        speech: `Game! ${winLine}, ${hi} to ${lo}.`,
      });
    }
    const otherRef = mirrored() ? refs[0] : refs[1];
    otherRef.pose = 'point'; otherRef.poseT = 3; otherRef.target = wc;

    if (netRole !== 'off') {
      const teamA = myTeamW === 0 ? score.player : score.ai;
      const teamB = myTeamW === 0 ? score.ai : score.player;
      const end: OnlineMatchEnd = {
        hostScore: teamA,
        guestScore: teamB,
        longestRally,
        rallies: rallyLog.slice(),
      };
      if (ui.online) setUi({ online: { ...ui.online, link: 'ended', menuOpen: false, note: 'Saving the result…' } });
      onlineEndListeners.forEach(fn => { try { fn(end); } catch { /* never breaks the game */ } });
      return; // online results go to the server, not to the CPU match history
    }

    const result: MatchResult = {
      mode, difficulty: diff, playerScore: score.player, aiScore: score.ai, won,
      ralliesWon: pointsWon, longestRally, opponent: teamLabel('ai'),
    };
    matchListeners.forEach(fn => { try { fn(result); } catch { /* a listener never breaks the game */ } });
  }
  const matchListeners = new Set<(r: MatchResult) => void>();

  // "Main menu" from the in-game Menu keeps the match paused behind it, so ‹ Back
  // returns to the in-game Menu and Resume. Starting a new game replaces it.
  const mainMenuOverGame = () => ui.suspended && ui.menuOpen;

  function togglePause() {
    if (netRole !== 'off') { toggleOnlineMenu(); return; } // online play can't stop
    if (mainMenuOverGame()) return; // the main menu is open over a paused match: use ‹ Back instead
    if (state === 'paused') {
      state = pausedFrom as State;
      setUi({ pauseOpen: false, state });
    } else if (state === 'serve' || state === 'rally' || state === 'point') {
      pausedFrom = state;
      state = 'paused';
      hush();
      releaseAllTouches();
      setUi({ pauseOpen: true, state });
    }
  }

  // In-game Menu -> Main menu (the match stays paused)
  function openMainMenuFromGame() {
    if (state !== 'paused') { toMenu(); return; }
    hush();
    setUi({ pauseOpen: false, menuOpen: true, suspended: true });
  }
  // Main menu -> back to the in-game Menu (Resume, Customize, Restart, Main menu)
  function backToGameMenu() {
    setUi({ menuOpen: false, pauseOpen: true, suspended: false });
  }

  let customizeSaver: (() => void) | null = null;
  function openCustomize() {
    ensureAudio();
    setUi({ customizeOpen: true });
  }
  function closeCustomize(p: Profile | null) {
    if (p) applyProfile(p);
    setUi({ customizeOpen: false });
  }

  // One "go back" used by every ‹ Back arrow and the Android back button.
  // Returns true when there was somewhere to go back to.
  function goBack(): boolean {
    if (netRole !== 'off') { // online: Back opens / closes the match menu; after the match it leaves
      if (state === 'over') requestLeaveOnline();
      else toggleOnlineMenu();
      return true;
    }
    if (ui.customizeOpen) { if (customizeSaver) customizeSaver(); else closeCustomize(null); return true; } // Customize -> previous screen
    if (mainMenuOverGame()) { backToGameMenu(); return true; }          // Main menu -> in-game Menu
    if (state === 'paused') { togglePause(); return true; }             // in-game Menu -> game
    if (state === 'over') { toMenu(); return true; }                     // Game over -> main menu
    if (state === 'serve' || state === 'rally' || state === 'point') { togglePause(); return true; } // play -> in-game Menu
    return false;                                                        // main menu with no game: nothing to go back to
  }

  function toMenu() {
    state = 'menu';
    hush();
    energy.hyperT = 0;
    for (const r of refs) { r.bubble = null; r.pose = 'idle'; }
    ball.held = true;
    setMode(ui.selectedMode);
    hideBanner();
    setUi({ pauseOpen: false, overOpen: false, menuOpen: true, suspended: false, state });
  }

  // "Menu" button: opens the in-game menu (Resume / Customize / Restart / Main menu)
  function menuButton() {
    ensureAudio();
    if (netRole !== 'off') {
      if (state === 'over') requestLeaveOnline();
      else toggleOnlineMenu();
      return;
    }
    if (state === 'menu' || ui.customizeOpen || mainMenuOverGame()) return; // already on a menu screen
    if (state === 'over') { toMenu(); return; }
    togglePause();
  }

  function setDifficulty(d: Difficulty) { setUi({ difficulty: d }); }
  function setSelectedMode(m: Mode) {
    setUi({ selectedMode: m });
    if (!ui.suspended) setMode(m); // don't disturb a paused match
  }
  function setVoice(on: boolean) {
    speech.on = on;
    if (!on) hush();
    setUi({ voiceOn: on });
  }

  // =====================================================================
  //  Online match control (driven by src/backend/online/netplay.ts)
  // =====================================================================
  const leaveListeners = new Set<() => void>();

  function toggleOnlineMenu() {
    if (!ui.online || state === 'over') return;
    releaseAllTouches();
    setUi({ online: { ...ui.online, menuOpen: !ui.online.menuOpen } });
  }

  function requestLeaveOnline() {
    leaveListeners.forEach(fn => { try { fn(); } catch { /* never breaks the game */ } });
  }

  function startOnline(o: OnlineStart) {
    ensureAudio();
    hush();
    netRole = o.role;
    netSend = o.send;
    netHold = o.role === 'host'; // nothing moves until the others say hello
    netClock = 0; snapT = 0; snapSeq = 0;
    rallyLog = []; setupGen = 0; seenGen = -1;
    streak.team = null; streak.n = 0;
    for (const a of [player, mate, ai, ai2]) a.style = STEADY_STYLE;
    lastSnap = null; guestPointsWon = 0; needLogAt = 0; inT = 0; lastInKey = ''; lastInSent = 0;
    lastReply.clear();
    lastRecv = 0;
    const doubles = o.mode === 'doubles';
    const seatCount = doubles ? 4 : 2;
    mySeat = clamp(Math.round(o.seat), 0, seatCount - 1);
    myTeamW = (mySeat % 2) as TeamW;
    setMode(o.mode);

    // Who stands where: you are always `player` (bottom). Your partner is `mate`;
    // the other side are `ai` (lower seat) and `ai2`.
    const oppSeats = [0, 1, 2, 3].slice(0, seatCount).filter(s => s % 2 !== myTeamW);
    seats = [];
    for (let s = 0; s < seatCount; s++) {
      seats[s] = s === mySeat ? player : s % 2 === myTeamW ? mate : s === oppSeats[0] ? ai : ai2;
    }
    for (const a of [player, mate, ai, ai2]) { a.seat = -1; a.net = null; }
    seats.forEach((a, s) => {
      a.seat = s;
      a.human = true;
      a.lefty = false;
      a.skill = DIFFICULTY.medium;
      a.court = s < 2 ? 'R' : 'L'; // first two seats start in the right-hand courts
      if (a !== player) a.net = { x: a.x, y: a.y, aim: 0, have: false, gen: -1, last: 0 };
    });
    for (const p of o.others) {
      const a = seatAth(p.seat);
      if (!a || a === player) continue;
      a.name = (p.look.name || 'Player').slice(0, 16);
      a.avatar = { ...p.look.avatar };
      a.paddle = p.look.paddle;
    }
    // stand everyone in their own courts
    for (const a of roster) {
      const h = courtHalf(a.team, a.court);
      a.x = (h[0] + h[1]) / 2;
      a.y = behindBaseline(a.team);
      if (a.net) { a.net.x = a.x; a.net.y = a.y; }
    }

    freshGame = true;
    resetEnergy();
    score.player = 0; score.ai = 0;
    server = fromW(0); // the host's side serves first
    serverAth = seats[0];
    serverNum = doubles ? 2 : 1; // doubles starts "0-0-2"
    gameWinner = null;
    longestRally = 0;
    pointsWon = 0;
    particles = []; confetti = []; floaters = [];
    ball.squash = 0;
    for (const r of refs) { r.bubble = null; r.pose = 'idle'; }
    releaseAllTouches();
    const r = o.resume;
    if (r && o.role === 'host') { // the host's app restarted: carry on from the last rally
      score.player = r.score[0]; score.ai = r.score[1];
      server = r.server === 0 ? 'player' : 'ai';
      serverAth = seatAth(r.serverSeat) ?? seats[0];
      serverNum = doubles && r.serverNum === 1 ? 1 : doubles ? 2 : 1;
      r.courts.forEach((c, s) => { const a = seatAth(s); if (a) a.court = c === 'L' ? 'L' : 'R'; });
      r.energy.forEach((v, s) => { const a = seatAth(s); if (a) a.en.value = clamp(v, 0, 99.9); });
      rallyLog = r.rallies.slice();
      netClock = r.clock;
      longestRally = r.longestRally;
      pointsWon = rallyLog.filter(x => x.w === 'h').length;
      freshGame = false;
    }
    const names = o.others.filter(p => p.seat % 2 !== myTeamW).map(p => p.look.name).join(' & ') || 'your opponent';
    setUi({
      menuOpen: false, overOpen: false, pauseOpen: false, suspended: false, customizeOpen: false,
      online: { role: o.role, opponent: names, link: 'waiting', menuOpen: false, note: 'Connecting…' },
    });
    if (o.role === 'host') {
      setupServe();
    } else {
      state = 'serve'; // the first snapshot fills in the rest
      ball.held = true;
      hideBanner();
      syncState();
    }
  }

  /**
   * A message from another player. On the host, `fromSeat` is the sender's seat
   * (known from the channel it arrived on); guests only hear from the host.
   */
  function netReceive(m: unknown, fromSeat = -1) {
    if (netRole === 'host') hostReceive(m, fromSeat);
    else if (netRole === 'guest') guestReceive(m);
  }

  /** Host: when each other player was last heard from (Date.now(); 0 = never), by seat. */
  function netLastBySeat(): { seat: number; last: number }[] {
    return seats.filter(a => a !== player && a.net).map(a => ({ seat: a.seat, last: (a.net as NetAth).last }));
  }

  /** Host: hold the match while someone is away (and resume when they're back). */
  function setNetHold(on: boolean, waitingFor = '') {
    if (netRole !== 'host') return;
    holdNames = on ? waitingFor : '';
    if (netHold === on) return;
    netHold = on;
    if (on) releaseAllTouches();
    else sendSnapshot();
  }

  /** Guest: who the host is waiting for (another guest who dropped out), or ''. */
  const netWaitingFor = () => (isGuest() ? lastSnap?.hw ?? '' : '');

  function setOnlineLink(link: OnlineUi['link'], note = '') {
    if (!ui.online) return;
    if (ui.online.link === link && ui.online.note === note) return;
    setUi({ online: { ...ui.online, link, note } });
  }

  /** The server ended the match (forfeit, opponent left, …) or confirmed the result. */
  function showOnlineResult(r: { title: string; score: string; stats: string; note: string; won: boolean | null }) {
    if (netRole === 'off') return;
    const wasOver = state === 'over';
    state = 'over';
    netHold = false;
    hideBanner();
    releaseAllTouches();
    setUi({
      state,
      overOpen: true,
      gameOver: wasOver ? ui.gameOver : { title: r.title, score: r.score, stats: r.stats },
      online: ui.online ? { ...ui.online, link: 'ended', menuOpen: false, note: r.note } : null,
    });
    if (!wasOver && r.won) { sfx.win(); confettiBurst(160); }
  }

  /** Leaves the online match screen (the lobby / backend side is handled by netplay). */
  function endOnline() {
    netRole = 'off';
    netSend = null;
    netHold = false;
    mySeat = 0;
    myTeamW = 0;
    seats = [];
    // the computer players come back as they were
    for (const [a, look] of [[mate, BOTS.mate], [ai, BOTS.cpu1], [ai2, BOTS.cpu2]] as const) {
      a.human = false;
      a.avatar = { ...look.avatar };
      a.paddle = look.paddle;
      a.skill = DIFFICULTY[ui.difficulty];
    }
    mate.skill = PARTNER_SKILL;
    mate.lefty = true;
    for (const a of [player, mate, ai, ai2]) { a.seat = -1; a.net = null; }
    assignBotNames();
    resetEnergy();
    setUi({ online: null });
    toMenu();
  }

  /** What the host needs to resume after an app restart (null when not hosting). */
  function exportResume(): OnlineResume | null {
    if (netRole !== 'host') return null;
    return {
      score: [score.player, score.ai],
      server: server === 'player' ? 0 : 1,
      serverSeat: serverAth.seat,
      serverNum,
      courts: seats.map(a => a.court),
      energy: seats.map(a => a.en.value),
      rallies: rallyLog.slice(),
      clock: Math.round(netClock),
      longestRally,
    };
  }

  // =====================================================================
  //  Main loop (fixed 120 Hz physics step)
  // =====================================================================
  const STEP = 1 / 120;
  let last = -1;
  let acc = 0;
  let trailTick = 0;

  // Frame-time monitor: lowers quality on slow devices, raises it when there is headroom
  const perf = { work: 6, interval: 16.7, lastCheck: 0, lastChange: 0, maxQuality: 2 };
  function adaptQuality(now: number, workMs: number, intervalMs: number) {
    if (intervalMs > 250) return; // app switches etc. aren't slowness
    perf.work += (workMs - perf.work) * 0.05;
    perf.interval += (intervalMs - perf.interval) * 0.05;
    if (now - perf.lastCheck < 1000 || state === 'menu') return;
    perf.lastCheck = now;
    const slow = perf.work > 11 || perf.interval > 21;   // under ~48 fps
    const fast = perf.work < 4.5 && perf.interval < 17.6;
    if (slow && quality > 0 && now - perf.lastChange > 2500) {
      quality--;
      perf.maxQuality = quality; // don't bounce back up to a level that struggled
      perf.lastChange = now;
    } else if (fast && quality < perf.maxQuality && now - perf.lastChange > 10000) {
      quality++;
      perf.lastChange = now;
    }
  }

  /** Advance the simulation to `now` (ms) and record the frame. */
  function frame(now: number): SkPicture {
    const interval = last < 0 ? 16.7 : now - last;
    const dt = Math.min(0.05, interval / 1000);
    last = now;
    const t0 = Date.now();
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 8) { // never spiral if a frame was very late
      update(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === 8) acc = 0;
    if (state !== 'paused' && (trailTick = (trailTick + 1) % 2) === 0) {
      if (!ball.held) {
        trail.push({ x: ball.x, y: ball.y, z: ball.z, hot: Math.hypot(ball.vx, ball.vy) > 48, power: !!ball.power });
        if (trail.length > 10) trail.shift();
      } else if (trail.length) {
        trail.shift();
      }
    }
    const canvas = frameRecorder.beginRecording(Skia.XYWHRect(0, 0, VIEW_W, VIEW_H));
    if (!frameCtx) frameCtx = new Ctx2D(canvas);
    else frameCtx.reset(canvas);
    ctx = frameCtx;
    draw();
    const pic = frameRecorder.finishRecordingAsPicture();
    if (use3D && ctx === frontCtx) frontPic = frontRecorder.finishRecordingAsPicture();
    ctx = frameCtx;
    adaptQuality(now, Date.now() - t0, interval);
    return pic;
  }

  // ---------- 3D players ----------
  /** Turn the 3D player layer on (after it loaded) or off (back to the drawn 2D players). */
  function set3D(on: boolean) { use3D = on; frontPic = null; }
  /** The foreground picture of the last frame (only in 3D mode): drawn above the 3D layer. */
  function overlay(): SkPicture | null { return use3D ? frontPic : null; }
  /** Everything painted on the floor this frame (the same marks the 2D view draws), for the 3D floor. */
  function decals3D(): Decal3D[] {
    const d: Decal3D[] = [];
    const quad = (x0: number, y0: number, x1: number, y1: number, c: string, a: number): Decal3D => ({ k: 'quad', x: x0, y: y0, x1, y1, rx: 0, ry: 0, c, a });
    d.push(quad(-1, NET_Y, COURT_W + 1, NET_Y + 1.1, '#000000', 0.18)); // net shadow
    if (state === 'serve' && serveBox) d.push(quad(serveBox.x0, serveBox.y0, serveBox.x1, serveBox.y1, '#d7f23b', 0.12 + 0.08 * Math.sin(clock * 5)));
    if (state === 'rally' && lastHitter === 'ai' && bounces === 0 && shots >= 3 && inKitchen('player', player.y)) {
      d.push(quad(0, NET_Y, COURT_W, BOT_KITCHEN, '#ff5050', 0.14 + 0.06 * Math.sin(clock * 14)));
    }
    if (landing && state === 'rally') {
      const r = 0.7 + Math.sin(clock * 12) * 0.1;
      d.push({ k: 'dash', x: landing.x, y: landing.y, rx: r, ry: r, w: 0.09, c: '#ffffff', a: 0.55, rot: -clock * 2 });
    }
    d.push({ k: 'disc', soft: true, x: ball.x, y: ball.y, rx: 0.3, ry: 0.3, c: '#000000', a: clamp(0.5 - ball.z * 0.035, 0.1, 0.5) });
    for (const r of refs) d.push({ k: 'disc', soft: true, x: r.x, y: r.y, rx: 1.3, ry: 1.0, c: '#000000', a: 0.3 });
    for (const p of roster) {
      const hop = p.jump > 0 ? Math.sin((1 - p.jump) * Math.PI) : 0;
      d.push({ k: 'disc', soft: true, x: p.x + 0.12, y: p.y + 0.1, rx: 1.05 * (1 - hop * 0.2), ry: 0.7 * (1 - hop * 0.2), c: '#000000', a: 0.42 });
      if (p.human && p.en.hyperT > 0) { // Hyper mode: electric ring under the player
        const pulse = 0.5 + 0.5 * Math.sin(clock * 14);
        d.push({ k: 'ring', x: p.x, y: p.y, rx: 1.6 + pulse * 0.35, ry: 1.6 + pulse * 0.35, w: 0.14, c: '#7cf2ff', a: 0.6 + 0.35 * pulse });
        d.push({ k: 'disc', x: p.x, y: p.y, rx: 2.2, ry: 2.2, c: '#7cf2ff', a: 0.14 + 0.08 * pulse });
      }
      if (p === player && p.queued && p.swing > 0) { // a shot is ready and waiting for the ball
        const r = 1.95 + 0.25 * Math.sin(clock * 12);
        d.push({ k: 'ring', x: p.x, y: p.y, rx: r, ry: r, w: 0.12, c: '#d7f23b', a: 0.9 });
      }
      if (p.human) {
        d.push({ k: 'ring', x: p.x, y: p.y, rx: 1.35, ry: 1.35, w: 0.09, c: '#ffffff', a: 0.65 + 0.25 * Math.sin(clock * 4) });
        d.push({ k: 'ring', x: p.x, y: p.y, rx: 1.75, ry: 1.75, w: 0.09, c: '#3aa0ff', a: 0.55 });
      }
    }
    return d;
  }
  /** Who has the ball on their palm: waiting to serve and carrying it to the drop (not after it is let go). */
  function heldBy3D(): string | null {
    if (!ball.held || (serveWind && serveWind.t >= SERVE_CARRY)) return null;
    const who = serveWind ? serveWind.who : serverAth;
    return Math.hypot(ball.x - who.x, ball.y - who.y) < 2.5 && ball.z < 5.5 ? who.id : null;
  }
  /** Where this player's paddle meets the ball in the current stroke (world feet), if known. */
  function contactFor(a: Athlete): { x: number; y: number; z: number } | null {
    if (!a.stroke) return null;
    if (a.cpt) return { ...a.cpt };
    if (serveWind && serveWind.who === a) { // the serve: the ball drops to the paddle in front of the hip
      const towardNet = a.team === 'ai' ? 1 : -1;
      return { x: a.x + domSign(a) * SERVE_RELEASE[0], y: a.y + towardNet * SERVE_RELEASE[2], z: SERVE_CONTACT_Z };
    }
    return null;
  }
  /** Everything the 3D layer needs to draw this frame, in court feet (x across, y along, z up). */
  function scene3D(): Scene3D {
    const st = state === 'paused' ? pausedFrom : state;
    return {
      w: VIEW_W, h: VIEW_H,
      cam: { x: cam.x, y: cam.y, h: cam.h, f: cam.f, cx: cam.cx + view3D.ox, hor: cam.hor + view3D.oy },
      paused: state === 'paused',
      clock,
      ball: {
        x: ball.x, y: ball.y, z: ball.z, spin: ball.spin, squash: ball.squash,
        visible: true,
        // in the server's hand until it is let go during the serve
        holder: heldBy3D(),
      },
      hall: { left: HALL.left, right: HALL.right, back: HALL.back, ceil: HALL.ceil, pad: HALL.pad, near: hallNear(), lights: LIGHTS, dividers: DIVIDER_X, benches: BENCHES },
      decals: decals3D(),
      refs: refs.map(r => ({ x: r.x, y: r.y, face: r.face, pose: r.pose, look: r.look, target: r.target ? { ...r.target } : null })),
      athletes: roster.map(a => ({
        id: a.id, team: a.team, lefty: a.lefty, x: a.x, y: a.y, vx: a.vx, vy: a.vy,
        lift: (a.jump > 0 ? Math.sin((1 - a.jump) * Math.PI) : 0) + (a.split > 0 ? Math.sin((1 - a.split) * Math.PI) * 0.3 : 0),
        stroke: a.stroke, strokeT: a.strokeT, prep: a.prep, prepKind: a.prepKind,
        inRally: st === 'rally', cheer: a.cheer > 0,
        avatar: a.avatar, paddle: a.paddle,
        serving: st === 'serve' && a === serverAth && !a.stroke,
        serverMark: st === 'serve' && a === serverAth,
        contact: contactFor(a),
      })),
    };
  }

  function resize(w: number, h: number) {
    const W = Math.max(200, Math.round(w));
    const H = Math.max(200, Math.round(h));
    if (W === VIEW_W && H === VIEW_H) return;
    VIEW_W = W;
    VIEW_H = H;
    fitCamera(); // keeps the court clear of the floating controls
    layoutControls();
    bgCache.key = ''; // scenery must be redrawn for the new size
    vignette = null;
  }

  // =====================================================================
  //  Loading screen — real setup steps drive the progress bar
  // =====================================================================
  const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
  const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  async function runLoader(loadProfileFn: () => Promise<Profile>) {
    const started = Date.now();
    const MIN_SHOW = 1800; // long enough to read, short enough not to annoy
    let tipIdx = LOAD_TIPS.indexOf(ui.loader.tip) + 1;
    const tipTimer = setInterval(() => {
      setUi({ loader: { ...ui.loader, tip: LOAD_TIPS[tipIdx++ % LOAD_TIPS.length] } });
    }, 2200);
    const setProgress = (f: number, status: string) => setUi({ loader: { ...ui.loader, progress: (8 + f * 92) / 100, status } });

    const steps: [string, () => Promise<unknown> | null][] = [
      ['Setting up the court…', async () => {
        applyProfile(await loadProfileFn());
        setMode('singles');
        await nextFrame();
      }],
      ['Painting paddles…', async () => {
        for (const p of PADDLES) { paddleSprite(p.id, PADDLE_RES); await nextFrame(); }
      }],
      ['Dressing the players…', async () => { await nextFrame(); }],
      ['Calling the referees…', () => waitForVoices(1200)],
      ['Loading fonts…', async () => {
        // warm the font cache used by the court
        const warm = new Ctx2D(Skia.PictureRecorder().beginRecording(Skia.XYWHRect(0, 0, 10, 10)));
        for (const f of ['700 10px system-ui', '800 13px system-ui', '900 11px system-ui', '900 14px system-ui', '900 16px system-ui']) {
          warm.font = f;
          warm.measureText('Pickleball');
        }
        await nextFrame();
      }],
      ['Almost ready…', () => null],
    ];

    for (let i = 0; i < steps.length; i++) {
      setUi({ loader: { ...ui.loader, status: steps[i][0] } });
      try { await steps[i][1](); } catch { /* a failed extra never blocks the game */ }
      setProgress((i + 1) / steps.length, steps[i][0]);
    }

    const left = MIN_SHOW - (Date.now() - started);
    if (left > 0) await wait(left);
    setUi({ loader: { ...ui.loader, status: 'Ready!', progress: 1 } });
    await wait(350);
    clearInterval(tipTimer);
    setUi({ loader: { ...ui.loader, done: true } });
    await wait(700);
    setUi({ loading: false });
  }

  // initial scene
  layoutControls();
  assignBotNames();
  setMode('singles');

  return {
    // store
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getUi: () => ui,
    // lifecycle
    frame,
    resize,
    runLoader,
    // 3D players
    set3D, overlay, scene3D,
    autoPause,
    // input
    touchStart, touchMove, touchEnd, releaseAllTouches,
    // screens
    startGame, togglePause, toMenu, goBack, menuButton, openMainMenuFromGame, backToGameMenu,
    openCustomize, closeCustomize,
    setCustomizeSaver(fn: (() => void) | null) { customizeSaver = fn; },
    toggleMute, setDifficulty, setSelectedMode, setVoice,
    // read-only snapshot for automated tests (no effect on the game)
    debug: () => ({
      state, px: player.x, py: player.y, bx: ball.x, by: ball.y, bz: ball.z,
      energy: energy.value, hyperT: energy.hyperT, shots, bounces, lastHitter, buttons,
      ox: ai.x, oy: ai.y, oppEnergy: ai.en.value, oppHyperT: ai.en.hyperT,
      seat: mySeat, mode,
      athletes: roster.map(a => ({ seat: a.seat, x: a.x, y: a.y, team: a.team, name: a.name, hyperT: a.en.hyperT })),
      serverSeat: serverAth.seat, serverNum,
      bots: roster.filter(a => !a.human).map(a => ({ team: a.team, style: a.style.title, energy: a.en.value, hyperT: a.en.hyperT })),
      streak: { ...streak },
      score: { player: score.player, ai: score.ai }, server, serverIsMe: serverAth === player,
      held: ball.held, rallies: rallyLog.slice(), netHold, role: netRole, gameWinner,
      bvx: ball.vx, bvy: ball.vy, bvz: ball.vz, queued: !!player.queued,
      // the ball relative to the server's body [u toward the paddle hand, z up, w toward the net]
      serveBall: [(ball.x - serverAth.x) * domSign(serverAth), ball.z, (ball.y - serverAth.y) * (serverAth.team === 'ai' ? 1 : -1)],
      serveWindT: serveWind ? serveWind.t : -1, serverStroke: serverAth.stroke, serverStrokeT: serverAth.strokeT,
      // your swing: where the paddle face is (target pose and what is drawn) vs where the ball was hit
      swing: player.stroke && player.cpt ? {
        kind: player.stroke, t: player.strokeT,
        face: faceOf(poseFor(player).hand), drawn: player.vis ? faceOf(player.vis.hand) : null,
        ball: toBody(player, player.cpt.x, player.cpt.y, player.cpt.z), crouch: poseFor(player).crouch,
      } : null,
    }),
    // cloud
    setProfile: applyProfile,
    onMatchEnd(fn: (r: MatchResult) => void) { matchListeners.add(fn); return () => { matchListeners.delete(fn); }; },
    // online
    startOnline, netReceive, setNetHold, setOnlineLink, endOnline, exportResume, toggleOnlineMenu, showOnlineResult,
    requestLeaveOnline,
    netLastRecv: () => lastRecv,
    netLastBySeat,
    netWaitingFor,
    netRole: () => netRole,
    onOnlineEnd(fn: (r: OnlineMatchEnd) => void) { onlineEndListeners.add(fn); return () => { onlineEndListeners.delete(fn); }; },
    onRally(fn: () => void) { rallyListeners.add(fn); return () => { rallyListeners.delete(fn); }; },
    onLeaveRequest(fn: () => void) { leaveListeners.add(fn); return () => { leaveListeners.delete(fn); }; },
    /** Advances the simulation without drawing (automated tests only). */
    step(seconds: number) { for (let t = 0; t < seconds; t += STEP) update(STEP); },
    /** Test autopilot: moves your player and taps shots (automated tests only). */
    testInput(i: { dx?: number; dy?: number; tap?: ShotType; hyper?: boolean }) {
      if (i.dx !== undefined || i.dy !== undefined) {
        const dx = i.dx ?? 0, dy = i.dy ?? 0;
        if (dx === 0 && dy === 0) releaseJoystick();
        else { joy.active = true; joy.id = -99; joy.x = clamp(dx, -1, 1); joy.y = clamp(dy, -1, 1); }
      }
      if (i.tap) action(i.tap);
      if (i.hyper) pressHyper();
    },
  };
}

export type Game = ReturnType<typeof createGame>;
