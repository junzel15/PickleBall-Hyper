-- =============================================================================
-- Pickleball Hyper: online multiplayer
--   friend codes, friends, rooms + lobbies, invites, Quick Match queue,
--   online matches, result reports, player stats (Elo), online leaderboard,
--   and Realtime authorization for the private channels the game uses.
-- =============================================================================
-- Additive only: no existing table, column or row is dropped or changed
-- (profiles gets a new friend_code column; existing rows get a random code).
--
-- Security model
--   * Every new table has Row Level Security. Players can READ only rows they
--     belong to (their room, their matches, their stats, their friendships).
--   * Players can't INSERT / UPDATE / DELETE any of these tables directly.
--     Every change goes through the functions below, which check who is
--     calling and what state things are in (SECURITY DEFINER in the private
--     schema, which the API does not expose; the API calls thin SECURITY
--     INVOKER wrappers in public, like get_leaderboard()).
--   * Match RESULTS can only be written by the submit-result Edge Function
--     (service role): it checks the point-by-point log against the rules and
--     both players' reports must agree. Clients never write scores or stats.
--   * Quick Match pairing runs under a transaction-scoped advisory lock and
--     every player can be in at most one room (unique index), so the same
--     player can never end up in two matches.
--
-- Realtime topics (all private channels)
--   lobby            presence of signed-in players (presence only, no broadcast)
--   user:<uid>       server -> player notices (invites, friend requests, match found)
--   room:<room id>   room members: lobby changes, match start/end
--   match:<match id> the two players of an active match: game traffic
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Housekeeping
-- -----------------------------------------------------------------------------
-- rls_auto_enable() is an event-trigger function; nobody should call it over the API.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- Random codes without look-alike characters (no 0/O, 1/I).
create or replace function private.random_code(len integer)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 symbols
  bytes bytea := extensions.gen_random_bytes(len);
  result text := '';
begin
  for i in 0 .. len - 1 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;
revoke all on function private.random_code(integer) from public, anon;
grant execute on function private.random_code(integer) to authenticated;

-- The signed-in caller, or an error.
create or replace function private.me()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  return uid;
end;
$$;
revoke all on function private.me() from public, anon;
grant execute on function private.me() to authenticated;

-- Server -> client notice on a private Realtime topic. Never breaks the caller.
create or replace function private.notify(p_topic text, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(coalesce(p_payload, '{}'::jsonb), p_event, p_topic, true);
exception when others then
  null; -- a missed notice is recovered by the next refresh
end;
$$;
revoke all on function private.notify(text, text, jsonb) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 1. Friend codes on profiles
-- -----------------------------------------------------------------------------
alter table public.profiles add column if not exists friend_code text;
update public.profiles set friend_code = private.random_code(8) where friend_code is null;
alter table public.profiles alter column friend_code set default private.random_code(8);
alter table public.profiles alter column friend_code set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_friend_code_format') then
    alter table public.profiles add constraint profiles_friend_code_format
      check (friend_code ~ '^[A-HJ-NP-Z2-9]{8}$');
  end if;
end $$;
create unique index if not exists profiles_friend_code_key on public.profiles (friend_code);

-- Players can't choose or change their friend code.
create or replace function private.profiles_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.friend_code := private.random_code(8);
  return new;
end;
$$;
revoke all on function private.profiles_before_insert() from public, anon, authenticated;

drop trigger if exists profiles_before_insert on public.profiles;
create trigger profiles_before_insert
  before insert on public.profiles
  for each row execute function private.profiles_before_insert();

create or replace function private.profiles_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  new.friend_code := old.friend_code;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.profiles_before_update() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.player_stats (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  rating         integer not null default 1000 check (rating between 100 and 5000),
  played         integer not null default 0 check (played >= 0),
  wins           integer not null default 0 check (wins >= 0),
  losses         integer not null default 0 check (losses >= 0),
  forfeits       integer not null default 0 check (forfeits >= 0),
  streak         integer not null default 0 check (streak >= 0),
  best_streak    integer not null default 0 check (best_streak >= 0),
  points_won     integer not null default 0 check (points_won >= 0),
  points_lost    integer not null default 0 check (points_lost >= 0),
  longest_rally  integer not null default 0 check (longest_rally >= 0),
  updated_at     timestamptz not null default now(),
  constraint player_stats_totals check (wins + losses = played)
);
create index if not exists player_stats_rating_idx on public.player_stats (rating desc) where played > 0;

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  kind        text not null check (kind in ('private', 'quick')),
  mode        text not null default 'singles' check (mode = 'singles'),
  status      text not null default 'lobby' check (status in ('lobby', 'playing')),
  host_id     uuid not null references auth.users (id) on delete cascade,
  match_id    uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists rooms_status_updated_idx on public.rooms (status, updated_at);

create table if not exists public.room_players (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  seat       smallint not null check (seat in (0, 1)), -- 0 = host
  ready      boolean not null default false,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id),
  constraint room_players_seat_key unique (room_id, seat),
  constraint room_players_one_room_key unique (user_id)   -- one room per player
);

create table if not exists public.room_invites (
  id          bigint generated always as identity primary key,
  room_id     uuid not null references public.rooms (id) on delete cascade,
  from_id     uuid not null references auth.users (id) on delete cascade,
  to_id       uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint room_invites_once unique (room_id, to_id),
  constraint room_invites_not_self check (from_id <> to_id)
);
create index if not exists room_invites_to_idx on public.room_invites (to_id, created_at desc);
create index if not exists room_invites_from_idx on public.room_invites (from_id);

