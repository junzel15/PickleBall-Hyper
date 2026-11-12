/**
 * Tests for the Supabase CRUD layer, using a fake client (no network).
 * @format
 */
import * as api from '../src/backend/api';
import { profileKey, toMatchInsert } from '../src/backend/cloud';
import { sanitizeProfile } from '../src/game/customize';
import type { Client } from '../src/backend/supabase';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
jest.mock('@shopify/react-native-skia', () => ({
  StrokeCap: {}, StrokeJoin: {}, PaintStyle: {}, ClipOp: {}, TileMode: {}, BlendMode: {},
}));
// No real client in tests: cloud.ts only needs the module to load.
jest.mock('../src/backend/supabase', () => ({ supabase: null }));

/** Records every query-builder call and resolves with `result`. */
function fakeClient(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'upsert', 'delete', 'eq', 'order', 'limit', 'maybeSingle']) {
    builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null });
  const auth = {
    signUp: jest.fn(async () => ({ data: { session: null }, error: result.error ?? null })),
    signInWithPassword: jest.fn(async () => ({ data: {}, error: result.error ?? null })),
    signOut: jest.fn(async () => ({ error: null })),
    resetPasswordForEmail: jest.fn(async () => ({ data: {}, error: null })),
  };
  const invoke = jest.fn(async (..._args: unknown[]) => ({ data: { ok: true } as unknown, error: null as unknown }));
  const db = {
    functions: { invoke },
    from: (table: string) => { calls.push(['from', table]); return builder; },
    rpc: async (fn: string, args: unknown) => { calls.push(['rpc', fn, args]); return { data: result.data ?? null, error: result.error ?? null }; },
    auth,
  };
  return { db: db as unknown as Client, calls, auth, invoke };
}

describe('config', () => {
  test('project URL works with or without /rest/v1/', () => {
    const { normalizeUrl } = require('../src/backend/config');
    expect(normalizeUrl('https://abc.supabase.co/rest/v1/')).toBe('https://abc.supabase.co');
    expect(normalizeUrl(' https://abc.supabase.co/ ')).toBe('https://abc.supabase.co');
    expect(normalizeUrl(undefined)).toBe('');
  });
});

describe('auth', () => {
  test('validates emails', () => {
    expect(api.isValidEmail('a@b.co')).toBe(true);
    expect(api.isValidEmail(' a@b.co ')).toBe(true);
    expect(api.isValidEmail('nope')).toBe(false);
  });

  test('create account uses the register function (no email) and then signs in', async () => {
    const { db, auth, invoke } = fakeClient({});
    await expect(api.signUp(db, ' x@y.com ', 'secret1', 'Ana')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('register', { body: { email: 'x@y.com', password: 'secret1', name: 'Ana' } });
    expect(auth.signUp).not.toHaveBeenCalled(); // the email-sending sign-up is never used
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'x@y.com', password: 'secret1' });
  });

  test('an email that already has an account is reported', async () => {
    const { db, invoke, auth } = fakeClient({});
    invoke.mockResolvedValueOnce({ data: null, error: { message: 'non-2xx', context: { json: async () => ({ error: 'email_exists' }) } } });
    await expect(api.signUp(db, 'x@y.com', 'secret1')).rejects.toBeInstanceOf(api.AccountExistsError);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  test('register errors become friendly messages', async () => {
    const weak = fakeClient({});
    weak.invoke.mockResolvedValueOnce({ data: null, error: { message: 'x', context: { json: async () => ({ error: 'weak_password' }) } } });
    await expect(api.signUp(weak.db, 'x@y.com', 'secret1')).rejects.toThrow('at least 6 characters');
    const offline = fakeClient({});
    offline.invoke.mockResolvedValueOnce({ data: null, error: { message: 'Failed to send a request to the Edge Function', context: {} } });
    await expect(api.signUp(offline.db, 'x@y.com', 'secret1')).rejects.toThrow('Could not create the account');
  });

  test('an old never-confirmed account gets a clear message at sign in', async () => {
    const { db } = fakeClient({ error: { message: 'Email not confirmed' } });
    await expect(api.signIn(db, 'old@y.com', 'secret1')).rejects.toThrow('never confirmed');
  });

  test('sign in with email and password', async () => {
    const { db, auth } = fakeClient({});
    await api.signIn(db, ' x@y.com ', 'secret1');
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'x@y.com', password: 'secret1' });
  });

  test('wrong password gives a friendly message', async () => {
    const { db } = fakeClient({ error: { message: 'Invalid login credentials' } });
    await expect(api.signIn(db, 'x@y.com', 'bad')).rejects.toThrow('Wrong email or password.');
  });
});

