// Cloud screens opened from the main menu (and the start screen), full screen in the
// same style as the other menus: Account (create account / sign in / signed in),
// Match history (read + delete) and Leaderboard (read).
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Animated, Easing, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as api from '../backend/api';
import { account, AccountState, client } from '../backend/cloud';
import type { LeaderboardRow, MatchRow } from '../backend/types';
import { Tap } from './common';
import {
  Brand, Columns, Field, GameButton, GhostButton, Icon, IconName, Panel, ScreenFrame, Segments, UiScale, useUiScale,
} from './gameUi';
import { ConfirmModal } from './OnlineScreens';
import { C } from './theme';

export type CloudScreen = 'account' | 'history' | 'leaderboard';

export function useAccount(): AccountState {
  return useSyncExternalStore(account.subscribe, account.get);
}

const errText = (e: unknown) => (e instanceof api.CloudError ? e.message : 'Something went wrong. Please try again.');

function Note({ children, kind = 'info', z }: { children: React.ReactNode; kind?: 'info' | 'error' | 'ok'; z: (n: number) => number }) {
  return (
    <View style={[c.note, kind === 'error' && c.noteError, kind === 'ok' && c.noteOk, { gap: z(8), padding: z(9), borderRadius: z(11) }]}>
      <Icon name={kind === 'error' ? 'close' : 'check'} size={z(15)} color={kind === 'error' ? '#ff8a8a' : C.accent} />
      <Text style={[c.noteText, kind === 'error' && c.noteTextError, { fontSize: z(12.5) }]}>{children}</Text>
    </View>
  );
}

const PERKS: [IconName, string, string][] = [
  ['user', 'Your player, everywhere', 'Look, name and paddle saved online'],
  ['globe', 'Play online', '1 vs 1 and 2 vs 2 against real people'],
  ['trophy', 'Ranked', 'Online rating and leaderboards'],
  ['history', 'Match history', 'Every finished match, on any phone'],
];

