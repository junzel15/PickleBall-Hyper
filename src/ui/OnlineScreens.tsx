// Online play screens, full screen like the main menu (they scale with the screen
// and fit without scrolling on phones; long lists scroll inside their own panel):
//   Online hub · Quick Match search · room lobby · rejoin · friends · history · ranking
// plus the invite card and the in-match overlays (connection banner, ☰ menu,
// "Opponent Found!", leave confirmation, result card).
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Animated, Easing, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Game, UiState } from '../game/engine';
import * as api from '../backend/online/api';
import * as online from '../backend/online/session';
import { onlineStore, OnlineState } from '../backend/online/session';
import { client } from '../backend/cloud';
import { Btn, Card, Overlay, Tap } from './common';
import {
  Columns, GameButton, GhostButton, Icon, MenuSheet, Panel, ScreenFrame, Segments, Tile, UiScale, useUiScale,
} from './gameUi';
import { C } from './theme';

export function useOnline(): OnlineState {
  return useSyncExternalStore(onlineStore.subscribe, onlineStore.get);
}

type Page = 'hub' | 'friends' | 'history' | 'leaders';
const modeLabel = (m?: api.OnlineMode) => (m === 'doubles' ? '2 vs 2' : '1 vs 1');

const same = (n: number) => n;
function Note({ children, kind = 'info', z = same }: { children: React.ReactNode; kind?: 'info' | 'error'; z?: (n: number) => number }) {
  return <Text style={[o.note, kind === 'error' && o.noteError, { fontSize: z(12.5), padding: z(8), borderRadius: z(10) }]}>{children}</Text>;
}

function ErrorNote({ st, z }: { st: OnlineState; z: (n: number) => number }) {
  if (!st.error) return null;
  return (
    <Tap onPress={online.clearError} scale={0.99}>
      <Note kind="error" z={z}>{`${st.error}  ✕`}</Note>
    </Tap>
  );
}

const Dot = ({ on, z }: { on: boolean; z: (n: number) => number }) => (
  <View style={[o.dot, on ? o.dotOn : o.dotOff, { width: z(9), height: z(9), borderRadius: z(5) }]} />
);

/** Letter avatar in a ring (team-coloured). */
function Avatar({ name, z, size = 40, color = C.accent }: { name: string; z: (n: number) => number; size?: number; color?: string }) {
  return (
    <View style={[o.avatar, { width: z(size), height: z(size), borderRadius: z(size / 2), borderColor: color }]}>
      <Text style={[o.avatarText, { fontSize: z(size * 0.42), color }]}>{(name.trim()[0] || '?').toUpperCase()}</Text>
    </View>
  );
}

function CodeInput({ value, onChange, placeholder, max, onSubmit, z }: {
  value: string; onChange: (t: string) => void; placeholder: string; max: number; onSubmit: () => void; z: (n: number) => number;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={t => onChange(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, max))}
      placeholder={placeholder}
      placeholderTextColor="rgba(238,243,248,0.35)"
      autoCapitalize="characters"
      autoCorrect={false}
      maxLength={max}
      returnKeyType="go"
      onSubmitEditing={onSubmit}
      style={[o.input, { fontSize: z(16), paddingVertical: z(8), paddingHorizontal: z(10), borderRadius: z(11), letterSpacing: z(3) }]}
    />
  );
}

// ---------------------------------------------------------------------------
// Entry point from the main menu
// ---------------------------------------------------------------------------
/** Everything online, opened from the main menu. `onBack` returns to the main menu. */
export function OnlineScreen({ onBack, onSignIn }: { onBack: () => void; onSignIn: () => void }) {
  const st = useOnline();
  const ui = useUiScale();
  const [page, setPage] = useState<Page>('hub');

  useEffect(() => { if (st.userId) online.refreshAll(); }, [st.userId]);

  if (!st.userId) return <SignInScreen ui={ui} onBack={onBack} onSignIn={onSignIn} />;
  if (st.inMatch) return null;
  if (st.quick === 'searching') return <SearchScreen st={st} ui={ui} />;
  if (st.room && st.room.status === 'lobby') return <LobbyScreen st={st} ui={ui} />;
  if (st.room && st.room.status === 'playing' && st.rejoin) return <RejoinScreen st={st} ui={ui} onBack={onBack} />;

  if (page === 'friends') return <FriendsScreen st={st} ui={ui} onBack={() => setPage('hub')} />;
  if (page === 'history') return <OnlineHistoryScreen ui={ui} onBack={() => setPage('hub')} />;
  if (page === 'leaders') return <OnlineLeaderboardScreen ui={ui} onBack={() => setPage('hub')} />;
  return <Hub st={st} ui={ui} onBack={onBack} onPage={setPage} />;
}