describe('profile CRUD', () => {
  test('read uses the user id', async () => {
    const row = { id: 'u1', name: 'Sam', avatar: {}, paddle: 'ember-blaze' };
    const { db, calls } = fakeClient({ data: row });
    await expect(api.getProfile(db, 'u1')).resolves.toEqual(row);
    expect(calls).toContainEqual(['from', 'profiles']);
    expect(calls).toContainEqual(['eq', 'id', 'u1']);
  });

  test('save upserts on id, including the age', async () => {
    const { db, calls } = fakeClient({});
    await api.saveProfile(db, 'u1', { name: 'Sam', avatar: { hair: 'bun' }, paddle: 'nova-pulse', age: 27 });
    expect(calls).toContainEqual(['upsert', { id: 'u1', name: 'Sam', avatar: { hair: 'bun' }, paddle: 'nova-pulse', age: 27 }, { onConflict: 'id' }]);
    const noAge = fakeClient({});
    await api.saveProfile(noAge.db, 'u1', { name: 'Sam', avatar: {}, paddle: 'nova-pulse' });
    expect(noAge.calls).toContainEqual(['upsert', { id: 'u1', name: 'Sam', avatar: {}, paddle: 'nova-pulse', age: null }, { onConflict: 'id' }]);
  });

  test('age is a whole number from 5 to 120, otherwise empty', () => {
    const { cleanAge } = require('../src/game/customize');
    expect(cleanAge('25')).toBe(25);
    expect(cleanAge(' 7 ')).toBe(7);
    expect(cleanAge(4)).toBeNull();
    expect(cleanAge('121')).toBeNull();
    expect(cleanAge('2a')).toBeNull();
    expect(cleanAge(12.5)).toBeNull();
    expect(sanitizeProfile({ name: 'A', age: 30 }).age).toBe(30);
    expect(sanitizeProfile({ name: 'A', age: 'x' }).age).toBeNull();
  });

  test('delete removes only that profile', async () => {
    const { db, calls } = fakeClient({});
    await api.deleteProfile(db, 'u1');
    expect(calls).toEqual([['from', 'profiles'], ['delete'], ['eq', 'id', 'u1']]);
  });

  test('a downloaded profile is sanitized', () => {
    const p = sanitizeProfile({ name: '  Ana  ', paddle: 'unknown', avatar: { hair: 'curly', skin: 'bad' } });
    expect(p.name).toBe('Ana');
    expect(p.paddle).toBe('tidal-wave');
    expect(p.avatar.hair).toBe('curly');
  });

  test('the auto-created blank profile is not loaded over the phone profile', () => {
    const { isBlankProfile } = require('../src/backend/cloud');
    expect(isBlankProfile({ avatar: {} })).toBe(true);
    expect(isBlankProfile({ avatar: null })).toBe(true);
    expect(isBlankProfile({ avatar: { hair: 'bun' } })).toBe(false);
  });

  test('profile key changes when the look changes', () => {
    const a = sanitizeProfile({ name: 'A' });
    const b = { ...a, avatar: { ...a.avatar, hair: 'bun' } };
    expect(profileKey(a)).not.toBe(profileKey(b));
  });
});

describe('match CRUD', () => {
  const result = {
    mode: 'doubles' as const, difficulty: 'hard' as const, playerScore: 11, aiScore: 7, won: true,
    ralliesWon: 14, longestRally: 9, opponent: 'Kim & Lee',
  };

  test('a finished match maps to a database row', () => {
    expect(toMatchInsert(result, '2026-11-12T00:00:00.000Z')).toEqual({
      mode: 'doubles', difficulty: 'hard', player_score: 11, ai_score: 7, won: true,
      rallies_won: 14, longest_rally: 9, opponent: 'Kim & Lee', played_at: '2026-11-12T00:00:00.000Z',
    });
  });

  test('create inserts rows; nothing to send is a no-op', async () => {
    const { db, calls } = fakeClient({});
    await api.addMatches(db, []);
    expect(calls).toEqual([]);
    await api.addMatches(db, [toMatchInsert(result)]);
    expect(calls[0]).toEqual(['from', 'matches']);
    expect(calls[1][0]).toBe('insert');
  });

  test('list is newest first', async () => {
    const { db, calls } = fakeClient({ data: [{ id: 1 }] });
    await expect(api.listMatches(db, 10)).resolves.toEqual([{ id: 1 }]);
    expect(calls).toContainEqual(['order', 'played_at', { ascending: false }]);
    expect(calls).toContainEqual(['limit', 10]);
  });

  test('delete one / delete all', async () => {
    const one = fakeClient({});
    await api.deleteMatch(one.db, 42);
    expect(one.calls).toContainEqual(['eq', 'id', 42]);
    const all = fakeClient({});
    await api.deleteAllMatches(all.db, 'u1');
    expect(all.calls).toContainEqual(['eq', 'user_id', 'u1']);
  });

  test('database errors surface as CloudError', async () => {
    const { db } = fakeClient({ error: { message: 'TypeError: Network request failed' } });
    await expect(api.listMatches(db)).rejects.toBeInstanceOf(api.CloudError);
    await expect(api.listMatches(db)).rejects.toThrow('No connection');
  });
});

describe('leaderboard', () => {
  test('calls the get_leaderboard function', async () => {
    const rows = [{ rank: 1, name: 'Sam', wins: 3, played: 4, best_rally: 12, is_me: true }];
    const { db, calls } = fakeClient({ data: rows });
    await expect(api.getLeaderboard(db, 5)).resolves.toEqual(rows);
    expect(calls).toEqual([['rpc', 'get_leaderboard', { max_rows: 5 }]]);
  });
});
