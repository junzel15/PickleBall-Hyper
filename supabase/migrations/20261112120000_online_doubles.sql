-- =============================================================================
-- Pickleball Hyper: online DOUBLES (2 vs 2, four real players)
-- =============================================================================
-- Additive: no table or row is dropped. Rooms and matches get a 'doubles' mode with
-- four seats, a per-match player list (online_match_players) holds who played on
-- which team, and the functions below are replaced to work for both modes.
--
-- Seats and teams (both modes)
--   seat 0 = host (team A), seat 1 = team B, seat 2 = team A, seat 3 = team B
--   team = seat % 2. Singles uses seats 0 and 1.
--   online_matches.host_score / guest_score = team A / team B score.
--
-- Realtime (security): game traffic now uses one channel per sender.
--   match:<id>          only the host (seat 0) may send; every player in the match receives
--   match:<id>:<uid>    only that player may send (their inputs); the host receives
-- so a player can never send messages that look like another player's.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Modes and seats
-- -----------------------------------------------------------------------------
alter table public.rooms drop constraint if exists rooms_mode_check;
alter table public.rooms add constraint rooms_mode_check check (mode in ('singles', 'doubles'));

alter table public.online_matches drop constraint if exists online_matches_mode_check;
alter table public.online_matches add constraint online_matches_mode_check check (mode in ('singles', 'doubles'));
alter table public.online_matches add column if not exists winner_team smallint check (winner_team in (0, 1));

alter table public.room_players drop constraint if exists room_players_seat_check;
alter table public.room_players add constraint room_players_seat_check check (seat between 0 and 3);

alter table public.matchmaking_queue add column if not exists mode text not null default 'singles';
alter table public.matchmaking_queue drop constraint if exists matchmaking_queue_mode_check;
alter table public.matchmaking_queue add constraint matchmaking_queue_mode_check check (mode in ('singles', 'doubles'));
create index if not exists matchmaking_queue_mode_seen_idx on public.matchmaking_queue (mode, last_seen);

-- Who played in a match, on which team (singles: 2 rows, doubles: 4 rows).
create table if not exists public.online_match_players (
  match_id       uuid not null references public.online_matches (id) on delete cascade,
  seat           smallint not null check (seat between 0 and 3),
  user_id        uuid references auth.users (id) on delete set null,
  team           smallint not null check (team in (0, 1)),
  name           text not null default 'Player' check (char_length(name) <= 40),
  rating_before  integer,
  rating_delta   integer,
  seen_at        timestamptz not null default now(),
  primary key (match_id, seat),
  constraint online_match_players_team check (team = seat % 2)
);
create unique index if not exists online_match_players_user_key on public.online_match_players (match_id, user_id);
create index if not exists online_match_players_user_idx on public.online_match_players (user_id);

-- existing singles matches: host = seat 0, guest = seat 1
insert into public.online_match_players (match_id, seat, user_id, team, name, rating_before, rating_delta, seen_at)
select m.id, 0, m.host_id, 0, m.host_name, m.host_rating_before, m.host_rating_delta, m.host_seen_at
from public.online_matches m
on conflict (match_id, seat) do nothing;
insert into public.online_match_players (match_id, seat, user_id, team, name, rating_before, rating_delta, seen_at)
select m.id, 1, m.guest_id, 1, m.guest_name, m.guest_rating_before, m.guest_rating_delta, m.guest_seen_at
from public.online_matches m
on conflict (match_id, seat) do nothing;
update public.online_matches m set winner_team = case when m.winner_id = m.host_id then 0 else 1 end
where m.winner_id is not null and m.winner_team is null;


-- -----------------------------------------------------------------------------
-- 2. Read access
-- -----------------------------------------------------------------------------
create or replace function private.is_match_player(p_match uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.online_match_players
    where match_id = p_match and user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_match_player(uuid) from public, anon;
grant execute on function private.is_match_player(uuid) to authenticated;

alter table public.online_match_players enable row level security;
drop policy if exists "online_match_players: players read" on public.online_match_players;
create policy "online_match_players: players read" on public.online_match_players
  for select to authenticated using ((select private.is_match_player(match_id)));
revoke all on public.online_match_players from anon, authenticated;
grant select on public.online_match_players to authenticated;

drop policy if exists "online_matches: players read" on public.online_matches;
create policy "online_matches: players read" on public.online_matches
  for select to authenticated using ((select private.is_match_player(id)));


-- -----------------------------------------------------------------------------
-- 3. Helpers
-- -----------------------------------------------------------------------------
create or replace function private.room_capacity(p_mode text)
returns integer
language sql
immutable
set search_path = ''
as $$ select case when p_mode = 'doubles' then 4 else 2 end; $$;
revoke all on function private.room_capacity(text) from public, anon, authenticated;

create or replace function private.room_state(p_room uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'code', r.code, 'kind', r.kind, 'mode', r.mode, 'status', r.status,
    'capacity', private.room_capacity(r.mode),
    'host_id', r.host_id, 'match_id', r.match_id,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', rp.user_id, 'seat', rp.seat, 'team', rp.seat % 2, 'ready', rp.ready,
        'name', coalesce(p.name, 'Player'), 'avatar', coalesce(p.avatar, '{}'::jsonb),
        'paddle', coalesce(p.paddle, 'tidal-wave'), 'rating', coalesce(ps.rating, 1000)
      ) order by rp.seat)
      from public.room_players rp
      left join public.profiles p on p.id = rp.user_id
      left join public.player_stats ps on ps.user_id = rp.user_id
      where rp.room_id = r.id), '[]'::jsonb),
    'match', (
      select jsonb_build_object(
        'id', m.id, 'mode', m.mode, 'host_id', m.host_id, 'guest_id', m.guest_id,
        'status', m.status, 'started_at', m.started_at,
        'players', coalesce((
          select jsonb_agg(jsonb_build_object(
            'seat', mp.seat, 'user_id', mp.user_id, 'team', mp.team, 'name', mp.name,
            'avatar', coalesce(p.avatar, '{}'::jsonb), 'paddle', coalesce(p.paddle, 'tidal-wave')
          ) order by mp.seat)
          from public.online_match_players mp
          left join public.profiles p on p.id = mp.user_id
          where mp.match_id = m.id), '[]'::jsonb))
      from public.online_matches m where m.id = r.match_id)
  )
  from public.rooms r where r.id = p_room;