create table if not exists public.friendships (
  user_a        uuid not null references auth.users (id) on delete cascade, -- the smaller id
  user_b        uuid not null references auth.users (id) on delete cascade,
  requested_by  uuid not null,
  status        text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_ordered check (user_a < user_b),
  constraint friendships_requester check (requested_by in (user_a, user_b))
);
create index if not exists friendships_b_idx on public.friendships (user_b);

create table if not exists public.matchmaking_queue (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  rating       integer not null,
  enqueued_at  timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create index if not exists matchmaking_queue_seen_idx on public.matchmaking_queue (last_seen);

create table if not exists public.online_matches (
  id                   uuid primary key default gen_random_uuid(),
  room_id              uuid references public.rooms (id) on delete set null,
  kind                 text not null check (kind in ('private', 'quick')),
  mode                 text not null default 'singles' check (mode = 'singles'),
  host_id              uuid references auth.users (id) on delete set null,
  guest_id             uuid references auth.users (id) on delete set null,
  host_name            text not null default 'Player' check (char_length(host_name) <= 40),
  guest_name           text not null default 'Player' check (char_length(guest_name) <= 40),
  status               text not null default 'active'
                         check (status in ('active', 'finished', 'disputed', 'abandoned')),
  end_reason           text check (end_reason in ('score', 'forfeit', 'left', 'dispute', 'abandoned')),
  host_score           smallint check (host_score between 0 and 99),
  guest_score          smallint check (guest_score between 0 and 99),
  winner_id            uuid references auth.users (id) on delete set null,
  longest_rally        smallint check (longest_rally between 0 and 999),
  host_rating_before   integer,
  guest_rating_before  integer,
  host_rating_delta    integer,
  guest_rating_delta   integer,
  host_seen_at         timestamptz not null default now(),
  guest_seen_at        timestamptz not null default now(),
  started_at           timestamptz not null default now(),
  ended_at             timestamptz,
  constraint online_matches_two_players check (host_id is distinct from guest_id),
  constraint online_matches_finished_has_end check (status = 'active' or ended_at is not null)
);
create index if not exists online_matches_host_idx on public.online_matches (host_id, started_at desc);
create index if not exists online_matches_guest_idx on public.online_matches (guest_id, started_at desc);
create index if not exists online_matches_active_idx on public.online_matches (started_at) where status = 'active';
create unique index if not exists online_matches_one_active_per_room on public.online_matches (room_id) where status = 'active';
create index if not exists online_matches_winner_idx on public.online_matches (winner_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rooms_match_id_fkey') then
    alter table public.rooms add constraint rooms_match_id_fkey
      foreign key (match_id) references public.online_matches (id) on delete set null;
  end if;
end $$;
create index if not exists rooms_match_idx on public.rooms (match_id);

-- What each player reported at the end of a match (written by the Edge Function only).
create table if not exists public.match_reports (
  match_id        uuid not null references public.online_matches (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  host_score      smallint not null check (host_score between 0 and 99),
  guest_score     smallint not null check (guest_score between 0 and 99),
  longest_rally   smallint not null check (longest_rally between 0 and 999),
  winners         text not null check (winners ~ '^[hg]{1,200}$'), -- rally winners in order
  valid           boolean not null,
  invalid_reason  text,
  submitted_at    timestamptz not null default now(),
  primary key (match_id, user_id)
);
create index if not exists match_reports_user_idx on public.match_reports (user_id);


-- -----------------------------------------------------------------------------
-- 3. Row Level Security (read-only for players; all writes go through functions)
-- -----------------------------------------------------------------------------
create or replace function private.is_room_member(p_room uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_players
    where room_id = p_room and user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_room_member(uuid) from public, anon;
grant execute on function private.is_room_member(uuid) to authenticated;

alter table public.player_stats      enable row level security;
alter table public.rooms             enable row level security;
alter table public.room_players      enable row level security;
alter table public.room_invites      enable row level security;
alter table public.friendships       enable row level security;
alter table public.matchmaking_queue enable row level security;
alter table public.online_matches    enable row level security;
alter table public.match_reports     enable row level security;

drop policy if exists "player_stats: read own" on public.player_stats;
create policy "player_stats: read own" on public.player_stats
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "rooms: members read" on public.rooms;
create policy "rooms: members read" on public.rooms
  for select to authenticated using ((select private.is_room_member(id)));

drop policy if exists "room_players: members read" on public.room_players;
create policy "room_players: members read" on public.room_players
  for select to authenticated using ((select private.is_room_member(room_id)));

drop policy if exists "room_invites: own read" on public.room_invites;
create policy "room_invites: own read" on public.room_invites
  for select to authenticated using ((select auth.uid()) in (from_id, to_id));

drop policy if exists "friendships: own read" on public.friendships;
create policy "friendships: own read" on public.friendships
  for select to authenticated using ((select auth.uid()) in (user_a, user_b));

drop policy if exists "matchmaking_queue: own read" on public.matchmaking_queue;
create policy "matchmaking_queue: own read" on public.matchmaking_queue
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "online_matches: players read" on public.online_matches;
create policy "online_matches: players read" on public.online_matches
  for select to authenticated using ((select auth.uid()) in (host_id, guest_id));
-- match_reports: no policy at all (server only)

revoke all on public.player_stats, public.rooms, public.room_players, public.room_invites,
  public.friendships, public.matchmaking_queue, public.online_matches, public.match_reports
  from anon, authenticated;
grant select on public.player_stats, public.rooms, public.room_players, public.room_invites,
  public.friendships, public.matchmaking_queue, public.online_matches
  to authenticated;


-- -----------------------------------------------------------------------------
-- 4. Internal helpers
-- -----------------------------------------------------------------------------
create or replace function private.rating_of(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select rating from public.player_stats where user_id = p_user), 1000);
$$;
revoke all on function private.rating_of(uuid) from public, anon, authenticated;

create or replace function private.name_of(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select name from public.profiles where id = p_user), 'Player');
$$;
revoke all on function private.name_of(uuid) from public, anon, authenticated;

-- Everything a room member needs to draw the lobby.
create or replace function private.room_state(p_room uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'code', r.code, 'kind', r.kind, 'mode', r.mode, 'status', r.status,
    'host_id', r.host_id, 'match_id', r.match_id,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', rp.user_id, 'seat', rp.seat, 'ready', rp.ready,
        'name', coalesce(p.name, 'Player'), 'avatar', coalesce(p.avatar, '{}'::jsonb),
        'paddle', coalesce(p.paddle, 'tidal-wave'), 'rating', coalesce(ps.rating, 1000)
      ) order by rp.seat)
      from public.room_players rp
      left join public.profiles p on p.id = rp.user_id
      left join public.player_stats ps on ps.user_id = rp.user_id
      where rp.room_id = r.id), '[]'::jsonb),
    'match', (
      select jsonb_build_object('id', m.id, 'host_id', m.host_id, 'guest_id', m.guest_id,
                                'status', m.status, 'started_at', m.started_at)
      from public.online_matches m where m.id = r.match_id)
  )
  from public.rooms r where r.id = p_room;
