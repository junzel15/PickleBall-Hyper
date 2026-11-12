// CRUD for the cloud data: auth, profile, match history and leaderboard.
// Every function takes the client explicitly so it can be tested with a fake one.
import type { Client } from './supabase';
import type { LeaderboardRow, MatchInsert, MatchRow, ProfileRow } from './types';

/** Thrown with a message that is safe to show to the player. */
export class CloudError extends Error {}
/** Sign-up was tried with an email that already has an account. */
export class AccountExistsError extends CloudError {}

// Accounts made by the app are created already confirmed. This only appears for an
// older account that was created through Supabase's email-confirmation sign-up.
const CONFIRMATION_ON =
  'This account was never confirmed. Please create a new account with a different email.';

function fail(error: { message?: string; code?: string } | null | undefined, fallback: string): never {
  const msg = error?.message || '';
  const code = error?.code || '';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) throw new CloudError(CONFIRMATION_ON);
  if (/error sending .*email/i.test(msg)) {
    throw new CloudError('Registration isn\'t available right now. Please try again later.');
  }
  if (/invalid login credentials/i.test(msg)) throw new CloudError('Wrong email or password.');
  if (code === 'user_already_exists' || code === 'email_exists' || /already registered|already been registered/i.test(msg)) {
    throw new AccountExistsError('This email already has an account. Use Sign in instead.');
  }
  if (code === 'over_request_rate_limit' || /rate limit/i.test(msg)) {
    throw new CloudError('Too many attempts. Please wait a minute and try again.');
  }
  if (code === 'weak_password' || (/password/i.test(msg) && /(least|short|weak)/i.test(msg))) {
    throw new CloudError('Password is too weak. Use at least 6 characters.');
  }
  if (/network|fetch|timed? ?out/i.test(msg)) throw new CloudError('No connection. Check your internet and try again.');
  throw new CloudError(msg || fallback);
}

// ---------------------------------------------------------------------------
// Auth: email + password, no email verification step
// ---------------------------------------------------------------------------
export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

/**
 * Creates the account and signs the player in straight away. No email is sent:
 * the `register` Edge Function (supabase/functions/register) creates the account
 * as already confirmed, then the app signs in with the same email and password.
 * `name` is the player's in-game name; the database copies it into the new profile.
 */
export async function signUp(db: Client, email: string, password: string, name?: string): Promise<void> {
  const { error } = await db.functions.invoke('register', {
    body: { email: email.trim(), password, name: name ?? '' },
  });
  if (error) {
    let code = '';
    try {
      // FunctionsHttpError carries the function's JSON reply in `context`
      const res = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context;
      code = (await res?.json?.())?.error ?? '';
    } catch {
      /* not a JSON reply */
    }
    if (code === 'email_exists') throw new AccountExistsError('This email already has an account. Use Sign in instead.');
    if (code === 'invalid_email') throw new CloudError('Enter a valid email address.');
    if (code === 'weak_password') throw new CloudError('Password is too weak. Use at least 6 characters.');
    if (/fetch|network|relay|timed? ?out/i.test(error.message ?? '')) {
      throw new CloudError('No connection. Check your internet and try again.');
    }
    throw new CloudError('Could not create the account. Please try again.');
  }
  await signIn(db, email, password);
}

export async function signIn(db: Client, email: string, password: string): Promise<void> {
  const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });
  if (error) fail(error, 'Could not sign in.');
}

export async function signOut(db: Client): Promise<void> {
  const { error } = await db.auth.signOut();
  if (error) fail(error, 'Could not sign out.');
}

export async function resetPassword(db: Client, email: string): Promise<void> {
  const { error } = await db.auth.resetPasswordForEmail(email.trim());
  if (error) fail(error, 'Could not send the reset email.');
}

// ---------------------------------------------------------------------------
// Profile (Create / Read / Update / Delete)
// ---------------------------------------------------------------------------
export interface CloudProfile { name: string; avatar: Record<string, unknown>; paddle: string; age?: number | null }

export async function getProfile(db: Client, userId: string): Promise<ProfileRow | null> {
  const { data, error } = await db.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) fail(error, 'Could not load your profile.');
  return data;
}

/** Creates the profile the first time, updates it after that. */
export async function saveProfile(db: Client, userId: string, p: CloudProfile): Promise<void> {
  const { error } = await db
    .from('profiles')
    .upsert({ id: userId, name: p.name, avatar: p.avatar, paddle: p.paddle, age: p.age ?? null }, { onConflict: 'id' });
  if (error) fail(error, 'Could not save your profile.');
}

export async function deleteProfile(db: Client, userId: string): Promise<void> {
  const { error } = await db.from('profiles').delete().eq('id', userId);
  if (error) fail(error, 'Could not delete your profile.');
}

// ---------------------------------------------------------------------------
// Match history (Create / Read / Delete)
// ---------------------------------------------------------------------------
export async function addMatches(db: Client, matches: MatchInsert[]): Promise<void> {
  if (!matches.length) return;
  const { error } = await db.from('matches').insert(matches);
  if (error) fail(error, 'Could not save the match.');
}

export async function listMatches(db: Client, limit = 50): Promise<MatchRow[]> {
  const { data, error } = await db
    .from('matches')
    .select('*')
    .order('played_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Could not load your matches.');
  return data ?? [];
}

export async function deleteMatch(db: Client, id: number): Promise<void> {
  const { error } = await db.from('matches').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the match.');
}

/** RLS limits this to the signed-in player's own matches. */
export async function deleteAllMatches(db: Client, userId: string): Promise<void> {
  const { error } = await db.from('matches').delete().eq('user_id', userId);
  if (error) fail(error, 'Could not delete your matches.');
}

// ---------------------------------------------------------------------------
// Leaderboard (Read)
// ---------------------------------------------------------------------------
export async function getLeaderboard(db: Client, maxRows = 20): Promise<LeaderboardRow[]> {
  const { data, error } = await db.rpc('get_leaderboard', { max_rows: maxRows });
  if (error) fail(error, 'Could not load the leaderboard.');
  return (data ?? []) as LeaderboardRow[];
}