function Perks({ z }: { z: (n: number) => number }) {
  return (
    <View style={{ gap: z(9) }}>
      {PERKS.map(([icon, title, sub]) => (
        <View key={title} style={[c.row, { gap: z(10) }]}>
          <View style={[c.perkIcon, { width: z(34), height: z(34), borderRadius: z(11) }]}>
            <Icon name={icon} size={z(17)} color={C.accent} />
          </View>
          <View style={c.flex1}>
            <Text style={[c.perkTitle, { fontSize: z(13.5) }]}>{title}</Text>
            <Text style={[c.sub, { fontSize: z(11.5) }]} numberOfLines={1}>{sub}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Shown on History / Leaderboard when the player isn't signed in. */
function NeedsAccount({ acc, onOpen, z }: { acc: AccountState; onOpen: (c: CloudScreen) => void; z: (n: number) => number }) {
  return (
    <View style={c.center}>
      <Panel z={z} style={[c.narrow, { maxWidth: z(460) }]}>
        {!acc.configured ? (
          <Note z={z}>Cloud save isn't set up in this build yet.</Note>
        ) : (
          <>
            <Text style={[c.body, { fontSize: z(14), lineHeight: z(20) }]}>Sign in to save your matches online and see the leaderboard.</Text>
            <GameButton title="SIGN IN" sub="Free account · takes a minute" icon="user" glow z={z} onPress={() => onOpen('account')} />
          </>
        )}
      </Panel>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
/**
 * @param onDone called after Sign in: takes the player straight back into the game.
 * @param onRegistered called after Create account: shows the welcome step (name + age).
 * @param playerName the in-game name, stored on the new profile at sign-up.
 */
export function AccountScreen({ onBack, onDone, onRegistered, playerName }: {
  onBack: () => void; onDone: () => void; onRegistered: (email: string) => void; playerName: string;
}) {
  const ui = useUiScale();
  const { z } = ui;
  const acc = useAccount();
  const [mode, setMode] = useState<'in' | 'up'>('up'); // registration is the default
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'info' | 'error' | 'ok' } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pwRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const info = await fn();
      if (info) setMsg({ text: info, kind: 'ok' });
    } catch (e) {
      setMsg({ text: errText(e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const submit = () => run(async () => {
    if (!api.isValidEmail(email)) throw new api.CloudError('Enter a valid email address.');
    if (password.length < 6) throw new api.CloudError('Password needs at least 6 characters.');
    if (mode === 'in') {
      await api.signIn(client(), email, password);
    } else {
      try {
        await api.signUp(client(), email, password, playerName); // created and signed in
      } catch (e) {
        // Existing account: switch to Sign in with the email (and password) still filled in
        if (e instanceof api.AccountExistsError) setMode('in');
        throw e;
      }
    }
    setPassword('');
    if (mode === 'up') onRegistered(email.trim()); // welcome step: name + age
    else onDone(); // straight back into the game
  });

  const deleteCloudData = () => run(async () => {
    const db = client();
    const id = acc.userId as string;
    await api.deleteAllMatches(db, id);
    await api.deleteProfile(db, id);
    await api.signOut(db);
    return 'Your cloud data was deleted and you are signed out.';
  });

  if (!acc.configured || !acc.ready) {
    return (
      <ScreenFrame title="Account" kicker="PICKLEBALL: HYPER" onBack={onBack} ui={ui}>
        <View style={c.center}>
          {!acc.configured
            ? <Panel z={z} style={[c.narrow, { maxWidth: z(460) }]}><Note z={z}>Cloud save isn't set up in this build yet. You can keep playing; your profile is saved on this phone.</Note></Panel>
            : <ActivityIndicator color={C.accent} size="large" />}
        </View>
      </ScreenFrame>
    );
  }

  // ---- signed in ----
  if (acc.userId) {
    const left = (
      <Panel z={z} title="SIGNED IN">
        <View style={[c.row, { gap: z(12) }]}>
          <View style={[c.avatar, { width: z(52), height: z(52), borderRadius: z(26) }]}>
            <Text style={[c.avatarText, { fontSize: z(22) }]}>{(acc.email ?? '?')[0].toUpperCase()}</Text>
          </View>
          <View style={c.flex1}>
            <Text style={[c.email, { fontSize: z(16) }]} numberOfLines={1}>{acc.email}</Text>
            <View style={[c.row, { gap: z(6), marginTop: z(2) }]}>
              <View style={[c.liveDot, { width: z(8), height: z(8), borderRadius: z(4) }]} />
              <Text style={[c.sub, { fontSize: z(12) }]}>{acc.pending > 0 ? `${acc.pending} match${acc.pending === 1 ? '' : 'es'} waiting to upload` : 'Profile and matches synced'}</Text>
            </View>
          </View>
        </View>
        <Perks z={z} />
      </Panel>
    );
    const right = (
      <>
        <Panel z={z} title="ACCOUNT">
          <GameButton title="BACK TO THE GAME" icon="play" glow z={z} onPress={onDone} sub="Everything is saved to the cloud" />
          <GhostButton title="Sign out" icon="door" z={z} onPress={() => run(() => api.signOut(client()))} />
          <GhostButton title="Delete my cloud data" icon="close" danger z={z} onPress={() => setConfirmDelete(true)} />
          {busy && <ActivityIndicator color={C.accent} />}
          {msg && <Note kind={msg.kind} z={z}>{msg.text}</Note>}
        </Panel>
      </>
    );
    return (
      <>
        <ScreenFrame title="Account" kicker="PICKLEBALL: HYPER ACCOUNT" onBack={onBack} ui={ui}>
          <Columns ui={ui} left={left} right={right} ratio={1} />
        </ScreenFrame>
        {confirmDelete && (
          <ConfirmModal
            icon="🗑"
            title="Delete cloud data?"
            message="This removes your saved profile and all your matches from the cloud, then signs you out."
            points={['Your look stays on this phone', "This can't be undone"]}
            cancelText="Keep"
            confirmText="Delete"
            danger
            busy={busy}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { setConfirmDelete(false); await deleteCloudData(); }}
          />
        )}
      </>
    );
  }

  // ---- create account / sign in ----
  const signUp = mode === 'up';
  const left = (
    <Panel z={z} style={{ padding: z(14), gap: z(14) }}>
      <Brand z={z} size={28} />
      <Text style={[c.body, { fontSize: z(13.5), lineHeight: z(19) }]}>
        {signUp ? 'Create your free account to keep your player and play online.' : 'Welcome back! Sign in to pick up where you left off.'}
      </Text>
      <Perks z={z} />
    </Panel>
  );
  const right = (
    <Panel z={z} style={{ padding: z(14), gap: z(11) }}>
      <Segments z={z} value={mode} onPick={m => { setMode(m); setMsg(null); }}
        options={[{ v: 'up', label: 'Create account' }, { v: 'in', label: 'Sign in' }]} />
      <Field
        z={z} label="EMAIL" icon="mail" value={email} onChangeText={t => { setEmail(t); setMsg(null); }}
        placeholder="you@example.com" autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        textContentType="emailAddress" returnKeyType="next" onSubmitEditing={() => pwRef.current?.focus()}
        error={msg?.kind === 'error' && /email/i.test(msg.text)}
      />
      <Field
        z={z} label="PASSWORD" icon="lock" secure value={password} onChangeText={t => { setPassword(t); setMsg(null); }}
        placeholder="At least 6 characters" autoCapitalize="none" textContentType={signUp ? 'newPassword' : 'password'}
        returnKeyType="go" onSubmitEditing={submit}
        error={msg?.kind === 'error' && /password/i.test(msg.text)}
        ref={pwRef}
      />
      {msg && <Note kind={msg.kind} z={z}>{msg.text}</Note>}
      <GameButton
        title={busy ? 'PLEASE WAIT…' : signUp ? 'CREATE ACCOUNT' : 'SIGN IN'}
        sub={signUp ? 'Free · you\'re signed in right away' : 'Use the email and password you registered with'}
        icon={signUp ? 'plus' : 'enter'} disabled={busy} glow={!busy} z={z} onPress={submit} />
      <Text style={[c.sub, c.centerText, { fontSize: z(11.5) }]}>
        {signUp ? 'Already have an account? Tap Sign in above.' : 'New here? Tap Create account above.'}
      </Text>
    </Panel>
  );
  return (
    <ScreenFrame title={signUp ? 'Create account' : 'Sign in'} kicker="PICKLEBALL: HYPER ACCOUNT" onBack={onBack} ui={ui}>
      <ScrollView style={c.flex1} contentContainerStyle={c.grow} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Columns ui={ui} left={left} right={right} ratio={0.9} />
      </ScrollView>
    </ScreenFrame>
  );
}

// ---------------------------------------------------------------------------
// Match history
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

function Stat({ value, label, z, color = C.text }: { value: string; label: string; z: (n: number) => number; color?: string }) {
  return (
    <View style={[c.stat, { paddingVertical: z(7), borderRadius: z(12) }]}>
      <Text style={[c.statNum, { fontSize: z(20), color }]}>{value}</Text>
      <Text style={[c.kicker, { fontSize: z(9) }]}>{label}</Text>
    </View>
  );
}

function IconButton({ icon, onPress, z, label, danger }: { icon: IconName; onPress: () => void; z: (n: number) => number; label: string; danger?: boolean }) {
  return (
    <Tap onPress={onPress} scale={0.9} accessibilityLabel={label}
      style={[c.iconBtn, danger && c.iconBtnDanger, { width: z(34), height: z(34), borderRadius: z(10) }]}>
      <Icon name={icon} size={z(15)} color={danger ? '#ff8a8a' : C.text} />
    </Tap>
  );
}

export function HistoryScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (c: CloudScreen) => void }) {
  const ui = useUiScale();
  const { z } = ui;
  const acc = useAccount();
  const [rows, setRows] = useState<MatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MatchRow | 'all' | null>(null);

  const load = useCallback(async () => {
    if (!acc.userId) return;
    setError(null);
    try { setRows(await api.listMatches(client())); } catch (e) { setError(errText(e)); }
  }, [acc.userId]);
  useEffect(() => { load(); }, [load, acc.pending]);

  const confirmRemove = async () => {
    const r = removing;
    setRemoving(null);
    try {
      if (r === 'all') { await api.deleteAllMatches(client(), acc.userId as string); setRows([]); }
      else if (r) { await api.deleteMatch(client(), r.id); setRows(x => (x ? x.filter(m => m.id !== r.id) : x)); }
    } catch (e) { setError(errText(e)); }
  };

  if (!acc.userId) {
    return <ScreenFrame title="Match history" kicker="VS COMPUTER" onBack={onBack} ui={ui}><NeedsAccount acc={acc} onOpen={onOpen} z={z} /></ScreenFrame>;
  }

  const list = rows ?? [];
  const wins = list.filter(r => r.won).length;
  const best = list.reduce((m, r) => Math.max(m, r.longest_rally), 0);
  return (
    <>
      <ScreenFrame title="Match history" kicker="VS COMPUTER" onBack={onBack} ui={ui} fill
        right={list.length > 0 ? <GhostButton title="Delete all" icon="close" danger small z={z} onPress={() => setRemoving('all')} /> : undefined}>
        <View style={[c.flex1, { gap: z(10) }]}>
          <View style={[c.row, { gap: z(8) }]}>
            <Stat value={String(list.length)} label="PLAYED" z={z} />
            <Stat value={String(wins)} label="WON" z={z} color={C.you} />
            <Stat value={list.length ? `${Math.round((wins / list.length) * 100)}%` : '–'} label="WIN RATE" z={z} color={C.accent} />
            <Stat value={String(best)} label="BEST RALLY" z={z} />
          </View>
          <Panel z={z} flex>
            {error && <Note kind="error" z={z}>{error}</Note>}
            {!rows && !error && <ActivityIndicator color={C.accent} />}
            {rows && rows.length === 0 && <Text style={[c.sub, { fontSize: z(13) }]}>No matches yet. Finish a game and it shows up here.</Text>}
            <ScrollView style={c.flex1} contentContainerStyle={{ gap: z(6) }} showsVerticalScrollIndicator={false}>
              {list.map(m => (
                <View key={m.id} style={[c.listRow, { gap: z(10), padding: z(7), borderRadius: z(12) }]}>
                  <View style={[c.badge, m.won ? c.badgeWin : c.badgeLoss, { width: z(34), height: z(34), borderRadius: z(10) }]}>
                    <Text style={[c.badgeText, { fontSize: z(15) }]}>{m.won ? 'W' : 'L'}</Text>
                  </View>
                  <View style={c.flex1}>
                    <Text style={[c.rowTitle, { fontSize: z(15) }]} numberOfLines={1}>
                      {`${m.player_score} – ${m.ai_score}`}
                      <Text style={[c.sub, { fontSize: z(12) }]}>{`   ${cap(m.mode)} · ${cap(m.difficulty)}`}</Text>
                    </Text>
                    <Text style={[c.sub, { fontSize: z(11) }]} numberOfLines={1}>
                      {`vs ${m.opponent ?? 'CPU'} · longest rally ${m.longest_rally} · ${formatDate(m.played_at)}`}
                    </Text>
                  </View>
                  <IconButton icon="close" label="Delete this match" z={z} onPress={() => setRemoving(m)} />
                </View>
              ))}
            </ScrollView>
          </Panel>
        </View>
      </ScreenFrame>
      {removing && (
        <ConfirmModal
          icon="🗑"
          title={removing === 'all' ? 'Delete all matches?' : 'Delete this match?'}
          message={removing === 'all' ? 'This removes your whole match history from the cloud.' : `${removing.player_score} – ${removing.ai_score} · ${formatDate(removing.played_at)}`}
          cancelText="Keep"
          confirmText={removing === 'all' ? 'Delete all' : 'Delete'}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={confirmRemove}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
export function LeaderboardScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (c: CloudScreen) => void }) {
  const ui = useUiScale();
  return <Leaderboard ui={ui} onBack={onBack} onOpen={onOpen} />;
}

function Leaderboard({ ui, onBack, onOpen }: { ui: UiScale; onBack: () => void; onOpen: (c: CloudScreen) => void }) {
  const { z } = ui;
  const acc = useAccount();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spin = useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    if (!acc.userId) return;
    setError(null);
    setRows(null);
    spin.setValue(0);
    Animated.timing(spin, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    try { setRows(await api.getLeaderboard(client(), 50)); } catch (e) { setError(errText(e)); }
  }, [acc.userId, spin]);
  useEffect(() => { load(); }, [load]);

  if (!acc.userId) {
    return <ScreenFrame title="Leaderboard" kicker="VS COMPUTER" onBack={onBack} ui={ui}><NeedsAccount acc={acc} onOpen={onOpen} z={z} /></ScreenFrame>;
  }
  const medal = (r: number) => (r === 1 ? '#f5c542' : r === 2 ? '#c9d3df' : r === 3 ? '#d08a4a' : null);
  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const refresh = (
    <Tap onPress={load} scale={0.9} accessibilityLabel="Refresh" style={[c.iconBtn, { width: z(36), height: z(36), borderRadius: z(10) }]}>
      <Animated.View style={{ transform: [{ rotate: rot }] }}><Icon name="refresh" size={z(16)} color={C.text} /></Animated.View>
    </Tap>
  );
  const me = rows?.find(r => r.is_me);
  return (
    <ScreenFrame title="Leaderboard" kicker="VS COMPUTER · MOST WINS" onBack={onBack} ui={ui} right={refresh} fill>
      <View style={[c.flex1, { gap: z(10) }]}>
        {me && (
          <View style={[c.row, { gap: z(8) }]}>
            <Stat value={`#${me.rank}`} label="YOUR RANK" z={z} color={C.accent} />
            <Stat value={String(me.wins)} label="WINS" z={z} color={C.you} />
            <Stat value={String(me.played)} label="PLAYED" z={z} />
            <Stat value={String(me.best_rally)} label="BEST RALLY" z={z} />
          </View>
        )}
        <Panel z={z} flex>
          {error && <Note kind="error" z={z}>{error}</Note>}
          {!rows && !error && <ActivityIndicator color={C.accent} />}
          {rows && rows.length === 0 && <Text style={[c.sub, { fontSize: z(13) }]}>No matches played yet. Be the first!</Text>}
          {rows && rows.length > 0 && (
            <View style={[c.row, { paddingHorizontal: z(8) }]}>
              <Text style={[c.lbHead, { width: z(42), fontSize: z(10) }]}>#</Text>
              <Text style={[c.lbHead, c.flex1, { fontSize: z(10) }]}>PLAYER</Text>
              <Text style={[c.lbHead, c.right, { width: z(60), fontSize: z(10) }]}>WINS</Text>
              <Text style={[c.lbHead, c.right, { width: z(66), fontSize: z(10) }]}>PLAYED</Text>
              <Text style={[c.lbHead, c.right, { width: z(76), fontSize: z(10) }]}>BEST RALLY</Text>
            </View>
          )}
          <ScrollView style={c.flex1} contentContainerStyle={{ gap: z(4) }} showsVerticalScrollIndicator={false}>
            {(rows ?? []).map((r, i) => {
              const m = medal(r.rank);
              return (
                <View key={i} style={[c.row, c.lbItem, r.is_me && c.lbMe, { paddingHorizontal: z(8), paddingVertical: z(7), borderRadius: z(10) }]}>
                  <View style={{ width: z(42) }}>
                    {m ? (
                      <View style={[c.medal, { backgroundColor: m, width: z(25), height: z(25), borderRadius: z(13) }]}>
                        <Text style={[c.medalText, { fontSize: z(12) }]}>{r.rank}</Text>
                      </View>
                    ) : <Text style={[c.rank, { fontSize: z(14) }]}>{r.rank}</Text>}
                  </View>
                  <Text style={[c.rowTitle, c.flex1, { fontSize: z(14) }]} numberOfLines={1}>{`${r.name}${r.is_me ? '  (you)' : ''}`}</Text>
                  <Text style={[c.right, c.wins, { width: z(60), fontSize: z(15) }]}>{r.wins}</Text>
                  <Text style={[c.right, c.sub, { width: z(66), fontSize: z(13) }]}>{r.played}</Text>
                  <Text style={[c.right, c.sub, { width: z(76), fontSize: z(13) }]}>{r.best_rally}</Text>
                </View>
              );
            })}
          </ScrollView>
        </Panel>
      </View>
    </ScreenFrame>
  );
}

const c = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex1: { flex: 1, minWidth: 0 },
  grow: { flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  narrow: { width: '100%' },
  centerText: { textAlign: 'center' },
  right: { textAlign: 'right' },
  kicker: { color: C.muted, fontWeight: '900', letterSpacing: 1.3 },
  body: { color: '#d3dde8', fontWeight: '600' },
  sub: { color: C.muted, fontWeight: '700' },
  rowTitle: { color: C.text, fontWeight: '900' },
  note: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(215,242,59,0.1)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.35)',
  },
  noteOk: {},
  noteError: { backgroundColor: 'rgba(255,93,93,0.1)', borderColor: 'rgba(255,93,93,0.45)' },
  noteText: { flex: 1, color: C.accent, fontWeight: '700' },
  noteTextError: { color: '#ff8a8a' },
  perkIcon: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(215,242,59,0.12)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.3)' },
  perkTitle: { color: C.text, fontWeight: '900' },
  avatar: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)', borderWidth: 2, borderColor: C.accent },
  avatarText: { color: C.accent, fontWeight: '900' },
  email: { color: C.text, fontWeight: '900' },
  liveDot: { backgroundColor: '#3ddc84' },
  stat: { flex: 1, alignItems: 'center', backgroundColor: 'rgba(20,31,48,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  statNum: { fontWeight: '900', fontVariant: ['tabular-nums'] },
  listRow: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(255,255,255,0.035)',
  },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeWin: { backgroundColor: '#2f80ed' },
  badgeLoss: { backgroundColor: '#d23c3c' },
  badgeText: { color: '#fff', fontWeight: '900' },
  iconBtn: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.05)' },
  iconBtnDanger: { borderColor: 'rgba(255,93,93,0.4)' },
  lbHead: { color: C.muted, fontWeight: '900', letterSpacing: 0.8 },
  lbItem: { backgroundColor: 'rgba(255,255,255,0.03)' },
  lbMe: { backgroundColor: 'rgba(215,242,59,0.12)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.4)' },
  rank: { color: C.text, fontWeight: '900' },
  wins: { color: C.accent, fontWeight: '900', fontVariant: ['tabular-nums'] },
  medal: { alignItems: 'center', justifyContent: 'center' },
  medalText: { color: '#111', fontWeight: '900' },
});