$$;
revoke all on function private.room_state(uuid) from public, anon, authenticated;

create or replace function private.room_changed(p_room uuid, p_event text default 'room_changed')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.notify('room:' || p_room::text, p_event, jsonb_build_object('room_id', p_room));
end;
$$;
revoke all on function private.room_changed(uuid, text) from public, anon, authenticated;

-- After a match ends: quick rooms are closed, private rooms go back to the lobby.
create or replace function private.release_room(p_room uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rooms;
begin
  select * into r from public.rooms where id = p_room for update;
  if not found then return; end if;
  if r.kind = 'quick' then
    perform private.notify('room:' || r.id::text, 'room_closed', jsonb_build_object('room_id', r.id));
    delete from public.rooms where id = r.id;
  else
    update public.rooms set status = 'lobby', match_id = null, updated_at = now() where id = r.id;
    update public.room_players set ready = false where room_id = r.id;
    perform private.room_changed(r.id);
  end if;
end;
$$;
revoke all on function private.release_room(uuid) from public, anon, authenticated;

-- Ends a match with a winner and applies ratings and stats. The caller holds the
-- match row lock. Scores may be null for forfeits.
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
  m public.online_matches;
  loser uuid;
  rh integer; rg integer;
  expected_host double precision;
  k constant integer := 32;
  dh integer; dg integer;
  host_won boolean;
begin
  select * into m from public.online_matches where id = p_match for update;
  if not found or m.status <> 'active' then return; end if;
  if p_winner is null or p_winner not in (m.host_id, m.guest_id) then
    raise exception 'bad_winner' using errcode = 'P0001';
  end if;
  loser := case when p_winner = m.host_id then m.guest_id else m.host_id end;
  host_won := p_winner = m.host_id;

  -- both stats rows exist, locked in a fixed order (no deadlocks)
  insert into public.player_stats (user_id) values (m.host_id), (m.guest_id) on conflict (user_id) do nothing;
  perform 1 from public.player_stats where user_id in (m.host_id, m.guest_id) order by user_id for update;
  select rating into rh from public.player_stats where user_id = m.host_id;
  select rating into rg from public.player_stats where user_id = m.guest_id;

  -- Elo
  expected_host := 1.0 / (1.0 + power(10.0, (rg - rh) / 400.0));
  dh := round(k * ((case when host_won then 1 else 0 end) - expected_host));
  dg := -dh;
  dh := greatest(100, rh + dh) - rh;
  dg := greatest(100, rg + dg) - rg;

  update public.player_stats s set
    rating        = s.rating + case when s.user_id = m.host_id then dh else dg end,
    played        = s.played + 1,
    wins          = s.wins + case when s.user_id = p_winner then 1 else 0 end,
    losses        = s.losses + case when s.user_id = loser then 1 else 0 end,
    forfeits      = s.forfeits + case when s.user_id = loser and p_reason in ('forfeit', 'left') then 1 else 0 end,
    streak        = case when s.user_id = p_winner then s.streak + 1 else 0 end,
    best_streak   = greatest(s.best_streak, case when s.user_id = p_winner then s.streak + 1 else 0 end),
    points_won    = s.points_won + coalesce(case when s.user_id = m.host_id then p_host_score else p_guest_score end, 0),
    points_lost   = s.points_lost + coalesce(case when s.user_id = m.host_id then p_guest_score else p_host_score end, 0),
    longest_rally = greatest(s.longest_rally, coalesce(p_longest, 0)),
    updated_at    = now()
  where s.user_id in (m.host_id, m.guest_id);

  update public.online_matches set
    status = 'finished', end_reason = p_reason, winner_id = p_winner,
    host_score = p_host_score, guest_score = p_guest_score, longest_rally = p_longest,
    host_rating_before = rh, guest_rating_before = rg,
    host_rating_delta = dh, guest_rating_delta = dg,
    ended_at = now()
  where id = m.id;

  perform private.notify('match:' || m.id::text, 'match_final',
    jsonb_build_object('match_id', m.id, 'status', 'finished', 'winner_id', p_winner, 'reason', p_reason,
                       'host_score', p_host_score, 'guest_score', p_guest_score,
                       'host_delta', dh, 'guest_delta', dg));
  if m.room_id is not null then perform private.release_room(m.room_id); end if;
end;
$$;
revoke all on function private.finish_match(uuid, uuid, text, integer, integer, integer) from public, anon, authenticated;

-- Ends a match with no winner (reports disagree, or both players vanished). No stats change.
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

-- Removes stale state. Cheap (indexed) and run by the main entry points.
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
  -- both players gone for 3 minutes: nobody wins
  for mid in
    select id from public.online_matches
    where status = 'active'
      and host_seen_at < now() - interval '3 minutes'
      and guest_seen_at < now() - interval '3 minutes'
    limit 20
  loop
    perform private.void_match(mid, 'abandoned', 'abandoned');
  end loop;
  -- lobbies nobody touched for 2 hours
  delete from public.rooms where status = 'lobby' and updated_at < now() - interval '2 hours';
end;
$$;
revoke all on function private.cleanup() from public, anon, authenticated;

-- Takes a player out of their room (forfeiting an active match).
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
  other_id uuid;
begin
  delete from public.matchmaking_queue where user_id = p_user;
  select * into rp from public.room_players where user_id = p_user;
  if not found then return; end if;
  select * into r from public.rooms where id = rp.room_id for update;

  if r.status = 'playing' and r.match_id is not null then
    select * into m from public.online_matches where id = r.match_id;
    if found and m.status = 'active' then
      other_id := case when m.host_id = p_user then m.guest_id else m.host_id end;
      perform private.finish_match(m.id, other_id, 'left', null, null, null);
    end if;
    -- finish_match may have closed a quick room
    if not exists (select 1 from public.rooms where id = r.id) then return; end if;
  end if;

  delete from public.room_players where room_id = r.id and user_id = p_user;
  delete from public.room_invites where room_id = r.id and from_id = p_user;

  if not exists (select 1 from public.room_players where room_id = r.id) then
    delete from public.rooms where id = r.id;
    return;
  end if;
  if r.kind = 'quick' then -- the other player of a quick match is released too
    perform private.notify('room:' || r.id::text, 'room_closed', jsonb_build_object('room_id', r.id));
    delete from public.rooms where id = r.id;
    return;
  end if;
  if rp.seat = 0 then -- the remaining player becomes the host
    update public.room_players set seat = 0 where room_id = r.id;
    update public.rooms set host_id = (select user_id from public.room_players where room_id = r.id)
      where id = r.id;
  end if;
  update public.room_players set ready = false where room_id = r.id;
  update public.rooms set updated_at = now() where id = r.id;
  perform private.room_changed(r.id);
end;
$$;
revoke all on function private.leave_current(uuid) from public, anon, authenticated;

create or replace function private.new_room(p_kind text, p_host uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
begin
  for i in 1 .. 12 loop
    begin
      insert into public.rooms (code, kind, host_id)
      values (private.random_code(6), p_kind, p_host)
      returning id into rid;
      return rid;
    exception when unique_violation then
      null; -- code taken: try another
    end;
  end loop;
  raise exception 'could_not_create_room' using errcode = 'P0001';
end;
$$;
revoke all on function private.new_room(text, uuid) from public, anon, authenticated;

create or replace function private.begin_match(p_room uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rooms;
  h uuid; g uuid;
  mid uuid;
begin
  select * into r from public.rooms where id = p_room for update;
  select user_id into h from public.room_players where room_id = p_room and seat = 0;
  select user_id into g from public.room_players where room_id = p_room and seat = 1;
  if h is null or g is null then raise exception 'need_two_players' using errcode = 'P0001'; end if;
  insert into public.online_matches (room_id, kind, host_id, guest_id, host_name, guest_name)
  values (p_room, r.kind, h, g, private.name_of(h), private.name_of(g))
  returning id into mid;
  update public.rooms set status = 'playing', match_id = mid, updated_at = now() where id = p_room;
  update public.room_players set ready = true where room_id = p_room;
  perform private.room_changed(p_room, 'match_start');
  return mid;
end;
$$;
revoke all on function private.begin_match(uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 5. Player-facing functions (private = logic, public = API wrapper)
-- -----------------------------------------------------------------------------

-- ---- rooms ------------------------------------------------------------------
create or replace function private.get_room_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
begin
  select room_id into rid from public.room_players where user_id = private.me();
  if rid is null then return null; end if;
  return private.room_state(rid);
end;
$$;

create or replace function private.create_room()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  rid uuid;
begin
  perform private.cleanup();
  perform private.leave_current(uid);
  rid := private.new_room('private', uid);
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
  free_seat smallint;
begin
  if v_code !~ '^[A-HJ-NP-Z2-9]{6}$' then raise exception 'room_not_found' using errcode = 'P0001'; end if;
  perform private.cleanup();
  select * into r from public.rooms where rooms.code = v_code for update;
  if not found or r.kind <> 'private' then raise exception 'room_not_found' using errcode = 'P0001'; end if;
  if exists (select 1 from public.room_players where room_id = r.id and user_id = uid) then
    return private.room_state(r.id); -- already in it
  end if;
  if r.status <> 'lobby' then raise exception 'room_in_game' using errcode = 'P0001'; end if;
  if (select count(*) from public.room_players where room_id = r.id) >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  perform private.leave_current(uid);
  -- the room may have changed while leaving the old one
  if not exists (select 1 from public.rooms where id = r.id) then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;
  select s into free_seat from unnest(array[0, 1]::smallint[]) s
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

create or replace function private.leave_room()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.leave_current(private.me());
end;
$$;

create or replace function private.set_ready(p_ready boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  rid uuid;
begin
  select rp.room_id into rid from public.room_players rp
    join public.rooms r on r.id = rp.room_id
    where rp.user_id = uid and r.status = 'lobby'
    for update of r;
  if rid is null then raise exception 'not_in_lobby' using errcode = 'P0001'; end if;
  update public.room_players set ready = coalesce(p_ready, false) where room_id = rid and user_id = uid;
  update public.rooms set updated_at = now() where id = rid;
  perform private.room_changed(rid);
  return private.room_state(rid);
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
begin
  select r2.* into r from public.rooms r2
    join public.room_players rp on rp.room_id = r2.id
    where rp.user_id = uid
    for update of r2;
  if not found then raise exception 'not_in_room' using errcode = 'P0001'; end if;
  if r.host_id <> uid then raise exception 'only_host_can_start' using errcode = 'P0001'; end if;
  if r.status <> 'lobby' then raise exception 'room_in_game' using errcode = 'P0001'; end if;
  if (select count(*) from public.room_players where room_id = r.id) < 2 then
    raise exception 'need_two_players' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.room_players where room_id = r.id and user_id <> uid and not ready) then
    raise exception 'opponent_not_ready' using errcode = 'P0001';
  end if;
  perform private.begin_match(r.id);
  return private.room_state(r.id);
end;
$$;

-- ---- Quick Match -------------------------------------------------------------
-- Called repeatedly (every few seconds) while searching; each call is also the
-- heartbeat that keeps the player in the queue.
create or replace function private.quick_match()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  cur public.rooms;
  my_rating integer;
  opp uuid;
  rid uuid;
begin
  -- one matchmaker at a time: no two calls can pair the same player
  perform pg_advisory_xact_lock(hashtext('pickleball_hyper.matchmaking'));
  perform private.cleanup();

  select r.* into cur from public.rooms r join public.room_players rp on rp.room_id = r.id where rp.user_id = uid;
  if found then
    if cur.kind = 'quick' then
      delete from public.matchmaking_queue where user_id = uid;
      return jsonb_build_object('status', 'matched', 'room', private.room_state(cur.id));
    end if;
    perform private.leave_current(uid); -- leaving a private lobby to search
  end if;

  my_rating := private.rating_of(uid);
  select q.user_id into opp from public.matchmaking_queue q
    where q.user_id <> uid
      and q.last_seen > now() - interval '15 seconds'
      and not exists (select 1 from public.room_players rp where rp.user_id = q.user_id)
    order by abs(q.rating - my_rating), q.enqueued_at
    limit 1;

  if opp is null then
    insert into public.matchmaking_queue (user_id, rating) values (uid, my_rating)
    on conflict (user_id) do update set last_seen = now(), rating = excluded.rating;
    return jsonb_build_object('status', 'searching',
      'waiting', (select count(*) from public.matchmaking_queue where user_id <> uid));
  end if;

  delete from public.matchmaking_queue where user_id in (uid, opp);
  rid := private.new_room('quick', opp); -- the player who waited hosts
  insert into public.room_players (room_id, user_id, seat, ready) values (rid, opp, 0, true), (rid, uid, 1, true);
  perform private.begin_match(rid);
  perform private.notify('user:' || opp::text, 'match_found', jsonb_build_object('room_id', rid));
  return jsonb_build_object('status', 'matched', 'room', private.room_state(rid));
end;
$$;

create or replace function private.cancel_quick_match()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
begin
  perform pg_advisory_xact_lock(hashtext('pickleball_hyper.matchmaking'));
  delete from public.matchmaking_queue where user_id = uid;
  return private.get_room_state(); -- non-null if a match was found just before cancelling
end;
$$;

-- ---- match lifecycle ----------------------------------------------------------
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
  update public.online_matches set
    host_seen_at  = case when host_id = uid then now() else host_seen_at end,
    guest_seen_at = case when guest_id = uid then now() else guest_seen_at end
  where id = p_match and status = 'active' and uid in (host_id, guest_id)
  returning * into m;
  if not found then
    select * into m from public.online_matches where id = p_match and uid in (host_id, guest_id);
    if not found then raise exception 'match_not_found' using errcode = 'P0001'; end if;
  end if;
  return jsonb_build_object(
    'status', m.status, 'reason', m.end_reason, 'winner_id', m.winner_id,
    'opponent_seen_ago', extract(epoch from now() - case when m.host_id = uid then m.guest_seen_at else m.host_seen_at end)
  );
end;
$$;

-- The opponent has been gone for 30+ seconds (the server's own heartbeat clock):
-- the caller wins by forfeit.
create or replace function private.claim_forfeit(p_match uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  m public.online_matches;
  opp_seen timestamptz;
begin
  select * into m from public.online_matches where id = p_match and uid in (host_id, guest_id) for update;
  if not found then raise exception 'match_not_found' using errcode = 'P0001'; end if;
  if m.status <> 'active' then
    return jsonb_build_object('status', m.status, 'winner_id', m.winner_id, 'reason', m.end_reason);
  end if;
  opp_seen := case when m.host_id = uid then m.guest_seen_at else m.host_seen_at end;
  if opp_seen > now() - interval '30 seconds' then
    raise exception 'opponent_still_connected' using errcode = 'P0001';
  end if;
  update public.online_matches set
    host_seen_at  = case when host_id = uid then now() else host_seen_at end,
    guest_seen_at = case when guest_id = uid then now() else guest_seen_at end
  where id = m.id;
  perform private.finish_match(m.id, uid, 'forfeit', null, null, null);
  return jsonb_build_object('status', 'finished', 'winner_id', uid, 'reason', 'forfeit');
end;
$$;

-- ---- friends -------------------------------------------------------------------
create or replace function private.send_friend_request(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  target uuid;
  a uuid; b uuid;
  f public.friendships;
begin
  select id into target from public.profiles where friend_code = upper(btrim(coalesce(p_code, '')));
  if target is null then raise exception 'friend_not_found' using errcode = 'P0001'; end if;
  if target = uid then raise exception 'cannot_add_self' using errcode = 'P0001'; end if;
  a := least(uid, target); b := greatest(uid, target);
  select * into f from public.friendships where user_a = a and user_b = b for update;
  if found then
    if f.status = 'accepted' then raise exception 'already_friends' using errcode = 'P0001'; end if;
    if f.requested_by <> uid then -- they asked first: this accepts
      update public.friendships set status = 'accepted', updated_at = now() where user_a = a and user_b = b;
      perform private.notify('user:' || target::text, 'friends_changed', '{}'::jsonb);
      return jsonb_build_object('status', 'accepted', 'name', private.name_of(target));
    end if;
    return jsonb_build_object('status', 'pending', 'name', private.name_of(target));
  end if;
  if (select count(*) from public.friendships where uid in (user_a, user_b)) >= 200 then
    raise exception 'too_many_friends' using errcode = 'P0001';
  end if;
  insert into public.friendships (user_a, user_b, requested_by) values (a, b, uid);
  perform private.notify('user:' || target::text, 'friends_changed', '{}'::jsonb);
  return jsonb_build_object('status', 'pending', 'name', private.name_of(target));
end;
$$;

create or replace function private.respond_friend_request(p_user uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  a uuid := least(uid, p_user);
  b uuid := greatest(uid, p_user);
begin
  if p_accept then
    update public.friendships set status = 'accepted', updated_at = now()
      where user_a = a and user_b = b and status = 'pending' and requested_by = p_user;
    if not found then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  else
    delete from public.friendships where user_a = a and user_b = b and status = 'pending';
  end if;
  perform private.notify('user:' || p_user::text, 'friends_changed', '{}'::jsonb);
end;
$$;

create or replace function private.remove_friend(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
begin
  delete from public.friendships where user_a = least(uid, p_user) and user_b = greatest(uid, p_user);
  perform private.notify('user:' || p_user::text, 'friends_changed', '{}'::jsonb);
end;
$$;

create or replace function private.list_friends()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', o.id,
      'name', coalesce(p.name, 'Player'),
      'avatar', coalesce(p.avatar, '{}'::jsonb),
      'paddle', coalesce(p.paddle, 'tidal-wave'),
      'rating', coalesce(ps.rating, 1000),
      'status', f.status,
      'incoming', f.status = 'pending' and f.requested_by <> (select auth.uid())
    ) order by f.status, coalesce(p.name, 'Player')), '[]'::jsonb)
  from public.friendships f
  cross join lateral (select case when f.user_a = (select auth.uid()) then f.user_b else f.user_a end as id) o
  left join public.profiles p on p.id = o.id
  left join public.player_stats ps on ps.user_id = o.id
  where (select auth.uid()) in (f.user_a, f.user_b);
$$;

-- ---- invites ---------------------------------------------------------------------
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
  if (select count(*) from public.room_players where room_id = r.id) >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.friendships
                 where user_a = least(uid, p_user) and user_b = greatest(uid, p_user) and status = 'accepted') then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  insert into public.room_invites (room_id, from_id, to_id) values (r.id, uid, p_user)
  on conflict (room_id, to_id) do update set created_at = now(), from_id = excluded.from_id;
  perform private.notify('user:' || p_user::text, 'room_invite',
    jsonb_build_object('code', r.code, 'from_name', private.name_of(uid)));
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
      'id', i.id, 'code', r.code, 'from_id', i.from_id,
      'from_name', coalesce(p.name, 'Player'), 'created_at', i.created_at
    ) order by i.created_at desc), '[]'::jsonb)
  from public.room_invites i
  join public.rooms r on r.id = i.room_id
  left join public.profiles p on p.id = i.from_id
  where i.to_id = (select auth.uid())
    and i.created_at > now() - interval '15 minutes'
    and r.status = 'lobby'
    and (select count(*) from public.room_players rp where rp.room_id = r.id) < 2;
$$;

create or replace function private.respond_invite(p_invite bigint, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  v_code text;
begin
  select r.code into v_code from public.room_invites i join public.rooms r on r.id = i.room_id
    where i.id = p_invite and i.to_id = uid;
  delete from public.room_invites where id = p_invite and to_id = uid;
  if v_code is null then raise exception 'invite_expired' using errcode = 'P0001'; end if;
  if not p_accept then return null; end if;
  return private.join_room(v_code);
end;
$$;

-- ---- profiles, stats, history, leaderboard ------------------------------------------
create or replace function private.get_my_online_profile()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', u.id,
    'name', coalesce(p.name, 'Player'),
    'friend_code', p.friend_code,
    'rating', coalesce(s.rating, 1000),
    'played', coalesce(s.played, 0), 'wins', coalesce(s.wins, 0), 'losses', coalesce(s.losses, 0),
    'streak', coalesce(s.streak, 0), 'best_streak', coalesce(s.best_streak, 0),
    'forfeits', coalesce(s.forfeits, 0), 'longest_rally', coalesce(s.longest_rally, 0)
  )
  from (select (select auth.uid()) as id) u
  left join public.profiles p on p.id = u.id
  left join public.player_stats s on s.user_id = u.id
  where u.id is not null;
$$;

create or replace function private.get_public_profiles(p_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', p.id, 'name', p.name, 'avatar', p.avatar, 'paddle', p.paddle,
      'rating', coalesce(s.rating, 1000))), '[]'::jsonb)
  from public.profiles p
  left join public.player_stats s on s.user_id = p.id
  where (select auth.uid()) is not null
    and p.id = any (p_ids[1:50]);
