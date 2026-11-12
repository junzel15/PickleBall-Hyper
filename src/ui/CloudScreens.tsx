// Cloud screens opened from the main menu: Account (sign in / sign up / sign out),
// Match history (read + delete) and Leaderboard (read).
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import * as api from '../backend/api';
import { account, AccountState, client } from '../backend/cloud';
import type { LeaderboardRow, MatchRow } from '../backend/types';
import { BackButton, Btn, Card, Label, Overlay, Tap } from './common';
import { C } from './theme';

export type CloudScreen = 'account' | 'history' | 'leaderboard';

export function useAccount(): AccountState {
  return useSyncExternalStore(account.subscribe, account.get);
}

const errText = (e: unknown) => (e instanceof api.CloudError ? e.message : 'Something went wrong. Please try again.');

function Shell({ title, onBack, children, wide }: { title: string; onBack: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <Overlay z={7}>
      <Card style={[s.card, wide && s.cardWide]}>
        <View style={s.head}>
          <BackButton inline onPress={onBack} />
          <Text style={s.h2}>{title}</Text>
        </View>
        {children}
      </Card>
    </Overlay>
  );
}

function Note({ children, kind = 'info' }: { children: React.ReactNode; kind?: 'info' | 'error' }) {
  return <Text style={[s.note, kind === 'error' && s.noteError]}>{children}</Text>;
}

