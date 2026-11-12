-- Pickleball Hyper: online multiplayer follow-up
--  1. A player who already sent a valid result for the active match can leave the
--     room without that counting as walking out (the result is settled by the reports).
--  2. Index for rooms.host_id (foreign key).

create index if not exists rooms_host_idx on public.rooms (host_id);

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
    if found and m.status = 'active'
       and not exists (select 1 from public.match_reports
                       where match_id = m.id and user_id = p_user and valid) then
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