$$;

create or replace function private.get_online_history(p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(h) order by h.started_at desc), '[]'::jsonb)
  from (
    select m.id, m.kind, m.status, m.end_reason, m.started_at, m.ended_at, m.longest_rally,
      case when m.host_id = me.id then m.guest_name else m.host_name end as opponent,
      case when m.host_id = me.id then m.host_score else m.guest_score end as my_score,
      case when m.host_id = me.id then m.guest_score else m.host_score end as opp_score,
      case when m.winner_id is null then null else m.winner_id = me.id end as won,
      case when m.host_id = me.id then m.host_rating_delta else m.guest_rating_delta end as rating_delta
    from public.online_matches m
    cross join (select (select auth.uid()) as id) me
    where me.id in (m.host_id, m.guest_id) and m.status <> 'active'
    order by m.started_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) h;
$$;

create or replace function private.get_online_leaderboard(p_max integer)
returns table (rank bigint, name text, rating integer, wins integer, losses integer, played integer,
               best_streak integer, is_me boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    rank() over (order by s.rating desc, s.wins desc) as rank,
    coalesce(p.name, 'Player') as name,
    s.rating, s.wins, s.losses, s.played, s.best_streak,
    s.user_id = (select auth.uid()) as is_me
  from public.player_stats s
  left join public.profiles p on p.id = s.user_id
  where (select auth.uid()) is not null and s.played > 0
  order by s.rating desc, s.wins desc
  limit least(greatest(coalesce(p_max, 20), 1), 100);
$$;


-- -----------------------------------------------------------------------------
-- 6. Server-only: result reports (called by the submit-result Edge Function
--    with the service role after it has checked the point log).
-- -----------------------------------------------------------------------------
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
  other_id uuid;
  mine public.match_reports;
  theirs public.match_reports;
  valid boolean := p_valid;
  reason text := p_reason;
  winner uuid;
begin
  select * into m from public.online_matches where id = p_match for update;
  if not found or p_user is null or p_user not in (m.host_id, m.guest_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_a_player');
  end if;
  if m.status <> 'active' then
    return jsonb_build_object('status', m.status, 'winner_id', m.winner_id, 'reason', m.end_reason,
                              'host_score', m.host_score, 'guest_score', m.guest_score);
  end if;
  -- the match can't have lasted longer than the server says it has been running
  if valid and p_last_point_ms > extract(epoch from now() - m.started_at) * 1000 + 15000 then
    valid := false; reason := 'too_long_for_server_clock';
  end if;

  insert into public.match_reports (match_id, user_id, host_score, guest_score, longest_rally, winners, valid, invalid_reason)
  values (p_match, p_user, p_host_score, p_guest_score, least(greatest(p_longest, 0), 999), p_winners, valid, reason)
  on conflict (match_id, user_id) do nothing; -- the first report counts; it can't be changed

  other_id := case when p_user = m.host_id then m.guest_id else m.host_id end;
  select * into mine from public.match_reports where match_id = p_match and user_id = p_user;
  select * into theirs from public.match_reports where match_id = p_match and user_id = other_id;
  if theirs.match_id is null then
    return jsonb_build_object('status', 'waiting_for_opponent');
  end if;

  if mine.valid and theirs.valid
     and mine.winners = theirs.winners
     and mine.host_score = theirs.host_score and mine.guest_score = theirs.guest_score then
    winner := case when mine.host_score > mine.guest_score then m.host_id else m.guest_id end;
    perform private.finish_match(p_match, winner, 'score', mine.host_score, mine.guest_score,
                                 greatest(mine.longest_rally, theirs.longest_rally));
    select * into m from public.online_matches where id = p_match;
    return jsonb_build_object('status', 'finished', 'winner_id', m.winner_id, 'reason', 'score',
      'host_score', m.host_score, 'guest_score', m.guest_score,
      'host_delta', m.host_rating_delta, 'guest_delta', m.guest_rating_delta);
  end if;

  perform private.void_match(p_match, 'disputed', 'dispute');
  return jsonb_build_object('status', 'disputed', 'reason', 'dispute');
end;
$$;
revoke all on function public.svc_submit_report(uuid, uuid, integer, integer, integer, text, boolean, text, integer)
  from public, anon, authenticated;
grant execute on function public.svc_submit_report(uuid, uuid, integer, integer, integer, text, boolean, text, integer)
  to service_role;

-- One player reported a valid result and the other never did (60 s): if the silent
-- player is gone (no heartbeat for 30 s) the reporter's result stands only as a
-- forfeit; if they are still connected the match is disputed.
create or replace function private.resolve_missing_report(p_match uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.me();
  m public.online_matches;
  mine public.match_reports;
  opp_seen timestamptz;
begin
  select * into m from public.online_matches where id = p_match and uid in (host_id, guest_id) for update;
  if not found then raise exception 'match_not_found' using errcode = 'P0001'; end if;
  if m.status <> 'active' then
    return jsonb_build_object('status', m.status, 'winner_id', m.winner_id, 'reason', m.end_reason);
  end if;
  select * into mine from public.match_reports where match_id = p_match and user_id = uid;
  if mine.match_id is null or mine.submitted_at > now() - interval '60 seconds' then
    raise exception 'too_early' using errcode = 'P0001';
  end if;
  opp_seen := case when m.host_id = uid then m.guest_seen_at else m.host_seen_at end;
  if mine.valid and opp_seen < now() - interval '30 seconds' then
    perform private.finish_match(p_match, uid, 'forfeit', null, null, null);
    return jsonb_build_object('status', 'finished', 'winner_id', uid, 'reason', 'forfeit');
  end if;
  perform private.void_match(p_match, 'disputed', 'dispute');
  return jsonb_build_object('status', 'disputed', 'reason', 'dispute');
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. Grants for the private logic + public API wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'private.get_room_state()', 'private.create_room()', 'private.join_room(text)', 'private.leave_room()',
    'private.set_ready(boolean)', 'private.start_match()', 'private.quick_match()',
    'private.cancel_quick_match()', 'private.match_heartbeat(uuid)', 'private.claim_forfeit(uuid)',
    'private.resolve_missing_report(uuid)',
    'private.send_friend_request(text)', 'private.respond_friend_request(uuid, boolean)',
    'private.remove_friend(uuid)', 'private.list_friends()', 'private.invite_friend(uuid)',
    'private.list_invites()', 'private.respond_invite(bigint, boolean)',
    'private.get_my_online_profile()', 'private.get_public_profiles(uuid[])',
    'private.get_online_history(integer)', 'private.get_online_leaderboard(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

create or replace function public.get_room_state() returns jsonb
  language sql security invoker set search_path = '' as $$ select private.get_room_state(); $$;
create or replace function public.create_room() returns jsonb
  language sql security invoker set search_path = '' as $$ select private.create_room(); $$;
create or replace function public.join_room(p_code text) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.join_room(p_code); $$;
create or replace function public.leave_room() returns void
  language sql security invoker set search_path = '' as $$ select private.leave_room(); $$;
create or replace function public.set_ready(p_ready boolean) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.set_ready(p_ready); $$;
create or replace function public.start_match() returns jsonb
  language sql security invoker set search_path = '' as $$ select private.start_match(); $$;
create or replace function public.quick_match() returns jsonb
  language sql security invoker set search_path = '' as $$ select private.quick_match(); $$;
create or replace function public.cancel_quick_match() returns jsonb
  language sql security invoker set search_path = '' as $$ select private.cancel_quick_match(); $$;
create or replace function public.match_heartbeat(p_match uuid) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.match_heartbeat(p_match); $$;
create or replace function public.claim_forfeit(p_match uuid) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.claim_forfeit(p_match); $$;
create or replace function public.resolve_missing_report(p_match uuid) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.resolve_missing_report(p_match); $$;
create or replace function public.send_friend_request(p_code text) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.send_friend_request(p_code); $$;
create or replace function public.respond_friend_request(p_user uuid, p_accept boolean) returns void
  language sql security invoker set search_path = '' as $$ select private.respond_friend_request(p_user, p_accept); $$;
create or replace function public.remove_friend(p_user uuid) returns void
  language sql security invoker set search_path = '' as $$ select private.remove_friend(p_user); $$;
create or replace function public.list_friends() returns jsonb
  language sql stable security invoker set search_path = '' as $$ select private.list_friends(); $$;
create or replace function public.invite_friend(p_user uuid) returns void
  language sql security invoker set search_path = '' as $$ select private.invite_friend(p_user); $$;
create or replace function public.list_invites() returns jsonb
  language sql stable security invoker set search_path = '' as $$ select private.list_invites(); $$;
create or replace function public.respond_invite(p_invite bigint, p_accept boolean) returns jsonb
  language sql security invoker set search_path = '' as $$ select private.respond_invite(p_invite, p_accept); $$;
create or replace function public.get_my_online_profile() returns jsonb
  language sql stable security invoker set search_path = '' as $$ select private.get_my_online_profile(); $$;
create or replace function public.get_public_profiles(p_ids uuid[]) returns jsonb
  language sql stable security invoker set search_path = '' as $$ select private.get_public_profiles(p_ids); $$;
create or replace function public.get_online_history(p_limit integer default 30) returns jsonb
  language sql stable security invoker set search_path = '' as $$ select private.get_online_history(p_limit); $$;
create or replace function public.get_online_leaderboard(max_rows integer default 20)
  returns table (rank bigint, name text, rating integer, wins integer, losses integer, played integer,
                 best_streak integer, is_me boolean)
  language sql stable security invoker set search_path = '' as $$ select * from private.get_online_leaderboard(max_rows); $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_room_state()', 'public.create_room()', 'public.join_room(text)', 'public.leave_room()',
    'public.set_ready(boolean)', 'public.start_match()', 'public.quick_match()',
    'public.cancel_quick_match()', 'public.match_heartbeat(uuid)', 'public.claim_forfeit(uuid)',
    'public.resolve_missing_report(uuid)',
    'public.send_friend_request(text)', 'public.respond_friend_request(uuid, boolean)',
    'public.remove_friend(uuid)', 'public.list_friends()', 'public.invite_friend(uuid)',
    'public.list_invites()', 'public.respond_invite(bigint, boolean)',
    'public.get_my_online_profile()', 'public.get_public_profiles(uuid[])',
    'public.get_online_history(integer)', 'public.get_online_leaderboard(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- -----------------------------------------------------------------------------
-- 8. Realtime authorization (private channels)
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
begin
  if uid is null or p_topic is null then return false; end if;
  if p_topic = 'lobby' then
    return not p_write or p_extension = 'presence'; -- presence only: no broadcasting to everyone
  end if;
  if p_topic = 'user:' || uid::text then
    return not p_write; -- notices come from the server only
  end if;
  if p_topic ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    target := substr(p_topic, 6)::uuid;
    return exists (select 1 from public.room_players where room_id = target and user_id = uid);
  end if;
  if p_topic ~ '^match:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    target := substr(p_topic, 7)::uuid;
    return exists (select 1 from public.online_matches
                   where id = target and status = 'active' and uid in (host_id, guest_id));
  end if;
  return false;
end;
$$;
revoke all on function private.can_use_topic(text, text, boolean) from public, anon;
grant execute on function private.can_use_topic(text, text, boolean) to authenticated;

drop policy if exists "pickleball: receive on allowed topics" on realtime.messages;
create policy "pickleball: receive on allowed topics" on realtime.messages
  for select to authenticated
  using ((select private.can_use_topic((select realtime.topic()), extension, false)));

drop policy if exists "pickleball: send on allowed topics" on realtime.messages;
create policy "pickleball: send on allowed topics" on realtime.messages
  for insert to authenticated
  with check ((select private.can_use_topic((select realtime.topic()), extension, true)));