/** Shown on History / Leaderboard when the player isn't signed in. */
function NeedsAccount({ acc, onOpen }: { acc: AccountState; onOpen: (c: CloudScreen) => void }) {
  if (!acc.configured) return <Note>Cloud save isn't set up in this build yet.</Note>;
  return (
    <View style={s.center}>
      <Text style={s.muted}>Sign in to save your matches online and see the leaderboard.</Text>
      <Btn title="Sign in" onPress={() => onOpen('account')} style={s.mt} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
/**
 * @param onDone called after Sign in: takes the player straight back into the game.
 * @param onRegistered called after Create account: shows the welcome modal (name + age).
 * @param playerName the in-game name, stored on the new profile at sign-up.
 */
export function AccountScreen({ onBack, onDone, onRegistered, playerName }: {
  onBack: () => void; onDone: () => void; onRegistered: (email: string) => void; playerName: string;
}) {
  const acc = useAccount();
  const [mode, setMode] = useState<'in' | 'up'>('up'); // registration is the default
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const info = await fn();
      if (info) setMsg({ text: info, kind: 'info' });
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
    if (mode === 'up') onRegistered(email.trim()); // welcome modal: name + age
    else onDone(); // straight back into the game
  });

  const deleteCloudData = () => {
    Alert.alert(
      'Delete cloud data?',
      'This removes your saved profile and all your matches from the cloud. Your look stays on this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: () => run(async () => {
            const db = client();
            const id = acc.userId as string;
            await api.deleteAllMatches(db, id);
            await api.deleteProfile(db, id);
            await api.signOut(db);
            return 'Your cloud data was deleted and you are signed out.';
          }),
        },
      ],
    );
  };

  if (!acc.configured) {
    return (
      <Shell title="Account" onBack={onBack}>
        <Note>Cloud save isn't set up in this build yet. You can keep playing; your profile is saved on this phone.</Note>
      </Shell>
    );
  }

  if (!acc.ready) {
    return (
      <Shell title="Account" onBack={onBack}>
        <ActivityIndicator color={C.accent} style={s.mt} />
      </Shell>
    );
  }

  if (acc.userId) {
    return (
      <Shell title="Account" onBack={onBack}>
        <Label>Signed in as</Label>
        <Text style={s.email} numberOfLines={1}>{acc.email}</Text>
        <Text style={[s.muted, s.center]}>Your profile and matches are saved to the cloud.</Text>
        {acc.pending > 0 && <Note>{acc.pending} match{acc.pending === 1 ? '' : 'es'} waiting to upload.</Note>}
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <View style={s.list}>
          <Btn title="Sign out" secondary onPress={() => run(() => api.signOut(client()))} />
          <Btn title="🗑 Delete my cloud data" secondary onPress={deleteCloudData} textStyle={s.danger} />
        </View>
        {busy && <ActivityIndicator color={C.accent} style={s.mt} />}
      </Shell>
    );
  }

  return (
    <Shell title="Account" onBack={onBack}>
      <View style={s.tabs}>
        {([['up', 'Create account'], ['in', 'Sign in']] as const).map(([m, label]) => (
          <Tap key={m} onPress={() => { setMode(m); setMsg(null); }} scale={0.97} style={[s.tab, mode === m && s.tabActive]}>
            <Text style={[s.tabText, mode === m && s.tabTextActive]}>{label}</Text>
          </Tap>
        ))}
      </View>
      <Text style={s.fieldLabel}>EMAIL</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        placeholderTextColor="rgba(238,243,248,0.4)"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
        style={s.input}
      />
      <Text style={s.fieldLabel}>PASSWORD</Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="At least 6 characters"
        placeholderTextColor="rgba(238,243,248,0.4)"
        secureTextEntry
        autoCapitalize="none"
        textContentType={mode === 'up' ? 'newPassword' : 'password'}
        returnKeyType="go"
        onSubmitEditing={submit}
        style={s.input}
      />
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
      {busy ? (
        <ActivityIndicator color={C.accent} style={s.mt} />
      ) : (
        <Btn title={mode === 'in' ? 'Sign in' : 'Create account'} onPress={submit} style={s.mt} />
      )}
      <Text style={[s.muted, s.small]}>Playing without an account still works. Matches you finish are uploaded once you sign in.</Text>
    </Shell>
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

export function HistoryScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (c: CloudScreen) => void }) {
  const acc = useAccount();
  const [rows, setRows] = useState<MatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!acc.userId) return;
    setError(null);
    try { setRows(await api.listMatches(client())); } catch (e) { setError(errText(e)); }
  }, [acc.userId]);
  useEffect(() => { load(); }, [load, acc.pending]);

  const remove = (m: MatchRow) => {
    Alert.alert('Delete this match?', `${m.player_score} – ${m.ai_score} · ${formatDate(m.played_at)}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteMatch(client(), m.id);
            setRows(r => (r ? r.filter(x => x.id !== m.id) : r));
          } catch (e) { setError(errText(e)); }
        },
      },
    ]);
  };

  const clearAll = () => {
    Alert.alert('Delete all matches?', 'This removes your whole match history from the cloud.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete all', style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteAllMatches(client(), acc.userId as string);
            setRows([]);
          } catch (e) { setError(errText(e)); }
        },
      },
    ]);
  };

  if (!acc.userId) {
    return <Shell title="Match history" onBack={onBack}><NeedsAccount acc={acc} onOpen={onOpen} /></Shell>;
  }

  const wins = rows ? rows.filter(r => r.won).length : 0;
  return (
    <Shell title="Match history" onBack={onBack} wide>
      {error && <Note kind="error">{error}</Note>}
      {!rows && !error && <ActivityIndicator color={C.accent} style={s.mt} />}
      {rows && rows.length === 0 && <Text style={[s.muted, s.center, s.mt]}>No matches yet. Finish a game and it shows up here.</Text>}
      {rows && rows.length > 0 && (
        <>
          <Text style={[s.muted, s.center]}>
            {rows.length} match{rows.length === 1 ? '' : 'es'} · {wins} won · {Math.round((wins / rows.length) * 100)}% win rate
          </Text>
          <View style={s.list}>
            {rows.map(m => (
              <View key={m.id} style={s.row}>
                <View style={[s.badge, m.won ? s.badgeWin : s.badgeLoss]}>
                  <Text style={s.badgeText}>{m.won ? 'W' : 'L'}</Text>
                </View>
                <View style={s.rowMain}>
                  <Text style={s.rowTitle}>{`${m.player_score} – ${m.ai_score}`}<Text style={s.rowSub}>{`  ${cap(m.mode)} · ${cap(m.difficulty)}`}</Text></Text>
                  <Text style={s.rowSub} numberOfLines={1}>
                    {`vs ${m.opponent ?? 'CPU'} · longest rally ${m.longest_rally} · ${formatDate(m.played_at)}`}
                  </Text>
                </View>
                <Tap onPress={() => remove(m)} scale={0.9} style={s.del} accessibilityLabel="Delete this match">
                  <Text style={s.delText}>✕</Text>
                </Tap>
              </View>
            ))}
          </View>
          <Btn title="Delete all" secondary small onPress={clearAll} style={s.mtSelf} textStyle={s.danger} />
        </>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
export function LeaderboardScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (c: CloudScreen) => void }) {
  const acc = useAccount();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!acc.userId) return;
    setError(null);
    setRows(null);
    try { setRows(await api.getLeaderboard(client(), 20)); } catch (e) { setError(errText(e)); }
  }, [acc.userId]);
  useEffect(() => { load(); }, [load]);

  if (!acc.userId) {
    return <Shell title="Leaderboard" onBack={onBack}><NeedsAccount acc={acc} onOpen={onOpen} /></Shell>;
  }

  return (
    <Shell title="Leaderboard" onBack={onBack} wide>
      {error && <Note kind="error">{error}</Note>}
      {!rows && !error && <ActivityIndicator color={C.accent} style={s.mt} />}
      {rows && rows.length === 0 && <Text style={[s.muted, s.center, s.mt]}>No matches played yet. Be the first!</Text>}
      {rows && rows.length > 0 && (
        <View style={s.list}>
          <View style={[s.lbRow, s.lbHead]}>
            <Text style={[s.lbRank, s.lbHeadText]}>#</Text>
            <Text style={[s.lbName, s.lbHeadText]}>PLAYER</Text>
            <Text style={[s.lbNum, s.lbHeadText]}>WINS</Text>
            <Text style={[s.lbNum, s.lbHeadText]}>PLAYED</Text>
            <Text style={[s.lbNum, s.lbHeadText]}>BEST RALLY</Text>
          </View>
          {rows.map((r, i) => (
            <View key={i} style={[s.lbRow, r.is_me && s.lbMe]}>
              <Text style={[s.lbRank, r.rank <= 3 && s.lbTop]}>{r.rank}</Text>
              <Text style={s.lbName} numberOfLines={1}>{r.name}{r.is_me ? '  (you)' : ''}</Text>
              <Text style={s.lbNum}>{r.wins}</Text>
              <Text style={s.lbNum}>{r.played}</Text>
              <Text style={s.lbNum}>{r.best_rally}</Text>
            </View>
          ))}
        </View>
      )}
      <Btn title="↻ Refresh" secondary small onPress={load} style={s.mtSelf} />
    </Shell>
  );
}

const s = StyleSheet.create({
  card: { maxWidth: 400, padding: 16 },
  cardWide: { maxWidth: 560 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  h2: { color: C.text, fontSize: 26, fontWeight: '800' },
  center: { textAlign: 'center', alignItems: 'center' },
  muted: { color: C.muted, fontSize: 13, lineHeight: 18 },
  small: { fontSize: 12, marginTop: 12, textAlign: 'center' },
  mt: { marginTop: 12 },
  mtSelf: { marginTop: 12, alignSelf: 'center' },
  email: { color: C.text, fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 4, marginBottom: 6 },
  note: {
    marginTop: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: 'rgba(215,242,59,0.1)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.35)',
    color: C.accent, fontSize: 13, fontWeight: '700', textAlign: 'center',
  },
  noteError: { backgroundColor: 'rgba(255,93,93,0.1)', borderColor: 'rgba(255,93,93,0.45)', color: '#ff8a8a' },
  danger: { color: '#ff8a8a' },
  list: { gap: 8, marginTop: 12 },
  tabs: { flexDirection: 'row', gap: 6, marginVertical: 10, backgroundColor: 'rgba(0,0,0,0.25)', padding: 4, borderRadius: 10 },
  tab: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  tabActive: { backgroundColor: C.accent },
  tabText: { color: C.muted, fontWeight: '800', fontSize: 14 },
  tabTextActive: { color: '#111' },
  fieldLabel: { fontSize: 12, letterSpacing: 1.2, color: C.muted, marginTop: 8, marginBottom: 6 },
  input: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: C.input, color: C.text, fontSize: 16, fontWeight: '700',
  },
  link: { alignSelf: 'center', marginTop: 10, padding: 4 },
  linkText: { color: C.you, fontSize: 13, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.03)',
  },
  badge: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badgeWin: { backgroundColor: '#2f80ed' },
  badgeLoss: { backgroundColor: '#d23c3c' },
  badgeText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { color: C.text, fontSize: 17, fontWeight: '900' },
  rowSub: { color: C.muted, fontSize: 12, fontWeight: '600' },
  del: {
    width: 32, height: 32, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  delText: { color: C.muted, fontSize: 14, fontWeight: '800' },
  lbRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 8, borderRadius: 8 },
  lbHead: { paddingVertical: 2 },
  lbHeadText: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  lbMe: { backgroundColor: 'rgba(215,242,59,0.12)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.4)' },
  lbRank: { width: 30, color: C.text, fontWeight: '900', fontSize: 14 },
  lbTop: { color: C.accent },
  lbName: { flex: 1, color: C.text, fontWeight: '700', fontSize: 14 },
  lbNum: { width: 70, textAlign: 'right', color: C.text, fontWeight: '800', fontSize: 14 },
});