function SignInScreen({ ui, onBack, onSignIn }: { ui: UiScale; onBack: () => void; onSignIn: () => void }) {
  const { z } = ui;
  return (
    <ScreenFrame title="Play online" kicker="REAL PLAYERS · 1 VS 1 · 2 VS 2" onBack={onBack} ui={ui}>
      <View style={o.center}>
        <Panel z={z} style={[o.narrow, { maxWidth: z(460) }]}>
          <View style={[o.row, { gap: z(12) }]}>
            <View style={[o.bigIcon, { width: z(52), height: z(52), borderRadius: z(26) }]}><Icon name="globe" size={z(28)} color={C.accent} /></View>
            <Text style={[o.body, o.flex1, { fontSize: z(14), lineHeight: z(20) }]}>
              Sign in to play real people online, add friends and climb the online leaderboard.
            </Text>
          </View>
          <GameButton title="SIGN IN" sub="Free account · takes a minute" icon="user" onPress={onSignIn} glow z={z} />
        </Panel>
      </View>
    </ScreenFrame>
  );
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------
function Hub({ st, ui, onBack, onPage }: { st: OnlineState; ui: UiScale; onBack: () => void; onPage: (p: Page) => void }) {
  const { z } = ui;
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<api.OnlineMode>('singles');
  const me = st.me;
  const join = () => { if (code.trim().length === 6) online.joinRoom(code); };
  const winRate = me && me.played > 0 ? Math.round((me.wins / me.played) * 100) : null;
  const pendingFriends = (st.friends ?? []).filter(f => f.status === 'pending' && f.incoming).length;

  const left = (
    <>
      <Panel z={z} title="YOUR ONLINE CARD">
        {me ? (
          <>
            <View style={[o.row, { gap: z(10) }]}>
              <Avatar name={me.name} z={z} size={44} />
              <View style={o.flex1}>
                <Text style={[o.name, { fontSize: z(18) }]} numberOfLines={1}>{me.name}</Text>
                <Text style={[o.sub, { fontSize: z(11.5) }]} numberOfLines={1}>
                  {`${me.wins}W · ${me.losses}L${winRate !== null ? ` · ${winRate}% wins` : ''}${me.streak > 1 ? ` · 🔥 ${me.streak}` : ''}`}
                </Text>
              </View>
              <View style={o.ratingBox}>
                <Text style={[o.ratingNum, { fontSize: z(22) }]}>{me.rating}</Text>
                <Text style={[o.ratingLabel, { fontSize: z(9) }]}>RATING</Text>
              </View>
            </View>
            <View style={[o.codeChip, o.row, { gap: z(8), paddingVertical: z(6), paddingHorizontal: z(10), borderRadius: z(10) }]}>
              <Text style={[o.kicker, { fontSize: z(9.5) }]}>FRIEND CODE</Text>
              <Text style={[o.codeText, { fontSize: z(15), letterSpacing: z(2) }]} selectable>{me.friend_code}</Text>
            </View>
          </>
        ) : <ActivityIndicator color={C.accent} />}
      </Panel>
      <Panel z={z} title={st.invites.length ? `INVITES (${st.invites.length})` : 'INVITES'} flex>
        {st.invites.length === 0 ? (
          <Text style={[o.sub, { fontSize: z(12) }]}>{`No invites right now · ${st.onlineIds.length} other player${st.onlineIds.length === 1 ? '' : 's'} online`}</Text>
        ) : (
          <ScrollView style={o.flex1} contentContainerStyle={{ gap: z(6) }} showsVerticalScrollIndicator={false}>
            {st.invites.map(inv => (
              <View key={inv.id} style={[o.listRow, { gap: z(8), padding: z(7), borderRadius: z(11) }]}>
                <Icon name="mail" size={z(16)} color={C.accent} />
                <Text style={[o.rowTitle, o.flex1, { fontSize: z(13) }]} numberOfLines={1}>{`${inv.from_name} · ${modeLabel(inv.mode)}`}</Text>
                <Btn title="Join" small onPress={() => online.respondInvite(inv.id, true)} />
                <Tap onPress={() => online.respondInvite(inv.id, false)} scale={0.9} style={[o.iconBtn, { width: z(30), height: z(30), borderRadius: z(9) }]} accessibilityLabel="Decline">
                  <Icon name="close" size={z(13)} color={C.muted} />
                </Tap>
              </View>
            ))}
          </ScrollView>
        )}
      </Panel>
    </>
  );

  const right = (
    <>
      <Panel z={z} title="QUICK MATCH">
        <Segments z={z} value={mode} onPick={setMode}
          options={[{ v: 'singles', label: '1 vs 1', sub: 'SINGLES' }, { v: 'doubles', label: '2 vs 2', sub: 'DOUBLES' }]} />
        <GameButton title="FIND MATCH" icon="search" glow z={z} height={58}
          sub={mode === 'doubles' ? 'Teams of two, balanced by rating' : 'A random opponent near your rating'}
          onPress={() => online.startQuickMatch(mode)} />
      </Panel>
      <Panel z={z} title={`PLAY WITH FRIENDS · ${modeLabel(mode)}`}>
        <View style={[o.row, { gap: z(8) }]}>
          <GhostButton title="Create room" icon="plus" onPress={() => online.createRoom(mode)} z={z} />
          <View style={o.flex1}><CodeInput value={code} onChange={setCode} placeholder="ROOM CODE" max={6} onSubmit={join} z={z} /></View>
          <Tap onPress={join} disabled={code.length !== 6} scale={0.95} accessibilityLabel="Join room"
            style={[o.joinBtn, code.length !== 6 && o.dim, { paddingHorizontal: z(14), minHeight: z(40), borderRadius: z(11), gap: z(5) }]}>
            <Icon name="enter" size={z(15)} color="#111" />
            <Text style={[o.joinText, { fontSize: z(13.5) }]}>Join</Text>
          </Tap>
        </View>
      </Panel>
      <ErrorNote st={st} z={z} />
      <View style={[o.row, { gap: z(8) }]}>
        <Tile icon="users" label="Friends" onPress={() => onPage('friends')} z={z} badge={pendingFriends ? String(pendingFriends) : undefined} />
        <Tile icon="history" label="History" onPress={() => onPage('history')} z={z} />
        <Tile icon="trophy" label="Ranking" onPress={() => onPage('leaders')} z={z} />
      </View>
    </>
  );

  return (
    <ScreenFrame title="Play online" kicker="REAL PLAYERS · 1 VS 1 · 2 VS 2" onBack={onBack} ui={ui}
      right={st.busy ? <ActivityIndicator color={C.accent} /> : <OnlineCount n={st.onlineIds.length} z={z} />}>
      <Columns ui={ui} left={left} right={right} ratio={0.85} />
    </ScreenFrame>
  );
}

function OnlineCount({ n, z }: { n: number; z: (n: number) => number }) {
  return (
    <View style={[o.row, o.countPill, { gap: z(6), paddingHorizontal: z(10), paddingVertical: z(5), borderRadius: z(10) }]}>
      <View style={[o.dot, o.dotOn, { width: z(8), height: z(8), borderRadius: z(4) }]} />
      <Text style={[o.countText, { fontSize: z(11.5) }]}>{`${n} online`}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Rejoin
// ---------------------------------------------------------------------------
function RejoinScreen({ st, ui, onBack }: { st: OnlineState; ui: UiScale; onBack: () => void }) {
  const { z } = ui;
  const me = st.room?.players.find(p => p.user_id === st.userId);
  const opps = (st.room?.players ?? []).filter(p => me && p.team !== me.team).map(p => p.name).join(' & ');
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <ScreenFrame title="Match in progress" kicker={`ONLINE · ${modeLabel(st.room?.mode)}`} onBack={onBack} ui={ui}>
        <View style={o.center}>
          <Panel z={z} style={[o.narrow, { maxWidth: z(460) }]}>
            <Text style={[o.body, { fontSize: z(14), lineHeight: z(20) }]}>
              {`Your match against ${opps || 'your opponent'} is still going. Jump back in before the others win by forfeit.`}
            </Text>
            <GameButton title="REJOIN MATCH" sub="Carry on where you left off" icon="play" glow z={z} onPress={online.rejoinMatch} />
            <GhostButton title="Leave match (counts as a loss)" icon="door" danger z={z} onPress={() => setConfirming(true)} />
            <ErrorNote st={st} z={z} />
          </Panel>
        </View>
      </ScreenFrame>
      {confirming && (
        <LeaveMatchModal
          opponent={opps || 'your opponent'}
          busy={st.busy}
          onStay={() => setConfirming(false)}
          onLeave={async () => { await online.leaveRoom(); setConfirming(false); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Quick Match search
// ---------------------------------------------------------------------------
function Radar({ z }: { z: (n: number) => number }) {
  const t = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    const b = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    a.start(); b.start();
    return () => { a.stop(); b.stop(); };
  }, [t, spin]);
  const size = z(120);
  const ring = (delay: number) => {
    const v = t.interpolate({ inputRange: [0, 1], outputRange: [delay, 1 + delay] });
    const p = Animated.modulo(v, 1);
    return {
      opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
      transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
    };
  };
  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {[0, 0.33, 0.66].map(d => (
        <Animated.View key={d} style={[o.radarRing, { width: size, height: size, borderRadius: size / 2 }, ring(d)]} />
      ))}
      <Animated.View style={[o.radarBall, { width: z(30), height: z(30), borderRadius: z(15), transform: [{ rotate: rot }] }]}>
        <View style={[o.radarDot, { width: z(5), height: z(5), borderRadius: z(3), left: z(7), top: z(9) }]} />
        <View style={[o.radarDot, { width: z(5), height: z(5), borderRadius: z(3), left: z(17), top: z(6) }]} />
        <View style={[o.radarDot, { width: z(5), height: z(5), borderRadius: z(3), left: z(14), top: z(18) }]} />
      </Animated.View>
    </View>
  );
}

function SearchScreen({ st, ui }: { st: OnlineState; ui: UiScale }) {
  const { z } = ui;
  const doubles = st.quickMode === 'doubles';
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <ScreenFrame title="Finding a match" kicker={`QUICK MATCH · ${modeLabel(st.quickMode)}`} onBack={online.cancelQuickMatch} ui={ui}>
      <View style={[o.center, { gap: z(10) }]}>
        <Radar z={z} />
        <Text style={[o.searchTitle, { fontSize: z(19) }]}>{doubles ? 'Looking for three more players…' : 'Looking for an opponent…'}</Text>
        <Text style={[o.sub, o.textCenter, { fontSize: z(12.5) }]}>
          {`${mm} · ${st.quickWaiting > 0
            ? `${st.quickWaiting} other player${st.quickWaiting === 1 ? '' : 's'} searching${doubles ? ` · ${Math.max(0, 3 - st.quickWaiting)} more needed` : ''}`
            : 'you are first in line'}`}
        </Text>
        <ErrorNote st={st} z={z} />
        <GhostButton title="Cancel search" icon="close" onPress={online.cancelQuickMatch} z={z} style={{ minWidth: z(200) }} />
      </View>
    </ScreenFrame>
  );
}

// ---------------------------------------------------------------------------
// Room lobby
// ---------------------------------------------------------------------------
function LobbyScreen({ st, ui }: { st: OnlineState; ui: UiScale }) {
  const { z } = ui;
  const room = st.room as api.RoomState;
  const doubles = room.mode === 'doubles';
  const capacity = room.capacity ?? (doubles ? 4 : 2);
  const me = room.players.find(p => p.user_id === st.userId);
  const others = room.players.filter(p => p.user_id !== st.userId);
  const isHost = room.host_id === st.userId;
  const full = room.players.length >= capacity;
  const notReady = others.filter(p => !p.ready);
  const canStart = full && notReady.length === 0;
  const [inviting, setInviting] = useState(false);

  const seat = (n: number) => {
    const p = room.players.find(x => x.seat === n);
    const mine = p?.user_id === st.userId;
    const canTake = !p && !!me && me.seat !== 0 && n !== 0;
    const teamColor = n % 2 === 0 ? C.you : C.cpu;
    return (
      <View key={n} style={[o.seat, mine && o.seatMine, { gap: z(8), padding: z(7), borderRadius: z(12) }]}>
        {p ? <Avatar name={p.name} z={z} size={32} color={teamColor} /> : (
          <View style={[o.emptySeat, { width: z(32), height: z(32), borderRadius: z(16) }]}><Icon name="plus" size={z(14)} color={C.muted} /></View>
        )}
        <View style={o.flex1}>
          <Text style={[o.rowTitle, { fontSize: z(13.5) }]} numberOfLines={1}>{p ? `${p.name}${mine ? ' (you)' : ''}` : 'Open spot'}</Text>
          {p ? (
            <View style={[o.row, { gap: z(5) }]}>
              <Dot on={mine || st.onlineIds.includes(p.user_id)} z={z} />
              <Text style={[o.sub, { fontSize: z(10.5) }]} numberOfLines={1}>{`${n === 0 ? 'Host · ' : ''}${p.rating}`}</Text>
            </View>
          ) : <Text style={[o.sub, { fontSize: z(10.5) }]}>Waiting…</Text>}
        </View>
        {p && (
          <View style={[o.state, (p.ready || n === 0) && o.stateOn, { paddingHorizontal: z(6), paddingVertical: z(3), borderRadius: z(7) }]}>
            <Text style={[o.stateText, (p.ready || n === 0) && o.stateTextOn, { fontSize: z(9.5) }]}>{n === 0 ? 'HOST' : p.ready ? 'READY' : 'NOT READY'}</Text>
          </View>
        )}
        {canTake && (
          <Tap onPress={() => online.changeSeat(n)} scale={0.94} accessibilityLabel="Sit here"
            style={[o.sitBtn, { paddingHorizontal: z(9), paddingVertical: z(6), borderRadius: z(9) }]}>
            <Text style={[o.sitText, { fontSize: z(11.5) }]}>Sit here</Text>
          </Tap>
        )}
      </View>
    );
  };
  const teamSeats = (team: 0 | 1) => [0, 1, 2, 3].filter(x => x < capacity && x % 2 === team);

  let startTitle = 'START MATCH';
  let startSub = 'Everyone is ready';
  if (!full) { startTitle = 'WAITING FOR PLAYERS'; startSub = `${capacity - room.players.length} more to join`; }
  else if (notReady.length) { startTitle = 'WAITING FOR READY'; startSub = `${notReady.map(p => p.name).join(' & ')} not ready yet`; }

  const left = (
    <>
      <Panel z={z} title="ROOM CODE">
        <Text style={[o.roomCode, { fontSize: z(40), letterSpacing: z(8) }]} selectable>{room.code}</Text>
        <Text style={[o.sub, { fontSize: z(11.5) }]}>Share this code, or invite friends who are online.</Text>
        {isHost && (
          <Segments z={z} value={room.mode} onPick={m => { if (m !== room.mode) online.setRoomMode(m); }}
            options={[{ v: 'singles', label: '1 vs 1', sub: 'SINGLES' }, { v: 'doubles', label: '2 vs 2', sub: 'DOUBLES' }]} />
        )}
      </Panel>
      <View style={[o.row, { gap: z(8) }]}>
        {!full && <GhostButton title="Invite friends" icon="mail" onPress={() => { setInviting(true); if (!st.friends) online.refreshFriends(); }} z={z} style={o.flex1} />}
        <GhostButton title="Leave room" icon="door" danger onPress={online.leaveRoom} z={z} style={o.flex1} />
      </View>
      <ErrorNote st={st} z={z} />
    </>
  );

  const right = (
    <>
      {doubles ? (
        <View style={[o.row, o.teams, { gap: z(8) }]}>
          {([0, 1] as const).map(team => (
            <View key={team} style={[o.team, team === 0 ? o.teamA : o.teamB, { padding: z(7), borderRadius: z(14), gap: z(6) }]}>
              <Text style={[o.teamLabel, { color: team === 0 ? C.you : C.cpu, fontSize: z(10) }]}>{team === 0 ? 'TEAM A' : 'TEAM B'}</Text>
              {teamSeats(team).map(seat)}
            </View>
          ))}
        </View>
      ) : (
        <Panel z={z} title="PLAYERS">
          {seat(0)}
          <Text style={[o.vs, { fontSize: z(14) }]}>VS</Text>
          {seat(1)}
        </Panel>
      )}
      {isHost ? (
        <GameButton title={startTitle} sub={startSub} icon="play" onPress={canStart ? online.startMatch : undefined} disabled={!canStart} glow={canStart} z={z} />
      ) : (
        <GameButton
          title={me?.ready ? 'READY!' : "I'M READY"}
          sub={me?.ready ? 'Waiting for the host to start · tap to undo' : 'Let the host know you can start'}
          icon="check" color={me?.ready ? 'blue' : 'lime'} glow={!me?.ready}
          onPress={() => online.setReady(!me?.ready)} z={z} />
      )}
    </>
  );

  return (
    <>
      <ScreenFrame title={`Room · ${modeLabel(room.mode)}`} kicker={isHost ? 'YOU ARE THE HOST' : 'PRIVATE ROOM'} onBack={online.leaveRoom} ui={ui}
        right={st.busy ? <ActivityIndicator color={C.accent} /> : <OnlineCount n={st.onlineIds.length} z={z} />}>
        <Columns ui={ui} left={left} right={right} ratio={0.8} />
      </ScreenFrame>
      {inviting && <InviteSheet st={st} room={room} z={z} onClose={() => setInviting(false)} />}
    </>
  );
}

/** Pick friends to invite (a sheet over the lobby). */
function InviteSheet({ st, room, z, onClose }: { st: OnlineState; room: api.RoomState; z: (n: number) => number; onClose: () => void }) {
  const friends = (st.friends ?? []).filter(f => f.status === 'accepted' && !room.players.some(p => p.user_id === f.user_id));
  const [sent, setSent] = useState<string[]>([]);
  return (
    <Overlay z={30}>
      <Card style={[o.sheet, { maxWidth: z(460), padding: z(16), borderRadius: z(18) }]}>
        <View style={[o.row, { gap: z(10), marginBottom: z(10) }]}>
          <Text style={[o.sheetTitle, o.flex1, { fontSize: z(20) }]}>Invite friends</Text>
          <Tap onPress={onClose} scale={0.9} style={[o.iconBtn, { width: z(34), height: z(34), borderRadius: z(10) }]} accessibilityLabel="Close">
            <Icon name="close" size={z(15)} color={C.muted} />
          </Tap>
        </View>
        {!st.friends && <ActivityIndicator color={C.accent} />}
        {st.friends && friends.length === 0 && (
          <Text style={[o.sub, { fontSize: z(13) }]}>No friends to invite yet. Add friends with their friend code on the Friends screen.</Text>
        )}
        <View style={{ gap: z(6) }}>
          {friends.map(f => {
            const done = sent.includes(f.user_id);
            return (
              <View key={f.user_id} style={[o.listRow, { gap: z(8), padding: z(7), borderRadius: z(11) }]}>
                <Avatar name={f.name} z={z} size={30} />
                <View style={o.flex1}>
                  <Text style={[o.rowTitle, { fontSize: z(13.5) }]} numberOfLines={1}>{f.name}</Text>
                  <View style={[o.row, { gap: z(5) }]}>
                    <Dot on={st.onlineIds.includes(f.user_id)} z={z} />
                    <Text style={[o.sub, { fontSize: z(10.5) }]}>{`${st.onlineIds.includes(f.user_id) ? 'Online' : 'Offline'} · ${f.rating}`}</Text>
                  </View>
                </View>
                <Btn title={done ? 'Sent ✓' : 'Invite'} small secondary={done}
                  onPress={done ? undefined : () => { online.inviteFriend(f.user_id); setSent(x => [...x, f.user_id]); }} />
              </View>
            );
          })}
        </View>
      </Card>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------
function FriendsScreen({ st, ui, onBack }: { st: OnlineState; ui: UiScale; onBack: () => void }) {
  const { z } = ui;
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [removing, setRemoving] = useState<api.Friend | null>(null);
  useEffect(() => { online.refreshFriends(); }, []);
  const add = async () => {
    if (code.length !== 8) return;
    setInfo(null);
    const msg = await online.sendFriendRequest(code);
    if (msg) { setInfo(msg); setCode(''); }
  };
  const list = st.friends ?? [];
  const incoming = list.filter(f => f.status === 'pending' && f.incoming);
  const outgoing = list.filter(f => f.status === 'pending' && !f.incoming);
  const friends = list.filter(f => f.status === 'accepted')
    .sort((a, b) => Number(st.onlineIds.includes(b.user_id)) - Number(st.onlineIds.includes(a.user_id)));

  const left = (
    <>
      <Panel z={z} title="ADD A FRIEND">
        {st.me && (
          <View style={[o.codeChip, o.row, { gap: z(8), paddingVertical: z(6), paddingHorizontal: z(10), borderRadius: z(10) }]}>
            <Text style={[o.kicker, { fontSize: z(9.5) }]}>YOUR CODE</Text>
            <Text style={[o.codeText, { fontSize: z(15), letterSpacing: z(2) }]} selectable>{st.me.friend_code}</Text>
          </View>
        )}
        <View style={[o.row, { gap: z(8) }]}>
          <View style={o.flex1}><CodeInput value={code} onChange={setCode} placeholder="FRIEND CODE" max={8} onSubmit={add} z={z} /></View>
          <Tap onPress={add} disabled={code.length !== 8} scale={0.95} accessibilityLabel="Add friend"
            style={[o.joinBtn, code.length !== 8 && o.dim, { paddingHorizontal: z(14), minHeight: z(40), borderRadius: z(11), gap: z(5) }]}>
            <Icon name="plus" size={z(15)} color="#111" />
            <Text style={[o.joinText, { fontSize: z(13.5) }]}>Add</Text>
          </Tap>
        </View>
        {info && <Note z={z}>{info}</Note>}
        <ErrorNote st={st} z={z} />
      </Panel>
      <Panel z={z} title={`REQUESTS${incoming.length ? ` (${incoming.length})` : ''}`} flex>
        <ScrollView style={o.flex1} contentContainerStyle={{ gap: z(6) }} showsVerticalScrollIndicator={false}>
          {incoming.length === 0 && outgoing.length === 0 && <Text style={[o.sub, { fontSize: z(12) }]}>No friend requests.</Text>}
          {incoming.map(f => (
            <View key={f.user_id} style={[o.listRow, { gap: z(8), padding: z(7), borderRadius: z(11) }]}>
              <Avatar name={f.name} z={z} size={30} />
              <Text style={[o.rowTitle, o.flex1, { fontSize: z(13.5) }]} numberOfLines={1}>{f.name}</Text>
              <Btn title="Accept" small onPress={() => online.respondFriendRequest(f.user_id, true)} />
              <Tap onPress={() => online.respondFriendRequest(f.user_id, false)} scale={0.9} style={[o.iconBtn, { width: z(30), height: z(30), borderRadius: z(9) }]} accessibilityLabel="Decline">
                <Icon name="close" size={z(13)} color={C.muted} />
              </Tap>
            </View>
          ))}
          {outgoing.map(f => (
            <View key={f.user_id} style={[o.listRow, { gap: z(8), padding: z(7), borderRadius: z(11) }]}>
              <Avatar name={f.name} z={z} size={30} color={C.muted} />
              <Text style={[o.rowTitle, o.flex1, { fontSize: z(13.5) }]} numberOfLines={1}>{f.name}</Text>
              <Text style={[o.sub, { fontSize: z(11) }]}>sent</Text>
              <Tap onPress={() => online.removeFriend(f.user_id)} scale={0.9} style={[o.iconBtn, { width: z(30), height: z(30), borderRadius: z(9) }]} accessibilityLabel="Cancel request">
                <Icon name="close" size={z(13)} color={C.muted} />
              </Tap>
            </View>
          ))}
        </ScrollView>
      </Panel>
    </>
  );

  const right = (
    <Panel z={z} title={`FRIENDS (${friends.length})`} flex right={<OnlineCount n={friends.filter(f => st.onlineIds.includes(f.user_id)).length} z={z} />}>
      {!st.friends && <ActivityIndicator color={C.accent} />}
      {st.friends && friends.length === 0 && (
        <Text style={[o.sub, { fontSize: z(12.5) }]}>Swap friend codes with someone to play them directly in a room.</Text>
      )}
      <ScrollView style={o.flex1} contentContainerStyle={{ gap: z(6) }} showsVerticalScrollIndicator={false}>
        {friends.map(f => {
          const on = st.onlineIds.includes(f.user_id);
          return (
            <View key={f.user_id} style={[o.listRow, { gap: z(8), padding: z(7), borderRadius: z(11) }]}>
              <Avatar name={f.name} z={z} size={32} color={on ? '#3ddc84' : C.muted} />
              <View style={o.flex1}>
                <Text style={[o.rowTitle, { fontSize: z(13.5) }]} numberOfLines={1}>{f.name}</Text>
                <View style={[o.row, { gap: z(5) }]}>
                  <Dot on={on} z={z} />
                  <Text style={[o.sub, { fontSize: z(10.5) }]}>{`${on ? 'Online' : 'Offline'} · Rating ${f.rating}`}</Text>
                </View>
              </View>
              <Tap onPress={() => setRemoving(f)} scale={0.9} style={[o.iconBtn, { width: z(30), height: z(30), borderRadius: z(9) }]} accessibilityLabel={`Remove ${f.name}`}>
                <Icon name="close" size={z(13)} color={C.muted} />
              </Tap>
            </View>
          );
        })}
      </ScrollView>
    </Panel>
  );

  return (
    <>
      <ScreenFrame title="Friends" kicker="PLAY ONLINE" onBack={onBack} ui={ui} fill>
        <Columns ui={ui} left={left} right={right} ratio={0.95} />
      </ScreenFrame>
      {removing && (
        <ConfirmModal
          icon="👋"
          title={`Remove ${removing.name}?`}
          message="They'll be taken off your friends list. You can add them again with their friend code."
          cancelText="Keep"
          confirmText="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => { online.removeFriend(removing.user_id); setRemoving(null); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Online history and ranking
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const REASON: Record<string, string> = { score: '', forfeit: ' · forfeit', left: ' · left early', dispute: ' · results disagreed', abandoned: ' · abandoned' };

function Stat({ value, label, z, color = C.text }: { value: string; label: string; z: (n: number) => number; color?: string }) {
  return (
    <View style={[o.stat, { paddingVertical: z(6), borderRadius: z(10) }]}>
      <Text style={[o.statNum, { fontSize: z(19), color }]}>{value}</Text>
      <Text style={[o.kicker, { fontSize: z(9) }]}>{label}</Text>
    </View>
  );
}

function OnlineHistoryScreen({ ui, onBack }: { ui: UiScale; onBack: () => void }) {
  const { z } = ui;
  const [rows, setRows] = useState<api.OnlineHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setRows(await api.getOnlineHistory(client(), 40)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const counted = (rows ?? []).filter(r => r.won !== null);
  const wins = counted.filter(r => r.won).length;
  const net = (rows ?? []).reduce((sum, r) => sum + (r.rating_delta ?? 0), 0);
  const refresh = (
    <Tap onPress={load} scale={0.9} style={[o.iconBtn, { width: z(36), height: z(36), borderRadius: z(10) }]} accessibilityLabel="Refresh">
      <Icon name="refresh" size={z(16)} color={C.text} />
    </Tap>
  );
  return (
    <ScreenFrame title="Online matches" kicker="PLAY ONLINE · HISTORY" onBack={onBack} ui={ui} right={refresh} fill>
      <View style={[o.flex1, { gap: z(10) }]}>
        <View style={[o.row, { gap: z(8) }]}>
          <Stat value={String(counted.length)} label="PLAYED" z={z} />
          <Stat value={String(wins)} label="WON" z={z} color={C.you} />
          <Stat value={String(counted.length - wins)} label="LOST" z={z} color={C.cpu} />
          <Stat value={`${net >= 0 ? '+' : ''}${net}`} label="RATING" z={z} color={net >= 0 ? C.accent : '#ff8a8a'} />
        </View>
        <Panel z={z} flex>
          {error && <Note kind="error" z={z}>{error}</Note>}
          {!rows && !error && <ActivityIndicator color={C.accent} />}
          {rows && rows.length === 0 && <Text style={[o.sub, { fontSize: z(13) }]}>No online matches yet. Try a Quick Match!</Text>}
          <ScrollView style={o.flex1} contentContainerStyle={{ gap: z(6) }} showsVerticalScrollIndicator={false}>
            {(rows ?? []).map(m => (
              <View key={m.id} style={[o.listRow, { gap: z(10), padding: z(7), borderRadius: z(11) }]}>
                <View style={[o.badge, m.won === true ? o.badgeWin : m.won === false ? o.badgeLoss : o.badgeVoid, { width: z(32), height: z(32), borderRadius: z(9) }]}>
                  <Text style={[o.badgeText, { fontSize: z(15) }]}>{m.won === true ? 'W' : m.won === false ? 'L' : '–'}</Text>
                </View>
                <View style={o.flex1}>
                  <Text style={[o.rowTitle, { fontSize: z(14) }]} numberOfLines={1}>
                    {m.my_score !== null && m.opp_score !== null ? `${m.my_score} – ${m.opp_score}` : m.won !== null ? (m.won ? 'Win' : 'Loss') : 'Not counted'}
                    <Text style={[o.sub, { fontSize: z(12) }]}>{`   vs ${m.opponent}${m.partner ? ` · with ${m.partner}` : ''}`}</Text>
                  </Text>
                  <Text style={[o.sub, { fontSize: z(10.5) }]} numberOfLines={1}>
                    {`${modeLabel(m.mode)} · ${m.kind === 'quick' ? 'Quick Match' : 'Room'}${REASON[m.end_reason ?? ''] ?? ''} · ${formatDate(m.started_at)}`}
                  </Text>
                </View>
                {typeof m.rating_delta === 'number' && (
                  <Text style={[o.delta, { fontSize: z(14), color: m.rating_delta >= 0 ? C.accent : '#ff8a8a' }]}>
                    {`${m.rating_delta >= 0 ? '+' : ''}${m.rating_delta}`}
                  </Text>
                )}
              </View>
            ))}
          </ScrollView>
        </Panel>
      </View>
    </ScreenFrame>
  );
}

function OnlineLeaderboardScreen({ ui, onBack }: { ui: UiScale; onBack: () => void }) {
  const { z } = ui;
  const [rows, setRows] = useState<api.OnlineLeaderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try { setRows(await api.getOnlineLeaderboard(client(), 50)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const medal = (r: number) => (r === 1 ? '#f5c542' : r === 2 ? '#c9d3df' : r === 3 ? '#d08a4a' : null);
  const refresh = (
    <Tap onPress={load} scale={0.9} style={[o.iconBtn, { width: z(36), height: z(36), borderRadius: z(10) }]} accessibilityLabel="Refresh">
      <Icon name="refresh" size={z(16)} color={C.text} />
    </Tap>
  );
  return (
    <ScreenFrame title="Online ranking" kicker="PLAY ONLINE · RATING (ELO)" onBack={onBack} ui={ui} right={refresh} fill>
      <Panel z={z} flex>
        {error && <Note kind="error" z={z}>{error}</Note>}
        {!rows && !error && <ActivityIndicator color={C.accent} />}
        {rows && rows.length === 0 && <Text style={[o.sub, { fontSize: z(13) }]}>No ranked matches yet. Be the first!</Text>}
        {rows && rows.length > 0 && (
          <View style={[o.lbRow, { paddingHorizontal: z(8) }]}>
            <Text style={[o.lbHead, { width: z(40), fontSize: z(10) }]}>#</Text>
            <Text style={[o.lbHead, o.flex1, { fontSize: z(10) }]}>PLAYER</Text>
            <Text style={[o.lbHead, o.lbNum, { width: z(72), fontSize: z(10) }]}>RATING</Text>
            <Text style={[o.lbHead, o.lbNum, { width: z(72), fontSize: z(10) }]}>W – L</Text>
          </View>
        )}
        <ScrollView style={o.flex1} contentContainerStyle={{ gap: z(4) }} showsVerticalScrollIndicator={false}>
          {(rows ?? []).map((r, i) => {
            const m = medal(r.rank);
            return (
              <View key={i} style={[o.lbRow, o.lbItem, r.is_me && o.lbMe, { paddingHorizontal: z(8), paddingVertical: z(7), borderRadius: z(10) }]}>
                <View style={{ width: z(40) }}>
                  {m ? (
                    <View style={[o.medal, { backgroundColor: m, width: z(24), height: z(24), borderRadius: z(12) }]}>
                      <Text style={[o.medalText, { fontSize: z(12) }]}>{r.rank}</Text>
                    </View>
                  ) : <Text style={[o.lbRank, { fontSize: z(14) }]}>{r.rank}</Text>}
                </View>
                <Text style={[o.rowTitle, o.flex1, { fontSize: z(14) }]} numberOfLines={1}>{`${r.name}${r.is_me ? '  (you)' : ''}`}</Text>
                <Text style={[o.lbNum, o.lbRating, { width: z(72), fontSize: z(15) }]}>{r.rating}</Text>
                <Text style={[o.lbNum, o.sub, { width: z(72), fontSize: z(13) }]}>{`${r.wins} – ${r.losses}`}</Text>
              </View>
            );
          })}
        </ScrollView>
      </Panel>
    </ScreenFrame>
  );
}

const o = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex1: { flex: 1, minWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  narrow: { width: '100%' },
  textCenter: { textAlign: 'center' },
  dim: { opacity: 0.45 },
  kicker: { color: C.muted, fontWeight: '900', letterSpacing: 1.4 },
  body: { color: C.text, fontWeight: '600' },
  sub: { color: C.muted, fontWeight: '700' },
  name: { color: C.text, fontWeight: '900' },
  rowTitle: { color: C.text, fontWeight: '800' },
  bigIcon: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(215,242,59,0.12)', borderWidth: 2, borderColor: 'rgba(215,242,59,0.45)' },
  avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 2, backgroundColor: 'rgba(0,0,0,0.3)' },
  avatarText: { fontWeight: '900' },
  ratingBox: { alignItems: 'center' },
  ratingNum: { color: C.accent, fontWeight: '900', fontVariant: ['tabular-nums'] },
  ratingLabel: { color: C.muted, fontWeight: '900', letterSpacing: 1.3 },
  codeChip: { backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'space-between' },
  codeText: { color: C.accent, fontWeight: '900' },
  note: {
    backgroundColor: 'rgba(215,242,59,0.1)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.35)',
    color: C.accent, fontWeight: '700', textAlign: 'center',
  },
  noteError: { backgroundColor: 'rgba(255,93,93,0.1)', borderColor: 'rgba(255,93,93,0.45)', color: '#ff8a8a' },
  dot: {},
  dotOn: { backgroundColor: '#3ddc84' },
  dotOff: { backgroundColor: 'rgba(255,255,255,0.22)' },
  input: {
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: C.input,
    color: C.text, fontWeight: '900', textAlign: 'center',
  },
  joinBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent },
  joinText: { color: '#111', fontWeight: '900' },
  iconBtn: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.05)' },
  listRow: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(255,255,255,0.035)',
  },
  countPill: { backgroundColor: 'rgba(61,220,132,0.12)', borderWidth: 1, borderColor: 'rgba(61,220,132,0.4)' },
  countText: { color: '#a6f5c6', fontWeight: '800' },
  searchTitle: { color: C.text, fontWeight: '900', textAlign: 'center' },
  radarRing: { position: 'absolute', borderWidth: 2, borderColor: 'rgba(27,159,214,0.8)' },
  radarBall: { backgroundColor: '#e3f05a', borderWidth: 2, borderColor: '#d2e23a', overflow: 'hidden' },
  radarDot: { position: 'absolute', backgroundColor: 'rgba(90,100,0,0.6)' },
  roomCode: { color: C.accent, fontWeight: '900', textAlign: 'center' },
  teams: { alignItems: 'stretch' },
  team: { flex: 1, borderWidth: 1, minWidth: 0 },
  teamA: { borderColor: 'rgba(58,160,255,0.55)', backgroundColor: 'rgba(58,160,255,0.08)' },
  teamB: { borderColor: 'rgba(255,93,93,0.55)', backgroundColor: 'rgba(255,93,93,0.08)' },
  teamLabel: { fontWeight: '900', letterSpacing: 1.4, textAlign: 'center' },
  seat: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(23,34,51,0.85)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  seatMine: { borderColor: 'rgba(215,242,59,0.55)' },
  emptySeat: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)' },
  state: { backgroundColor: 'rgba(255,255,255,0.08)' },
  stateOn: { backgroundColor: 'rgba(215,242,59,0.18)' },
  stateText: { color: C.muted, fontWeight: '900', letterSpacing: 0.8 },
  stateTextOn: { color: C.accent },
  sitBtn: { backgroundColor: 'rgba(215,242,59,0.15)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.55)' },
  sitText: { color: C.accent, fontWeight: '900' },
  vs: { color: C.accent, fontWeight: '900', fontStyle: 'italic', textAlign: 'center' },
  sheet: { alignItems: 'stretch' },
  sheetTitle: { color: C.text, fontWeight: '900' },
  stat: { flex: 1, alignItems: 'center', backgroundColor: 'rgba(23,34,51,0.8)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  statNum: { fontWeight: '900', fontVariant: ['tabular-nums'] },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeWin: { backgroundColor: '#2f80ed' },
  badgeLoss: { backgroundColor: '#d23c3c' },
  badgeVoid: { backgroundColor: 'rgba(255,255,255,0.15)' },
  badgeText: { color: '#fff', fontWeight: '900' },
  delta: { fontWeight: '900', fontVariant: ['tabular-nums'] },
  lbRow: { flexDirection: 'row', alignItems: 'center' },
  lbItem: { backgroundColor: 'rgba(255,255,255,0.03)' },
  lbHead: { color: C.muted, fontWeight: '900', letterSpacing: 0.8 },
  lbMe: { backgroundColor: 'rgba(215,242,59,0.12)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.4)' },
  lbRank: { color: C.text, fontWeight: '900' },
  lbNum: { textAlign: 'right' },
  lbRating: { color: C.accent, fontWeight: '900', fontVariant: ['tabular-nums'] },
  medal: { alignItems: 'center', justifyContent: 'center' },
  medalText: { color: '#111', fontWeight: '900' },
});

// ---------------------------------------------------------------------------
// Invite card (shown anywhere in the menus)
// ---------------------------------------------------------------------------
export function InviteToast({ st }: { st: OnlineState }) {
  if (!st.toast || st.inMatch) return null;
  return (
    <View style={s.toastWrap} pointerEvents="box-none">
      <View style={s.toast}>
        <Text style={[s.rowTitle, s.flex1]} numberOfLines={2}>{`🎾 ${st.toast.fromName} invited you to play`}</Text>
        <Btn title="Join" small onPress={online.acceptToast} />
        <Btn title="✕" small secondary onPress={online.dismissToast} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// During an online match
// ---------------------------------------------------------------------------
/** "Waiting for …" strip while the other player is silent. */
export function OnlineLinkBanner({ ui }: { ui: UiState }) {
  const o = ui.online;
  if (!o || o.link !== 'waiting' || ui.overOpen) return null;
  return (
    <View style={s.linkWrap} pointerEvents="none">
      <View style={s.link}>
        <ActivityIndicator color={C.accent} size="small" />
        <Text style={s.linkText}>{o.note || 'Reconnecting…'}</Text>
      </View>
    </View>
  );
}

/** ☰ Menu during an online match: the match keeps going behind it. */
export function OnlineMatchMenu({ game, ui }: { game: Game; ui: UiState }) {
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { if (!ui.online?.menuOpen) setConfirming(false); }, [ui.online?.menuOpen]);
  if (!ui.online?.menuOpen) return null;
  if (confirming) {
    return (
      <LeaveMatchModal
        opponent={ui.online.opponent}
        busy={leaving}
        onStay={() => setConfirming(false)}
        onLeave={async () => { setLeaving(true); try { await online.leaveMatch(); } finally { setLeaving(false); } }}
      />
    );
  }
  return <OnlineMenuSheet game={game} opponent={ui.online.opponent} onLeave={() => setConfirming(true)} />;
}

/** The same panel as the offline pause menu (the online match keeps running behind it). */
function OnlineMenuSheet({ game, opponent, onLeave }: { game: Game; opponent: string; onLeave: () => void }) {
  const scale = useUiScale();
  const { z } = scale;
  return (
    <MenuSheet kicker={`ONLINE · VS ${opponent.toUpperCase()}`} title="Match menu" icon="pause" ui={scale} maxWidth={420}>
      <Text style={[o.sub, { fontSize: z(12.5) }]}>The match keeps going while this menu is open.</Text>
      <GameButton title="BACK TO MATCH" sub="Resume playing" icon="play" onPress={() => game.toggleOnlineMenu()} glow z={z} height={72} titleSize={24} />
      <GhostButton title="Leave match" icon="door" danger onPress={onLeave} z={z} style={{ minHeight: z(50) }} />
    </MenuSheet>
  );
}

// ---------------------------------------------------------------------------
// Modals (in the game's own style, instead of the system's white alert boxes)
// ---------------------------------------------------------------------------
/** A themed yes / no question. */
export function ConfirmModal({
  icon, title, message, points, confirmText, cancelText = 'Cancel', danger, busy, onConfirm, onCancel,
}: {
  icon: string; title: string; message: string; points?: string[]; confirmText: string; cancelText?: string;
  danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Overlay z={40}>
      <Card style={[s.modalCard, danger ? s.modalCardDanger : null]}>
        <View style={[s.modalIcon, danger ? s.modalIconDanger : null]}>
          <Text style={s.modalIconText}>{icon}</Text>
        </View>
        <Text style={s.modalTitle}>{title}</Text>
        <Text style={s.modalMsg}>{message}</Text>
        {points && points.length > 0 && (
          <View style={s.modalPoints}>
            {points.map(p => (
              <View key={p} style={s.modalPoint}>
                <View style={[s.modalBullet, danger ? s.modalBulletDanger : null]} />
                <Text style={s.modalPointText}>{p}</Text>
              </View>
            ))}
          </View>
        )}
        <View style={s.modalRow}>
          <Btn title={cancelText} onPress={busy ? undefined : onCancel} style={[s.flex1, danger ? null : s.modalSecondary]} secondary={!danger} />
          <Btn
            title={busy ? 'Please wait…' : confirmText}
            onPress={busy ? undefined : onConfirm}
            secondary={danger}
            style={[s.flex1, danger ? s.modalDangerBtn : null, busy ? s.dim : null]}
            textStyle={danger ? s.modalDangerText : undefined}
          />
        </View>
      </Card>
    </Overlay>
  );
}

function LeaveMatchModal({ opponent, busy, onStay, onLeave }: { opponent: string; busy?: boolean; onStay: () => void; onLeave: () => void }) {
  return (
    <ConfirmModal
      icon="🚪"
      title="Leave the match?"
      message={`If you leave now, ${opponent} win${opponent.includes('&') ? '' : 's'} this match.`}
      points={['It counts as a loss on your record', 'Your online rating goes down', "You can't rejoin this match"]}
      cancelText="Keep playing"
      confirmText="Leave match"
      danger
      busy={busy}
      onCancel={onStay}
      onConfirm={onLeave}
    />
  );
}

/** Quick Match found the players: show who, count down, then play. */
export function MatchFoundModal({ st }: { st: OnlineState }) {
  const room = st.found;
  const [count, setCount] = useState(3);
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!room) return;
    setCount(3);
    pop.setValue(0);
    Animated.spring(pop, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }).start();
    const t = setInterval(() => setCount(c => c - 1), 1000);
    return () => clearInterval(t);
  }, [room, pop]);
  useEffect(() => { if (room && count <= 0) online.acceptFound(); }, [room, count]);
  if (!room) return null;
  const me = room.players.find(p => p.user_id === st.userId);
  const myTeam = me?.team ?? 0;
  const mates = room.players.filter(p => p.team === myTeam);
  const opps = room.players.filter(p => p.team !== myTeam);
  const doubles = room.mode === 'doubles';
  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const sideList = (list: api.RoomPlayer[], mine: boolean) => (
    <View style={[s.foundSide, mine ? s.foundMine : s.foundTheirs]}>
      <Text style={[s.teamLabel, mine ? s.teamLabelA : s.teamLabelB]}>{mine ? (doubles ? 'YOUR TEAM' : 'YOU') : (doubles ? 'OPPONENTS' : 'OPPONENT')}</Text>
      {list.map(p => (
        <View key={p.user_id} style={s.foundPlayer}>
          <Text style={s.foundName} numberOfLines={1}>{p.user_id === st.userId ? `${p.name} (you)` : p.name}</Text>
          <Text style={s.rowSub}>{`Rating ${p.rating}`}</Text>
        </View>
      ))}
    </View>
  );
  return (
    <Overlay z={40}>
      <Card style={s.foundCard}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <Text style={s.foundKicker}>{`QUICK MATCH · ${modeLabel(room.mode)}`}</Text>
          <Text style={s.foundTitle}>{doubles ? 'Match Found!' : 'Opponent Found!'}</Text>
        </Animated.View>
        <View style={s.foundVs}>
          {sideList(mates, true)}
          <Text style={s.vsText}>VS</Text>
          {sideList(opps, false)}
        </View>
        <Text style={s.foundCount}>{count > 0 ? count : 'GO!'}</Text>
        <Text style={[s.muted, s.center]}>Get ready — the match starts automatically</Text>
        <Btn title="▶ Play now" onPress={online.acceptFound} style={s.mt} textStyle={s.big} />
      </Card>
    </Overlay>
  );
}

/** End of an online match: the score, then what the server decided. */
export function OnlineGameOver({ ui }: { ui: UiState }) {
  const o = ui.online;
  const settling = !!o && /Saving|Waiting/.test(o.note);
  return (
    <Overlay>
      <Card style={s.overCard}>
        <Text style={s.h2}>{ui.gameOver.title}</Text>
        <Text style={s.final}>{ui.gameOver.score}</Text>
        <Text style={[s.muted, s.center]}>{ui.gameOver.stats}</Text>
        {o?.note ? <Note>{o.note}</Note> : null}
        {settling && <ActivityIndicator color={C.accent} style={s.mtSmall} />}
        <Btn title="Continue" onPress={() => online.exitMatch()} style={s.mt} />
      </Card>
    </Overlay>
  );
}

const s = StyleSheet.create({
  card: { maxWidth: 420, padding: 16 },
  cardWide: { maxWidth: 560 },
  menuCard: { maxWidth: 320, alignItems: 'stretch' },
  overCard: { alignItems: 'stretch', maxWidth: 380 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  h2: { color: C.text, fontSize: 24, fontWeight: '800', flexShrink: 1, textAlign: 'center' },
  final: { color: C.text, fontSize: 40, fontWeight: '800', fontVariant: ['tabular-nums'], textAlign: 'center' },
  center: { textAlign: 'center' },
  muted: { color: C.muted, fontSize: 13, lineHeight: 18 },
  small: { fontSize: 12, marginTop: 6 },
  big: { fontSize: 18 },
  mt: { marginTop: 12 },
  mtSmall: { marginTop: 8 },
  mtSelf: { marginTop: 12, alignSelf: 'center' },
  flex1: { flex: 1, minWidth: 0 },
  dim: { opacity: 0.45 },
  danger: { color: '#ff8a8a' },
  note: {
    marginTop: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: 'rgba(215,242,59,0.1)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.35)',
    color: C.accent, fontSize: 13, fontWeight: '700', textAlign: 'center',
  },
  noteError: { backgroundColor: 'rgba(255,93,93,0.1)', borderColor: 'rgba(255,93,93,0.45)', color: '#ff8a8a' },
  meCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  meName: { color: C.text, fontSize: 18, fontWeight: '900' },
  codeBox: { alignItems: 'center' },
  codeLabel: { color: C.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  codeText: { color: C.accent, fontSize: 16, fontWeight: '900', letterSpacing: 2 },
  codeInline: { color: C.accent, fontWeight: '900', letterSpacing: 1.5 },
  joinRow: { flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' },
  input: {
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: C.input, color: C.text, fontSize: 16, fontWeight: '800',
  },
  codeInput: { letterSpacing: 3, textAlign: 'center' },
  btnRow: { flexDirection: 'row', gap: 6, marginTop: 12 },
  list: { gap: 8, marginTop: 10 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.03)',
  },
  rowTitle: { color: C.text, fontSize: 15, fontWeight: '800' },
  rowSub: { color: C.muted, fontSize: 12, fontWeight: '600' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: '#3ddc84' },
  dotOff: { backgroundColor: 'rgba(255,255,255,0.2)' },
  ready: { color: C.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  modalCard: { maxWidth: 380, alignItems: 'stretch', paddingTop: 22, borderColor: 'rgba(215,242,59,0.35)' },
  modalCardDanger: { borderColor: 'rgba(255,93,93,0.5)' },
  modalIcon: {
    alignSelf: 'center', width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(215,242,59,0.14)', borderWidth: 2, borderColor: 'rgba(215,242,59,0.55)', marginBottom: 10,
  },
  modalIconDanger: { backgroundColor: 'rgba(255,93,93,0.14)', borderColor: 'rgba(255,93,93,0.6)' },
  modalIconText: { fontSize: 26 },
  modalTitle: { color: C.text, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  modalMsg: { color: C.muted, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6 },
  modalPoints: {
    marginTop: 12, padding: 10, borderRadius: 12, gap: 7,
    backgroundColor: 'rgba(0,0,0,0.22)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  modalPoint: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modalBullet: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.accent },
  modalBulletDanger: { backgroundColor: C.cpu },
  modalPointText: { color: C.text, fontSize: 13, fontWeight: '700', flex: 1 },
  modalRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  modalSecondary: { borderColor: 'rgba(255,255,255,0.25)' },
  modalDangerBtn: { backgroundColor: '#d23c3c', borderColor: '#d23c3c' },
  modalDangerText: { color: '#fff' },
  foundCard: { maxWidth: 460, alignItems: 'stretch', borderColor: 'rgba(215,242,59,0.5)', borderWidth: 2 },
  foundKicker: { color: C.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1.6, textAlign: 'center' },
  foundTitle: { color: C.accent, fontSize: 30, fontWeight: '900', textAlign: 'center', marginTop: 2 },
  foundVs: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  foundSide: { flex: 1, padding: 10, borderRadius: 12, borderWidth: 1, gap: 6 },
  foundMine: { borderColor: 'rgba(58,160,255,0.55)', backgroundColor: 'rgba(58,160,255,0.08)' },
  foundTheirs: { borderColor: 'rgba(255,93,93,0.55)', backgroundColor: 'rgba(255,93,93,0.08)' },
  foundPlayer: { alignItems: 'center' },
  foundName: { color: C.text, fontSize: 15, fontWeight: '900' },
  vsText: { color: C.accent, fontSize: 20, fontWeight: '900', fontStyle: 'italic' },
  foundCount: { color: C.text, fontSize: 46, fontWeight: '900', textAlign: 'center', marginTop: 10, fontVariant: ['tabular-nums'] },
  modeRow: { flexDirection: 'row', gap: 6, marginTop: 12, backgroundColor: 'rgba(0,0,0,0.25)', padding: 4, borderRadius: 10 },
  modeBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  modeOn: { backgroundColor: C.accent },
  modeText: { color: C.muted, fontWeight: '900', fontSize: 14, letterSpacing: 0.4 },
  modeTextOn: { color: '#111' },
  teams: { flexDirection: 'row', gap: 8, marginTop: 10 },
  team: { flex: 1, padding: 8, borderRadius: 12, borderWidth: 1 },
  teamA: { borderColor: 'rgba(58,160,255,0.5)', backgroundColor: 'rgba(58,160,255,0.06)' },
  teamB: { borderColor: 'rgba(255,93,93,0.5)', backgroundColor: 'rgba(255,93,93,0.06)' },
  teamLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 1.4, textAlign: 'center' },
  teamLabelA: { color: C.you },
  teamLabelB: { color: C.cpu },
  readyOn: { color: C.accent },
  roomCode: { alignItems: 'center', marginTop: 4 },
  roomCodeText: { color: C.accent, fontSize: 36, fontWeight: '900', letterSpacing: 6 },
  del: {
    width: 32, height: 32, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  delText: { color: C.muted, fontSize: 14, fontWeight: '800' },
  badge: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badgeWin: { backgroundColor: '#2f80ed' },
  badgeLoss: { backgroundColor: '#d23c3c' },
  badgeVoid: { backgroundColor: 'rgba(255,255,255,0.15)' },
  badgeText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  lbRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 8, borderRadius: 8 },
  lbHead: { paddingVertical: 2 },
  lbHeadText: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  lbMe: { backgroundColor: 'rgba(215,242,59,0.12)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.4)' },
  lbRank: { width: 30, color: C.text, fontWeight: '900', fontSize: 14 },
  lbTop: { color: C.accent },
  lbName: { flex: 1, color: C.text, fontWeight: '700', fontSize: 14 },
  lbNum: { width: 70, textAlign: 'right', color: C.text, fontWeight: '800', fontSize: 14 },
  toastWrap: { position: 'absolute', top: 8, left: 0, right: 0, alignItems: 'center', zIndex: 30 },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 460, width: '92%', padding: 10, borderRadius: 14,
    backgroundColor: C.panel, borderWidth: 1, borderColor: 'rgba(215,242,59,0.5)', elevation: 18,
  },
  linkWrap: { position: 'absolute', top: 10, left: 0, right: 0, alignItems: 'center', zIndex: 15 },
  link: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: 'rgba(10,16,26,0.86)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.45)',
  },
  linkText: { color: C.text, fontSize: 13, fontWeight: '800' },
});