$$;
revoke all on function private.room_state(uuid) from public, anon, authenticated;

-- Ends a match: team p_team wins. Ratings (Elo on team averages) and stats for every player.
create or replace function private.finish_match_team(
  p_match uuid, p_team integer, p_reason text,
  p_a_score integer, p_b_score integer, p_longest integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.online_matches;
  ra double precision; rb double precision;
  ea double precision;
  k constant integer := 32;
  da integer;
  r record;
  delta integer;
  deltas jsonb := '{}'::jsonb;
begin
  select * into m from public.online_matches where id = p_match for update;
  if not found or m.status <> 'active' then return; end if;
  if p_team not in (0, 1) then raise exception 'bad_winner' using errcode = 'P0001'; end if;

  insert into public.player_stats (user_id)
    select user_id from public.online_match_players where match_id = m.id and user_id is not null
    on conflict (user_id) do nothing;
  perform 1 from public.player_stats
    where user_id in (select user_id from public.online_match_players where match_id = m.id)
    order by user_id for update;

  select avg(coalesce(s.rating, 1000)) into ra from public.online_match_players mp
    left join public.player_stats s on s.user_id = mp.user_id where mp.match_id = m.id and mp.team = 0;
  select avg(coalesce(s.rating, 1000)) into rb from public.online_match_players mp
    left join public.player_stats s on s.user_id = mp.user_id where mp.match_id = m.id and mp.team = 1;
  ea := 1.0 / (1.0 + power(10.0, (rb - ra) / 400.0));
  da := round(k * ((case when p_team = 0 then 1 else 0 end) - ea));

  for r in
    select mp.seat, mp.user_id, mp.team, s.rating, s.streak
    from public.online_match_players mp
    join public.player_stats s on s.user_id = mp.user_id
    where mp.match_id = m.id
  loop
    delta := case when r.team = 0 then da else -da end;
    delta := greatest(100, r.rating + delta) - r.rating;
    update public.player_stats s set
      rating        = s.rating + delta,
      played        = s.played + 1,
      wins          = s.wins + case when r.team = p_team then 1 else 0 end,
      losses        = s.losses + case when r.team <> p_team then 1 else 0 end,
      forfeits      = s.forfeits + case when r.team <> p_team and p_reason in ('forfeit', 'left') then 1 else 0 end,
      streak        = case when r.team = p_team then s.streak + 1 else 0 end,
      best_streak   = greatest(s.best_streak, case when r.team = p_team then s.streak + 1 else 0 end),
      points_won    = s.points_won + coalesce(case when r.team = 0 then p_a_score else p_b_score end, 0),
      points_lost   = s.points_lost + coalesce(case when r.team = 0 then p_b_score else p_a_score end, 0),
      longest_rally = greatest(s.longest_rally, coalesce(p_longest, 0)),
      updated_at    = now()
    where s.user_id = r.user_id;
    update public.online_match_players set rating_before = r.rating, rating_delta = delta
      where match_id = m.id and seat = r.seat;
    deltas := deltas || jsonb_build_object(r.user_id::text, delta);
  end loop;

  update public.online_matches set
    status = 'finished', end_reason = p_reason, winner_team = p_team,
    winner_id = case when mode = 'singles' then case when p_team = 0 then host_id else guest_id end end,
    host_score = p_a_score, guest_score = p_b_score, longest_rally = p_longest,
    host_rating_before = (select rating_before from public.online_match_players where match_id = m.id and seat = 0),
    guest_rating_before = (select rating_before from public.online_match_players where match_id = m.id and seat = 1),
    host_rating_delta = (select rating_delta from public.online_match_players where match_id = m.id and seat = 0),
    guest_rating_delta = (select rating_delta from public.online_match_players where match_id = m.id and seat = 1),
    ended_at = now()
  where id = m.id;

  perform private.notify('match:' || m.id::text, 'match_final',
    jsonb_build_object('match_id', m.id, 'status', 'finished', 'winner_team', p_team, 'reason', p_reason,
                       'host_score', p_a_score, 'guest_score', p_b_score, 'deltas', deltas));
  if m.room_id is not null then perform private.release_room(m.room_id); end if;
end;
$$;
revoke all on function private.finish_match_team(uuid, integer, text, integer, integer, integer) from public, anon, authenticated;

-- kept for anything still calling the singles version
create or replace function private.finish_match(
  p_match uuid, p_winner uuid, p_reason text,
  p_host_score integer, p_guest_score integer, p_longest integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t integer;
begin
  select team into t from public.online_match_players where match_id = p_match and user_id = p_winner;
  if t is null then raise exception 'bad_winner' using errcode = 'P0001'; end if;
  perform private.finish_match_team(p_match, t, p_reason, p_host_score, p_guest_score, p_longest);
end;
$$;
revoke all on function private.finish_match(uuid, uuid, text, integer, integer, integer) from public, anon, authenticated;

create or replace function private.void_match(p_match uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.online_matches;
begin
  select * into m from public.online_matches where id = p_match for update;
  if not found or m.status <> 'active' then return; end if;
  update public.online_matches set status = p_status, end_reason = p_reason, ended_at = now() where id = m.id;
  perform private.notify('match:' || m.id::text, 'match_final',
    jsonb_build_object('match_id', m.id, 'status', p_status, 'reason', p_reason));
  if m.room_id is not null then perform private.release_room(m.room_id); end if;
end;
$$;
revoke all on function private.void_match(uuid, text, text) from public, anon, authenticated;

create or replace function private.cleanup()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  mid uuid;
begin
  delete from public.matchmaking_queue where last_seen < now() - interval '30 seconds';
  delete from public.room_invites where created_at < now() - interval '15 minutes';
  -- every player gone for 3 minutes: nobody wins
  for mid in
    select m.id from public.online_matches m
    where m.status = 'active'
      and not exists (select 1 from public.online_match_players mp
                      where mp.match_id = m.id and mp.seen_at > now() - interval '3 minutes')
    limit 20
  loop
    perform private.void_match(mid, 'abandoned', 'abandoned');
  end loop;
  delete from public.rooms where status = 'lobby' and updated_at < now() - interval '2 hours';
end;
$$;
revoke all on function private.cleanup() from public, anon, authenticated;

-- Takes a player out of their room. Walking out of a live match loses it for their
-- team, unless they already sent a valid result (then the reports settle it).
create or replace function private.leave_current(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rp public.room_players;
  r public.rooms;
  m public.online_matches;
  my_team integer;
begin
  delete from public.matchmaking_queue where user_id = p_user;
  select * into rp from public.room_players where user_id = p_user;
  if not found then return; end if;
  select * into r from public.rooms where id = rp.room_id for update;

  if r.status = 'playing' and r.match_id is not null then
    select * into m from public.online_matches where id = r.match_id;
    if found and m.status = 'active'
       and not exists (select 1 from public.match_reports
                       where match_id = m.id and user_id = p_user and valid) then
      select team into my_team from public.online_match_players where match_id = m.id and user_id = p_user;
      if my_team is not null then
        perform private.finish_match_team(m.id, 1 - my_team, 'left', null, null, null);
      end if;
    end if;
    if not exists (select 1 from public.rooms where id = r.id) then return; end if;
  end if;

  delete from public.room_players where room_id = r.id and user_id = p_user;
  delete from public.room_invites where room_id = r.id and from_id = p_user;

  if not exists (select 1 from public.room_players where room_id = r.id) then
    delete from public.rooms where id = r.id;
    return;
  end if;
  if r.kind = 'quick' then -- quick rooms are never reused: everyone is released
    perform private.notify('room:' || r.id::text, 'room_closed', jsonb_build_object('room_id', r.id));
    delete from public.rooms where id = r.id;
    return;
  end if;
  if rp.seat = 0 then -- the next player in seat order becomes the host
    update public.room_players set seat = 0
      where room_id = r.id
        and user_id = (select user_id from public.room_players where room_id = r.id order by seat limit 1);
    update public.rooms set host_id = (select user_id from public.room_players where room_id = r.id and seat = 0)
      where id = r.id;
  end if;
  update public.room_players set ready = false where room_id = r.id;
  update public.rooms set updated_at = now() where id = r.id;
  perform private.room_changed(r.id);
end;
$$;
revoke all on function private.leave_current(uuid) from public, anon, authenticated;

create or replace function private.begin_match(p_room uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rooms;
  cap integer;
  h uuid; g uuid;
  mid uuid;
begin
  select * into r from public.rooms where id = p_room for update;
  cap := private.room_capacity(r.mode);
  if (select count(*) from public.room_players where room_id = p_room and seat < cap) <> cap then
    raise exception 'need_more_players' using errcode = 'P0001';
  end if;
  select user_id into h from public.room_players where room_id = p_room and seat = 0;
  select user_id into g from public.room_players where room_id = p_room and seat = 1;
  insert into public.online_matches (room_id, kind, mode, host_id, guest_id, host_name, guest_name)
  values (p_room, r.kind, r.mode, h, g, private.name_of(h), private.name_of(g))
  returning id into mid;
  insert into public.online_match_players (match_id, seat, user_id, team, name)
  select mid, rp.seat, rp.user_id, rp.seat % 2, left(private.name_of(rp.user_id), 40)
  from public.room_players rp where rp.room_id = p_room;
  update public.rooms set status = 'playing', match_id = mid, updated_at = now() where id = p_room;
  update public.room_players set ready = true where room_id = p_room;
  perform private.room_changed(p_room, 'match_start');
  return mid;
end;
$$;
revoke all on function private.begin_match(uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 4. Rooms
-- -----------------------------------------------------------------------------
drop function if exists public.create_room();
drop function if exists private.create_room();

create or replace function private.create_room(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  rid uuid;
begin
  if coalesce(p_mode, '') not in ('singles', 'doubles') then raise exception 'bad_mode' using errcode = 'P0001'; end if;
  perform private.cleanup();
  perform private.leave_current(uid);
  rid := private.new_room('private', uid);
  update public.rooms set mode = p_mode where id = rid;
  insert into public.room_players (room_id, user_id, seat) values (rid, uid, 0);
  return private.room_state(rid);
end;
$$;

create or replace function private.join_room(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  v_code text := upper(btrim(coalesce(p_code, '')));
  r public.rooms;
  cap integer;
  free_seat smallint;
begin
  if v_code !~ '^[A-HJ-NP-Z2-9]{6}$' then raise exception 'room_not_found' using errcode = 'P0001'; end if;
  perform private.cleanup();
  select * into r from public.rooms where rooms.code = v_code for update;
  if not found or r.kind <> 'private' then raise exception 'room_not_found' using errcode = 'P0001'; end if;
  if exists (select 1 from public.room_players where room_id = r.id and user_id = uid) then
    return private.room_state(r.id);
  end if;
  if r.status <> 'lobby' then raise exception 'room_in_game' using errcode = 'P0001'; end if;
  cap := private.room_capacity(r.mode);
  if (select count(*) from public.room_players where room_id = r.id) >= cap then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  perform private.leave_current(uid);
  if not exists (select 1 from public.rooms where id = r.id) then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;
  select s into free_seat from generate_series(0, cap - 1) s
    where s not in (select seat from public.room_players where room_id = r.id) order by s limit 1;
  if free_seat is null then raise exception 'room_full' using errcode = 'P0001'; end if;
  insert into public.room_players (room_id, user_id, seat) values (r.id, uid, free_seat);
  if free_seat = 0 then update public.rooms set host_id = uid where id = r.id; end if;
  delete from public.room_invites where room_id = r.id and to_id = uid;
  update public.rooms set updated_at = now() where id = r.id;
  perform private.room_changed(r.id);
  return private.room_state(r.id);
end;
$$;

-- Host switches the room between 1 vs 1 and 2 vs 2 (in the lobby).
create or replace function private.set_room_mode(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  r public.rooms;
begin
  if coalesce(p_mode, '') not in ('singles', 'doubles') then raise exception 'bad_mode' using errcode = 'P0001'; end if;
  select r2.* into r from public.rooms r2 join public.room_players rp on rp.room_id = r2.id
    where rp.user_id = uid for update of r2;
  if not found then raise exception 'not_in_room' using errcode = 'P0001'; end if;
  if r.host_id <> uid then raise exception 'only_host_can_change' using errcode = 'P0001'; end if;
  if r.status <> 'lobby' then raise exception 'room_in_game' using errcode = 'P0001'; end if;
  if p_mode = 'singles' and exists (select 1 from public.room_players where room_id = r.id and seat >= 2) then
    raise exception 'too_many_players' using errcode = 'P0001';
  end if;
  update public.rooms set mode = p_mode, updated_at = now() where id = r.id;
  update public.room_players set ready = false where room_id = r.id;
  perform private.room_changed(r.id);
  return private.room_state(r.id);
end;
$$;

-- Move to another free seat (= pick your team) in a doubles lobby. The host stays in seat 0.
create or replace function private.change_seat(p_seat integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  r public.rooms;
  cur smallint;
begin
  select r2.* into r from public.rooms r2 join public.room_players rp on rp.room_id = r2.id
    where rp.user_id = uid for update of r2;
  if not found then raise exception 'not_in_room' using errcode = 'P0001'; end if;
  if r.status <> 'lobby' then raise exception 'room_in_game' using errcode = 'P0001'; end if;
  select seat into cur from public.room_players where room_id = r.id and user_id = uid;
  if cur = 0 then raise exception 'host_keeps_seat' using errcode = 'P0001'; end if;
  if p_seat is null or p_seat < 1 or p_seat >= private.room_capacity(r.mode) then
    raise exception 'bad_seat' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.room_players where room_id = r.id and seat = p_seat) then
    raise exception 'seat_taken' using errcode = 'P0001';
  end if;
  update public.room_players set seat = p_seat, ready = false where room_id = r.id and user_id = uid;
  update public.rooms set updated_at = now() where id = r.id;
  perform private.room_changed(r.id);
  return private.room_state(r.id);
end;
$$;

create or replace function private.start_match()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  r public.rooms;
  cap integer;
begin
  select r2.* into r from public.rooms r2
    join public.room_players rp on rp.room_id = r2.id
    where rp.user_id = uid
    for update of r2;
  if not found then raise exception 'not_in_room' using errcode = 'P0001'; end if;
  if r.host_id <> uid then raise exception 'only_host_can_start' using errcode = 'P0001'; end if;
  if r.status <> 'lobby' then raise exception 'room_in_game' using errcode = 'P0001'; end if;
  cap := private.room_capacity(r.mode);
  if (select count(*) from public.room_players where room_id = r.id) < cap then
    raise exception 'need_more_players' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.room_players where room_id = r.id and user_id <> uid and not ready) then
    raise exception 'opponent_not_ready' using errcode = 'P0001';
  end if;
  perform private.begin_match(r.id);
  return private.room_state(r.id);
end;
$$;

create or replace function private.invite_friend(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  r public.rooms;
begin
  select r2.* into r from public.rooms r2 join public.room_players rp on rp.room_id = r2.id where rp.user_id = uid;
  if not found or r.kind <> 'private' then raise exception 'not_in_room' using errcode = 'P0001'; end if;
  if r.status <> 'lobby' then raise exception 'room_in_game' using errcode = 'P0001'; end if;
  if (select count(*) from public.room_players where room_id = r.id) >= private.room_capacity(r.mode) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.friendships
                 where user_a = least(uid, p_user) and user_b = greatest(uid, p_user) and status = 'accepted') then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  insert into public.room_invites (room_id, from_id, to_id) values (r.id, uid, p_user)
  on conflict (room_id, to_id) do update set created_at = now(), from_id = excluded.from_id;
  perform private.notify('user:' || p_user::text, 'room_invite',
    jsonb_build_object('code', r.code, 'from_name', private.name_of(uid), 'mode', r.mode));
end;
$$;

create or replace function private.list_invites()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'code', r.code, 'mode', r.mode, 'from_id', i.from_id,
      'from_name', coalesce(p.name, 'Player'), 'created_at', i.created_at
    ) order by i.created_at desc), '[]'::jsonb)
  from public.room_invites i
  join public.rooms r on r.id = i.room_id
  left join public.profiles p on p.id = i.from_id
  where i.to_id = (select auth.uid())
    and i.created_at > now() - interval '15 minutes'
    and r.status = 'lobby'
    and (select count(*) from public.room_players rp where rp.room_id = r.id) < private.room_capacity(r.mode);
$$;


-- -----------------------------------------------------------------------------
-- 5. Quick Match (1 vs 1 or 2 vs 2)
-- -----------------------------------------------------------------------------
drop function if exists public.quick_match();
drop function if exists private.quick_match();

create or replace function private.quick_match(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  v_mode text := coalesce(p_mode, 'singles');
  need integer;
  cur public.rooms;
  my_rating integer;
  picked uuid[];
  ordered uuid[];
  rid uuid;
  u uuid;
begin
  if v_mode not in ('singles', 'doubles') then raise exception 'bad_mode' using errcode = 'P0001'; end if;
  -- one matchmaker at a time: no two calls can pair the same player
  perform pg_advisory_xact_lock(hashtext('pickleball_hyper.matchmaking'));
  perform private.cleanup();

  select r.* into cur from public.rooms r join public.room_players rp on rp.room_id = r.id where rp.user_id = uid;
  if found then
    if cur.kind = 'quick' then
      delete from public.matchmaking_queue where user_id = uid;
      return jsonb_build_object('status', 'matched', 'room', private.room_state(cur.id));
    end if;
    perform private.leave_current(uid);
  end if;

  need := private.room_capacity(v_mode) - 1;
  my_rating := private.rating_of(uid);
  select array_agg(q.user_id) into picked from (
    select q.user_id from public.matchmaking_queue q
    where q.user_id <> uid and q.mode = v_mode
      and q.last_seen > now() - interval '15 seconds'
      and not exists (select 1 from public.room_players rp where rp.user_id = q.user_id)
    order by abs(q.rating - my_rating), q.enqueued_at
    limit need
  ) q;

  if coalesce(array_length(picked, 1), 0) < need then
    insert into public.matchmaking_queue (user_id, rating, mode) values (uid, my_rating, v_mode)
    on conflict (user_id) do update set last_seen = now(), rating = excluded.rating,
      mode = excluded.mode,
      enqueued_at = case when public.matchmaking_queue.mode = excluded.mode
                         then public.matchmaking_queue.enqueued_at else now() end;
    return jsonb_build_object('status', 'searching', 'mode', v_mode,
      'waiting', (select count(*) from public.matchmaking_queue where user_id <> uid and mode = v_mode
                    and last_seen > now() - interval '15 seconds'));
  end if;

  picked := picked || uid;
  delete from public.matchmaking_queue where user_id = any (picked);
  -- seats by rating: 1st and 4th best together (team A: seats 0, 2), 2nd and 3rd (team B: seats 1, 3)
  select array_agg(x.user_id order by x.rating desc, x.user_id) into ordered
    from (select p as user_id, private.rating_of(p) as rating from unnest(picked) p) x;
  rid := private.new_room('quick', ordered[1]);
  update public.rooms set mode = v_mode where id = rid;
  if v_mode = 'singles' then
    insert into public.room_players (room_id, user_id, seat, ready) values
      (rid, ordered[1], 0, true), (rid, ordered[2], 1, true);
  else
    insert into public.room_players (room_id, user_id, seat, ready) values
      (rid, ordered[1], 0, true), (rid, ordered[2], 1, true),
      (rid, ordered[4], 2, true), (rid, ordered[3], 3, true);
  end if;
  perform private.begin_match(rid);
  foreach u in array picked loop
    if u <> uid then
      perform private.notify('user:' || u::text, 'match_found', jsonb_build_object('room_id', rid));
    end if;
  end loop;
  return jsonb_build_object('status', 'matched', 'room', private.room_state(rid));
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. Heartbeat, forfeit, results
-- -----------------------------------------------------------------------------
create or replace function private.match_heartbeat(p_match uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  m public.online_matches;
begin
  select * into m from public.online_matches where id = p_match;
  if not found or not exists (select 1 from public.online_match_players where match_id = p_match and user_id = uid) then
    raise exception 'match_not_found' using errcode = 'P0001';
  end if;
  if m.status = 'active' then
    update public.online_match_players set seen_at = now() where match_id = p_match and user_id = uid;
    update public.online_matches set
      host_seen_at  = case when host_id = uid then now() else host_seen_at end,
      guest_seen_at = case when guest_id = uid then now() else guest_seen_at end
    where id = p_match;
  end if;
  return jsonb_build_object(
    'status', m.status, 'reason', m.end_reason, 'winner_id', m.winner_id, 'winner_team', m.winner_team,
    'deltas', (select coalesce(jsonb_object_agg(mp.user_id::text, mp.rating_delta), '{}'::jsonb)
               from public.online_match_players mp where mp.match_id = m.id and mp.rating_delta is not null),
    'opponent_seen_ago', (select coalesce(max(extract(epoch from now() - mp.seen_at)), 0)
                          from public.online_match_players mp where mp.match_id = m.id and mp.user_id <> uid)
  );
end;
$$;

-- Someone on the other team has been silent for 30+ s (by the server's own clock):
-- the caller's team wins by forfeit. If players on both teams are gone, nobody wins.
create or replace function private.claim_forfeit(p_match uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  m public.online_matches;
  my_team integer;
  opp_gone boolean;
  mate_gone boolean;
begin
  select * into m from public.online_matches where id = p_match for update;
  select team into my_team from public.online_match_players where match_id = p_match and user_id = uid;
  if not found or my_team is null then raise exception 'match_not_found' using errcode = 'P0001'; end if;
  if m.status <> 'active' then
    return jsonb_build_object('status', m.status, 'winner_team', m.winner_team, 'reason', m.end_reason);
  end if;
  opp_gone := exists (select 1 from public.online_match_players
                      where match_id = p_match and team <> my_team and seen_at < now() - interval '30 seconds');
  if not opp_gone then raise exception 'opponent_still_connected' using errcode = 'P0001'; end if;
  update public.online_match_players set seen_at = now() where match_id = p_match and user_id = uid;
  mate_gone := exists (select 1 from public.online_match_players
                       where match_id = p_match and team = my_team and user_id <> uid
                         and seen_at < now() - interval '30 seconds');
  if mate_gone then
    perform private.void_match(p_match, 'abandoned', 'abandoned');
    return jsonb_build_object('status', 'abandoned', 'reason', 'abandoned');
  end if;
  perform private.finish_match_team(p_match, my_team, 'forfeit', null, null, null);
  return jsonb_build_object('status', 'finished', 'winner_team', my_team, 'reason', 'forfeit');
end;
$$;

-- The reports: a result counts only when EVERY player has sent one and all are valid
-- and identical. Called by the submit-result Edge Function (service role only).
create or replace function public.svc_submit_report(
  p_match uuid, p_user uuid,
  p_host_score integer, p_guest_score integer, p_longest integer,
  p_winners text, p_valid boolean, p_reason text, p_last_point_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.online_matches;
  valid boolean := p_valid;
  reason text := p_reason;
  n_players integer;
  n_reports integer;
  n_agree integer;
  mine public.match_reports;
begin
  select * into m from public.online_matches where id = p_match for update;
  if not found or p_user is null
     or not exists (select 1 from public.online_match_players where match_id = p_match and user_id = p_user) then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_a_player');
  end if;
  if m.status <> 'active' then
    return jsonb_build_object('status', m.status, 'winner_team', m.winner_team, 'reason', m.end_reason,
                              'host_score', m.host_score, 'guest_score', m.guest_score);
  end if;
  if valid and p_last_point_ms > extract(epoch from now() - m.started_at) * 1000 + 15000 then
    valid := false; reason := 'too_long_for_server_clock';
  end if;

  insert into public.match_reports (match_id, user_id, host_score, guest_score, longest_rally, winners, valid, invalid_reason)
  values (p_match, p_user, p_host_score, p_guest_score, least(greatest(p_longest, 0), 999), p_winners, valid, reason)
  on conflict (match_id, user_id) do nothing; -- the first report counts; it can't be changed

  select * into mine from public.match_reports where match_id = p_match and user_id = p_user;
  select count(*) into n_players from public.online_match_players where match_id = p_match and user_id is not null;
  select count(*) into n_reports from public.match_reports where match_id = p_match;
  if n_reports < n_players then
    return jsonb_build_object('status', 'waiting_for_opponent', 'reports', n_reports, 'players', n_players);
  end if;

  select count(*) into n_agree from public.match_reports
    where match_id = p_match and valid and winners = mine.winners
      and host_score = mine.host_score and guest_score = mine.guest_score;
  if mine.valid and n_agree = n_players then
    perform private.finish_match_team(p_match, case when mine.host_score > mine.guest_score then 0 else 1 end,
      'score', mine.host_score, mine.guest_score,
      (select max(longest_rally) from public.match_reports where match_id = p_match));
    select * into m from public.online_matches where id = p_match;
    return jsonb_build_object('status', 'finished', 'winner_team', m.winner_team, 'winner_id', m.winner_id,
      'reason', 'score', 'host_score', m.host_score, 'guest_score', m.guest_score,
      'host_delta', m.host_rating_delta, 'guest_delta', m.guest_rating_delta,
      'deltas', (select coalesce(jsonb_object_agg(mp.user_id::text, mp.rating_delta), '{}'::jsonb)
                 from public.online_match_players mp where mp.match_id = p_match and mp.user_id is not null));
  end if;

  perform private.void_match(p_match, 'disputed', 'dispute');
  return jsonb_build_object('status', 'disputed', 'reason', 'dispute');
end;
$$;
revoke all on function public.svc_submit_report(uuid, uuid, integer, integer, integer, text, boolean, text, integer)
  from public, anon, authenticated;
grant execute on function public.svc_submit_report(uuid, uuid, integer, integer, integer, text, boolean, text, integer)
  to service_role;

-- 60 s after sending your report, some players still haven't:
--   * if the reports that did arrive are all valid, identical and come from BOTH teams,
--     that result stands;
--   * else if everyone missing is on the other team and has been gone 30 s+, your
--     team wins by forfeit;
--   * otherwise the match is disputed and doesn't count.
create or replace function private.resolve_missing_report(p_match uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  m public.online_matches;
  my_team integer;
  mine public.match_reports;
  n_reports integer;
  n_agree integer;
  teams_reporting integer;
  missing_ok boolean;
begin
  select * into m from public.online_matches where id = p_match for update;
  select team into my_team from public.online_match_players where match_id = p_match and user_id = uid;
  if not found or my_team is null then raise exception 'match_not_found' using errcode = 'P0001'; end if;
  if m.status <> 'active' then
    return jsonb_build_object('status', m.status, 'winner_team', m.winner_team, 'reason', m.end_reason);
  end if;
  select * into mine from public.match_reports where match_id = p_match and user_id = uid;
  if mine.match_id is null or mine.submitted_at > now() - interval '60 seconds' then
    raise exception 'too_early' using errcode = 'P0001';
  end if;

  select count(*) into n_reports from public.match_reports where match_id = p_match;
  select count(*) into n_agree from public.match_reports
    where match_id = p_match and valid and winners = mine.winners
      and host_score = mine.host_score and guest_score = mine.guest_score;
  select count(distinct mp.team) into teams_reporting from public.match_reports r
    join public.online_match_players mp on mp.match_id = r.match_id and mp.user_id = r.user_id
    where r.match_id = p_match;
  if mine.valid and n_agree = n_reports and teams_reporting = 2 then
    perform private.finish_match_team(p_match, case when mine.host_score > mine.guest_score then 0 else 1 end,
      'score', mine.host_score, mine.guest_score,
      (select max(longest_rally) from public.match_reports where match_id = p_match));
    return jsonb_build_object('status', 'finished', 'winner_team', case when mine.host_score > mine.guest_score then 0 else 1 end, 'reason', 'score');
  end if;

  -- everyone who didn't report is on the other team and gone
  missing_ok := not exists (
    select 1 from public.online_match_players mp
    where mp.match_id = p_match and mp.user_id is not null
      and not exists (select 1 from public.match_reports r where r.match_id = p_match and r.user_id = mp.user_id)
      and (mp.team = my_team or mp.seen_at > now() - interval '30 seconds'));
  if mine.valid and n_agree = n_reports and missing_ok then
    perform private.finish_match_team(p_match, my_team, 'forfeit', null, null, null);
    return jsonb_build_object('status', 'finished', 'winner_team', my_team, 'reason', 'forfeit');
  end if;
  perform private.void_match(p_match, 'disputed', 'dispute');
  return jsonb_build_object('status', 'disputed', 'reason', 'dispute');
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. History (works for both modes)
-- -----------------------------------------------------------------------------
create or replace function private.get_online_history(p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(h) order by h.started_at desc), '[]'::jsonb)
  from (
    select m.id, m.kind, m.mode, m.status, m.end_reason, m.started_at, m.ended_at, m.longest_rally,
      (select string_agg(o.name, ' & ' order by o.seat) from public.online_match_players o
        where o.match_id = m.id and o.team <> me.team) as opponent,
      (select string_agg(o.name, ' & ' order by o.seat) from public.online_match_players o
        where o.match_id = m.id and o.team = me.team and o.seat <> me.seat) as partner,
      case when me.team = 0 then m.host_score else m.guest_score end as my_score,
      case when me.team = 0 then m.guest_score else m.host_score end as opp_score,
      case when m.winner_team is null then null else m.winner_team = me.team end as won,
      me.rating_delta
    from public.online_match_players me
    join public.online_matches m on m.id = me.match_id
    where me.user_id = (select auth.uid()) and m.status <> 'active'
    order by m.started_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) h;
$$;


-- -----------------------------------------------------------------------------
-- 8. Grants and API wrappers for the new / changed functions
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'private.create_room(text)', 'private.quick_match(text)', 'private.set_room_mode(text)',
    'private.change_seat(integer)', 'private.join_room(text)', 'private.start_match()',
    'private.invite_friend(uuid)', 'private.list_invites()', 'private.match_heartbeat(uuid)',
    'private.claim_forfeit(uuid)', 'private.resolve_missing_report(uuid)', 'private.get_online_history(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

create or replace function public.create_room(p_mode text default 'singles') returns jsonb
  language sql security invoker set search_path = '' as $$ select private.create_room(p_mode); $$;
create or replace function public.quick_match(p_mode text default 'singles') returns jsonb
  language sql security invoker set search_path = '' as $$ select private.quick_match(p_mode); $$;
create or replace function public.set_room_mode(p_mode text) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.set_room_mode(p_mode); $$;
create or replace function public.change_seat(p_seat integer) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.change_seat(p_seat); $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.create_room(text)', 'public.quick_match(text)', 'public.set_room_mode(text)', 'public.change_seat(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- -----------------------------------------------------------------------------
-- 9. Realtime authorization: one sender per channel
-- -----------------------------------------------------------------------------
create or replace function private.can_use_topic(p_topic text, p_extension text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  target uuid;
  sender uuid;
  uuid_re constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  if uid is null or p_topic is null then return false; end if;
  if p_topic = 'lobby' then
    return not p_write or p_extension = 'presence'; -- presence only
  end if;
  if p_topic = 'user:' || uid::text then
    return not p_write; -- notices come from the server only
  end if;
  if p_topic ~ ('^room:' || uuid_re || '$') then
    target := substr(p_topic, 6)::uuid;
    return exists (select 1 from public.room_players where room_id = target and user_id = uid);
  end if;
  if p_topic ~ ('^match:' || uuid_re || '$') then
    -- the host's channel: everyone in the match listens, only the host (seat 0) sends
    target := substr(p_topic, 7)::uuid;
    return exists (select 1 from public.online_matches m
                   join public.online_match_players mp on mp.match_id = m.id
                   where m.id = target and m.status = 'active' and mp.user_id = uid
                     and (not p_write or mp.seat = 0));
  end if;
  if p_topic ~ ('^match:' || uuid_re || ':' || uuid_re || '$') then
    -- one player's input channel: only that player sends, only the host listens
    target := substr(p_topic, 7, 36)::uuid;
    sender := substr(p_topic, 44, 36)::uuid;
    if p_write then
      return sender = uid and exists (select 1 from public.online_matches m
                   join public.online_match_players mp on mp.match_id = m.id
                   where m.id = target and m.status = 'active' and mp.user_id = uid);
    end if;
    return exists (select 1 from public.online_matches m
                   join public.online_match_players mp on mp.match_id = m.id
                   where m.id = target and m.status = 'active' and mp.user_id = uid and mp.seat = 0)
       and exists (select 1 from public.online_match_players mp
                   where mp.match_id = target and mp.user_id = sender);
  end if;
  return false;
end;
$$;
revoke all on function private.can_use_topic(text, text, boolean) from public, anon;
grant execute on function private.can_use_topic(text, text, boolean) to authenticated;
