-- Player age, asked once right after registration.
-- Additive only: existing profiles keep their data and get age = null.
-- Age is private: covered by the existing "own profile" RLS policies and never
-- returned by get_leaderboard().
alter table public.profiles
  add column if not exists age smallint
  constraint profiles_age_range check (age is null or age between 5 and 120);
