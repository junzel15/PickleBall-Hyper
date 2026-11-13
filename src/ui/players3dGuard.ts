// Crash guard for the 3D layer. A native crash (GPU driver, missing library) kills the app before
// any JS fallback can run, so an attempt is recorded just before 3D starts and cleared as soon as
// 3D has drawn its first frame (or after a short start-up window). Only an app that died *inside*
// that window counts as a start-up crash, and 3D is only given up after two in a row. Being swiped
// away, killed in the background or closed later never counts, and a new app version retries 3D.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'pbh.players3d.v5';
const STARTUP_WINDOW_MS = 12000; // a native start-up crash happens within seconds of starting 3D
const MAX_CRASHES = 2;           // consecutive start-up crashes before this phone stays 2D

interface GuardState { starting: boolean; crashes: number }

async function read(): Promise<GuardState> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const s = raw ? JSON.parse(raw) : null;
    if (s && typeof s === 'object') return { starting: !!s.starting, crashes: Number(s.crashes) || 0 };
  } catch { /* unreadable: start fresh */ }
  return { starting: false, crashes: 0 };
}
const write = (s: GuardState) => AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});

/** The state left by the previous launch, settled once per launch. */
let launch: Promise<GuardState> | null = null;
function atLaunch(): Promise<GuardState> {
  if (!launch) {
    launch = read().then(async s => {
      if (s.starting) { // the last launch died while 3D was starting up
        s = { starting: false, crashes: s.crashes + 1 };
        await write(s);
      }
      return s;
    });
  }
  return launch;
}

/** True if this launch may use 3D (and records that 3D is starting). */
export async function begin3DAttempt(): Promise<boolean> {
  const s = await atLaunch();
  if (s.crashes >= MAX_CRASHES) return false;
  await write({ starting: true, crashes: s.crashes });
  // past the start-up window it is no longer a start-up crash (slow phone, app sent to the background)
  setTimeout(() => { read().then(cur => { if (cur.starting) write({ ...cur, starting: false }); }); }, STARTUP_WINDOW_MS);
  return true;
}

/** 3D drew its first frame (ok) or failed safely in JS (not ok): either way it did not crash. */
export function end3DAttempt(ok: boolean): void {
  read().then(cur => write(ok ? { starting: false, crashes: 0 } : { ...cur, starting: false }));
}

/** True once 3D crashed at start-up twice in a row on this phone. */
export async function is3DOff(): Promise<boolean> {
  return (await atLaunch()).crashes >= MAX_CRASHES;
}
