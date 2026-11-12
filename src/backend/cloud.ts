// Connects the game to Supabase:
//  - keeps track of who is signed in (for the Account / History / Leaderboard screens)
//  - profile: on sign-in the cloud copy is loaded (or the phone's profile is uploaded
//    the first time); after that every saved change in Customize is uploaded
//  - matches: every finished match is saved; if the player is signed out or offline
//    it is queued on the phone and uploaded on the next sign-in
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import type { Game, MatchResult } from '../game/engine';
import { Profile, sanitizeProfile, saveProfile as saveLocalProfile } from '../game/customize';
import * as api from './api';
import { cloudConfigured } from './config';
import { Client, supabase } from './supabase';
import type { MatchInsert } from './types';

export interface AccountState {
  /** A Supabase key is configured in src/backend/config.ts. */
  configured: boolean;
  /** The saved login has been checked. */
  ready: boolean;
  userId: string | null;
  email: string | null;
  /** Matches waiting to be uploaded. */
  pending: number;
}

const PENDING_KEY = 'pickleball.pendingMatches.v1';
const MAX_PENDING = 50;

let state: AccountState = { configured: cloudConfigured, ready: !cloudConfigured, userId: null, email: null, pending: 0 };
const listeners = new Set<() => void>();
function set(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
}

export const account = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: () => state,
};

/** The client when cloud features are usable. */
export function client(): Client {
  if (!supabase) throw new api.CloudError('Cloud features are not set up yet.');
  return supabase;
}

/** A profile the app never saved (created automatically when the account was made). */
export const isBlankProfile = (row: { avatar: unknown }) =>
  !row.avatar || typeof row.avatar !== 'object' || Object.keys(row.avatar as object).length === 0;

export const profileKey = (p: Profile) => JSON.stringify([p.name, p.paddle, p.avatar, p.age ?? null]);

export function toMatchInsert(r: MatchResult, playedAt = new Date().toISOString()): MatchInsert {
  return {
    mode: r.mode,
    difficulty: r.difficulty,
    player_score: r.playerScore,
    ai_score: r.aiScore,
    won: r.won,
    rallies_won: r.ralliesWon,
    longest_rally: r.longestRally,
    opponent: r.opponent.slice(0, 80),
    played_at: playedAt,
  };
}

// ---------------------------------------------------------------------------
// Offline queue for finished matches
// ---------------------------------------------------------------------------
async function readPending(): Promise<MatchInsert[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
async function writePending(list: MatchInsert[]) {
  const trimmed = list.slice(-MAX_PENDING);
  try { await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(trimmed)); } catch { /* storage unavailable */ }
  set({ pending: trimmed.length });
}
async function queueMatch(m: MatchInsert) {
  await writePending([...(await readPending()), m]);
}

let flushing = false;
async function flushPending() {
  if (flushing || !supabase || !state.userId) return;
  flushing = true;
  try {
    const list = await readPending();
    if (list.length) {
      await api.addMatches(supabase, list);
      await writePending([]);
    }
  } catch {
    /* stays queued; retried on the next match or sign-in */
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
/** Starts syncing for this game. Returns a function that stops it. */
export function startCloud(game: Game): () => void {
  readPending().then(l => set({ pending: l.length }));
  if (!supabase) return () => {};
  const db = supabase;

  let lastSynced = '';      // profile last known to match the cloud
  let profileLoaded = false; // don't upload before the cloud copy was checked

  async function onSignedIn(userId: string) {
    profileLoaded = false;
    try {
      const row = await api.getProfile(db, userId);
      if (state.userId !== userId) return; // signed out meanwhile
      // The database creates a blank profile at sign-up (empty avatar). Treat that
      // as "nothing saved yet" and upload the look from this phone instead.
      if (row && !isBlankProfile(row)) {
        const p = sanitizeProfile(row);
        lastSynced = profileKey(p);
        game.setProfile(p);
        saveLocalProfile(p);
      } else {
        const p = game.getUi().profile;
        await api.saveProfile(db, userId, p as unknown as api.CloudProfile);
        lastSynced = profileKey(p);
      }
      profileLoaded = true;
    } catch {
      profileLoaded = true; // offline: later Customize saves will still be uploaded
    }
    flushPending();
  }

  const { data: authSub } = db.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;
    const changed = user?.id !== state.userId;
    set({ ready: true, userId: user?.id ?? null, email: user?.email ?? null });
    // Supabase advises not to await other calls inside this callback
    if (user && changed) setTimeout(() => onSignedIn(user.id), 0);
    if (!user) { lastSynced = ''; profileLoaded = false; }
  });

  // Upload Customize changes
  const unProfile = game.subscribe(() => {
    const userId = state.userId;
    if (!userId || !profileLoaded) return;
    const p = game.getUi().profile;
    const key = profileKey(p);
    if (key === lastSynced) return;
    lastSynced = key;
    api.saveProfile(db, userId, p as unknown as api.CloudProfile).catch(() => { lastSynced = ''; });
  });

  // Save every finished match
  const unMatch = game.onMatchEnd(async result => {
    const row = toMatchInsert(result);
    if (!state.userId) { await queueMatch(row); return; }
    try {
      await api.addMatches(db, [row]);
      flushPending();
    } catch {
      await queueMatch(row);
    }
  });

  // Refresh the login token only while the app is in the foreground
  const appSub = AppState.addEventListener('change', s => {
    if (s === 'active') db.auth.startAutoRefresh();
    else db.auth.stopAutoRefresh();
  });
  db.auth.startAutoRefresh();

  return () => {
    authSub.subscription.unsubscribe();
    unProfile();
    unMatch();
    appSub.remove();
    db.auth.stopAutoRefresh();
  };
}
