-- Pickleball Hyper: fixes for online doubles (found by the live two- and four-player tests)
--  1. Realtime needs READ access to join a channel, even one a player only sends on:
--     each player may now also read their own input channel (match:<id>:<their id>).
--     Still only that player can SEND on it, and still only the host reads other
--     players' inputs.
--  2. svc_submit_report: the local variable "valid" clashed with the match_reports
--     column of the same name ("column reference is ambiguous") once two reports were
--     compared. Renamed to v_valid / v_reason.

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
    -- one player's input channel: only that player sends; that player and the host may join
    target := substr(p_topic, 7, 36)::uuid;
    sender := substr(p_topic, 44, 36)::uuid;
    if not exists (select 1 from public.online_matches m
                   join public.online_match_players mp on mp.match_id = m.id
                   where m.id = target and m.status = 'active' and mp.user_id = sender) then
      return false;
    end if;
    if p_write then
      return sender = uid;
    end if;
    return sender = uid
        or exists (select 1 from public.online_match_players mp
                   where mp.match_id = target and mp.user_id = uid and mp.seat = 0);
  end if;
  return false;
end;
$$;
revoke all on function private.can_use_topic(text, text, boolean) from public, anon;
grant execute on function private.can_use_topic(text, text, boolean) to authenticated;

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
  v_valid boolean := p_valid;
  v_reason text := p_reason;
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
  if v_valid and p_last_point_ms > extract(epoch from now() - m.started_at) * 1000 + 15000 then
    v_valid := false; v_reason := 'too_long_for_server_clock';
  end if;

  insert into public.match_reports (match_id, user_id, host_score, guest_score, longest_rally, winners, valid, invalid_reason)
  values (p_match, p_user, p_host_score, p_guest_score, least(greatest(p_longest, 0), 999), p_winners, v_valid, v_reason)
  on conflict (match_id, user_id) do nothing; -- the first report counts; it can't be changed

  select * into mine from public.match_reports where match_id = p_match and user_id = p_user;
  select count(*) into n_players from public.online_match_players where match_id = p_match and user_id is not null;
  select count(*) into n_reports from public.match_reports where match_id = p_match;
  if n_reports < n_players then
    return jsonb_build_object('status', 'waiting_for_opponent', 'reports', n_reports, 'players', n_players);
  end if;

  select count(*) into n_agree from public.match_reports r
    where r.match_id = p_match and r.valid and r.winners = mine.winners
      and r.host_score = mine.host_score and r.guest_score = mine.guest_score;
  if mine.valid and n_agree = n_players then
    perform private.finish_match_team(p_match, case when mine.host_score > mine.guest_score then 0 else 1 end,
      'score', mine.host_score, mine.guest_score,
      (select max(r.longest_rally) from public.match_reports r where r.match_id = p_match));
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
