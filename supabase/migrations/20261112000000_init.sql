-- =============================================================================
-- Pickleball Hyper: player profiles, match history and leaderboard
-- =============================================================================
-- How to run: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- (or `supabase db push`, or the Supabase MCP apply_migration tool).
--
-- Safe to run more than once. It never drops tables, deletes rows or changes
-- existing columns: tables use CREATE ... IF NOT EXISTS, and only policies,
-- triggers and functions (definitions, not data) are replaced.
--
-- Security model
--   * Row Level Security is on for every table. Signed-in players can only
--     read and change their OWN profile and matches. Anonymous visitors
--     (the "anon" role) get no access at all.
--   * Finished match results can be created, read and deleted, never edited.
--   * The leaderboard is the only place other players' data appears, and it
--     returns names and totals only (no ids, no emails).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Private schema for privileged helpers.
--    Not listed in the API's exposed schemas, so nothing here can be called
--    over the REST API directly.
-- -----------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;


-- -----------------------------------------------------------------------------
-- 1. profiles: one row per account (name, look, paddle)
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null default 'Player' check (char_length(name) between 1 and 16),
  avatar      jsonb not null default '{}'::jsonb check (jsonb_typeof(avatar) = 'object'),
  paddle      text not null default 'tidal-wave' check (char_length(paddle) between 1 and 40),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Keep updated_at current; created_at can never be changed by a client.
create or replace function private.profiles_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.profiles_before_update() from public, anon, authenticated;

drop trigger if exists profiles_before_update on public.profiles;
create trigger profiles_before_update
  before update on public.profiles
  for each row execute function private.profiles_before_update();

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

-- Needed for the app's upsert (insert ... on conflict update).
drop policy if exists "profiles: create own" on public.profiles;
create policy "profiles: create own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "profiles: delete own" on public.profiles;
create policy "profiles: delete own" on public.profiles
  for delete to authenticated
  using ((select auth.uid()) = id);


-- -----------------------------------------------------------------------------
-- 2. Create a profile automatically for every new account.
--    The name comes from the sign-up metadata ("name") when given, cleaned to
--    fit the 16-character rule; otherwise 'Player'. The email is never copied.
-- -----------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_name text;
begin
  -- strip control characters and < >, collapse spaces, max 16 characters
  clean_name := left(
    btrim(regexp_replace(regexp_replace(coalesce(new.raw_user_meta_data ->> 'name', ''),
                                        '[[:cntrl:]<>]', '', 'g'),
                         '\s+', ' ', 'g')),
    16);
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(btrim(clean_name), ''), 'Player'))
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Accounts created before this migration get a profile too (existing rows untouched).
insert into public.profiles (id)
select u.id from auth.users u
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- 3. matches: one row per finished game
-- -----------------------------------------------------------------------------
create table if not exists public.matches (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode           text not null check (mode in ('singles', 'doubles')),
  difficulty     text not null check (difficulty in ('easy', 'medium', 'hard')),
  player_score   smallint not null check (player_score between 0 and 99),
  ai_score       smallint not null check (ai_score between 0 and 99),
  won            boolean not null,
  rallies_won    smallint not null default 0 check (rallies_won between 0 and 999),
  longest_rally  smallint not null default 0 check (longest_rally between 0 and 999),
  opponent       text check (char_length(opponent) <= 80),
  played_at      timestamptz not null default now(),
  -- results must follow the game's rules: first to 11, win by 2
  constraint matches_result_consistent check (won = (player_score > ai_score)),
  constraint matches_final_score check (
    greatest(player_score, ai_score) >= 11 and abs(player_score - ai_score) >= 2
  )
);

create index if not exists matches_user_played_idx on public.matches (user_id, played_at desc);

-- The owner is always the signed-in player, and a match can't be dated in the future.
-- (Matches played offline are uploaded later with their real time, so past dates are fine.)
create or replace function private.matches_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- signed-in players always own what they insert (an admin in the SQL editor keeps the given user_id)
  new.user_id := coalesce((select auth.uid()), new.user_id);
  new.played_at := least(coalesce(new.played_at, now()), now());
  return new;
end;
$$;

revoke all on function private.matches_before_insert() from public, anon, authenticated;

drop trigger if exists matches_before_insert on public.matches;
create trigger matches_before_insert
  before insert on public.matches
  for each row execute function private.matches_before_insert();

alter table public.matches enable row level security;

drop policy if exists "matches: read own" on public.matches;
create policy "matches: read own" on public.matches
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "matches: create own" on public.matches;
create policy "matches: create own" on public.matches
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "matches: delete own" on public.matches;
create policy "matches: delete own" on public.matches
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- No update policy on purpose: finished results can't be edited.


-- -----------------------------------------------------------------------------
-- 4. Table privileges: signed-in players only (RLS narrows this to own rows)
-- -----------------------------------------------------------------------------
revoke all on public.profiles from anon;
revoke all on public.matches from anon;
revoke update on public.matches from authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, delete on public.matches to authenticated;


-- -----------------------------------------------------------------------------
-- 5. Leaderboard
--    The privileged part (it has to read every player's matches) lives in the
--    private schema as SECURITY DEFINER and returns names and totals only.
--    The API calls public.get_leaderboard(), an ordinary SECURITY INVOKER
--    function that only works for signed-in players.
-- -----------------------------------------------------------------------------
create or replace function private.leaderboard(max_rows integer)
returns table (
  rank        bigint,
  name        text,
  wins        bigint,
  played      bigint,
  best_rally  integer,
  is_me       boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    rank() over (order by count(*) filter (where m.won) desc, max(m.longest_rally) desc) as rank,
    coalesce(p.name, 'Player') as name,
    count(*) filter (where m.won) as wins,
    count(*) as played,
    max(m.longest_rally)::integer as best_rally,
    m.user_id = (select auth.uid()) as is_me
  from public.matches m
  left join public.profiles p on p.id = m.user_id
  where (select auth.uid()) is not null           -- nothing for signed-out callers
  group by m.user_id, p.name
  order by wins desc, best_rally desc, played asc
  limit least(greatest(coalesce(max_rows, 20), 1), 100);
$$;

revoke all on function private.leaderboard(integer) from public, anon;
grant execute on function private.leaderboard(integer) to authenticated;

create or replace function public.get_leaderboard(max_rows integer default 20)
returns table (
  rank        bigint,
  name        text,
  wins        bigint,
  played      bigint,
  best_rally  integer,
  is_me       boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.leaderboard(max_rows);
$$;

revoke all on function public.get_leaderboard(integer) from public, anon;
grant execute on function public.get_leaderboard(integer) to authenticated;
