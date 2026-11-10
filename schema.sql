-- Group Safety prototype v0.2: database set-up
-- Run once in Supabase: SQL Editor > New query > paste all of this > Run.
--
-- Design:
-- * Tables are locked (row level security on, no policies, no table grants),
--   so the public key cannot read or write them directly.
-- * The web page only calls the functions below. Each one checks the
--   member's secret before reading or changing anything.
-- * Only each person's latest position is kept, and anything not updated
--   for 24 hours is deleted automatically.

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 30),
  secret uuid not null default gen_random_uuid(),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  accuracy_m real,
  battery_pct smallint check (battery_pct between 0 and 100),
  last_seen_at timestamptz,
  trip_status text not null default 'none' check (trip_status in ('none', 'active', 'home')),
  trip_destination text check (char_length(trip_destination) <= 60),
  trip_eta timestamptz,
  trip_started_at timestamptz,
  sharing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists members_group_idx on public.members (group_id);
alter table public.members add column if not exists sharing boolean not null default false;

alter table public.groups enable row level security;
alter table public.members enable row level security;
revoke all on table public.groups from anon, authenticated;
revoke all on table public.members from anon, authenticated;

-- Internal: delete anything not updated for 24 hours.
create or replace function public._cleanup()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.members where updated_at < now() - interval '24 hours';
  delete from public.groups g
   where g.updated_at < now() - interval '24 hours'
     and not exists (select 1 from public.members m where m.group_id = g.id);
$$;
revoke all on function public._cleanup() from public, anon, authenticated;

-- Create a group and join it as its first member.
create or replace function public.create_group(p_group_name text, p_display_name text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_group public.groups;
  v_member public.members;
begin
  perform public._cleanup();
  if p_group_name is null or char_length(trim(p_group_name)) not between 1 and 40 then
    raise exception 'invalid_group_name';
  end if;
  if p_display_name is null or char_length(trim(p_display_name)) not between 1 and 30 then
    raise exception 'invalid_name';
  end if;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.groups where code = v_code);
  end loop;
  insert into public.groups (code, name) values (v_code, trim(p_group_name)) returning * into v_group;
  insert into public.members (group_id, display_name) values (v_group.id, trim(p_display_name)) returning * into v_member;
  return json_build_object('code', v_group.code, 'group_name', v_group.name,
                           'member_id', v_member.id, 'secret', v_member.secret);
end;
$$;

-- Join an existing group with its code.
create or replace function public.join_group(p_code text, p_display_name text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.groups;
  v_member public.members;
begin
  perform public._cleanup();
  if p_display_name is null or char_length(trim(p_display_name)) not between 1 and 30 then
    raise exception 'invalid_name';
  end if;
  select * into v_group from public.groups where code = upper(trim(coalesce(p_code, '')));
  if not found then
    raise exception 'group_not_found';
  end if;
  if (select count(*) from public.members where group_id = v_group.id) >= 20 then
    raise exception 'group_full';
  end if;
  insert into public.members (group_id, display_name) values (v_group.id, trim(p_display_name)) returning * into v_member;
  update public.groups set updated_at = now() where id = v_group.id;
  return json_build_object('code', v_group.code, 'group_name', v_group.name,
                           'member_id', v_member.id, 'secret', v_member.secret);
end;
$$;

-- Save the caller's latest position.
create or replace function public.update_location(
  p_member uuid, p_secret uuid,
  p_lat double precision, p_lng double precision,
  p_accuracy real default null, p_battery smallint default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group uuid;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid_position';
  end if;
  update public.members
     set lat = p_lat, lng = p_lng, accuracy_m = p_accuracy,
         battery_pct = case when p_battery between 0 and 100 then p_battery else null end,
         last_seen_at = now(), sharing = true, updated_at = now()
   where id = p_member and secret = p_secret
   returning group_id into v_group;
  if v_group is null then
    raise exception 'not_member';
  end if;
  update public.groups set updated_at = now() where id = v_group;
end;
$$;

-- Start (or extend) a trip with a destination and expected arrival time.
create or replace function public.start_trip(p_member uuid, p_secret uuid, p_destination text, p_eta timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_eta is null or p_eta < now() - interval '5 minutes' or p_eta > now() + interval '24 hours' then
    raise exception 'invalid_eta';
  end if;
  if p_destination is not null and char_length(trim(p_destination)) > 60 then
    raise exception 'invalid_destination';
  end if;
  update public.members
     set trip_status = 'active',
         trip_destination = nullif(trim(coalesce(p_destination, '')), ''),
         trip_eta = p_eta,
         trip_started_at = case when trip_status = 'active' then trip_started_at else now() end,
         updated_at = now()
   where id = p_member and secret = p_secret;
  if not found then
    raise exception 'not_member';
  end if;
end;
$$;

-- Mark the caller as home safe.
create or replace function public.end_trip(p_member uuid, p_secret uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.members
     set trip_status = 'home', sharing = false, lat = null, lng = null, accuracy_m = null, updated_at = now()
   where id = p_member and secret = p_secret;
  if not found then
    raise exception 'not_member';
  end if;
end;
$$;

-- Turn the caller's location sharing on or off (shown to the group).
create or replace function public.set_sharing(p_member uuid, p_secret uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.members
     set sharing = coalesce(p_on, false),
         -- switching off on purpose deletes the stored position
         lat = case when coalesce(p_on, false) then lat end,
         lng = case when coalesce(p_on, false) then lng end,
         accuracy_m = case when coalesce(p_on, false) then accuracy_m end,
         updated_at = now()
   where id = p_member and secret = p_secret;
  if not found then
    raise exception 'not_member';
  end if;
end;
$$;

-- Leave the group and delete the caller's data.
create or replace function public.leave_group(p_member uuid, p_secret uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.members where id = p_member and secret = p_secret;
end;
$$;

-- Everything a member needs to draw the group map. Only members can call it.
create or replace function public.get_group(p_member uuid, p_secret uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.members;
  v_group public.groups;
begin
  perform public._cleanup();
  select * into v_me from public.members where id = p_member and secret = p_secret;
  if not found then
    raise exception 'not_member';
  end if;
  select * into v_group from public.groups where id = v_me.group_id;
  return json_build_object(
    'group', json_build_object('name', v_group.name, 'code', v_group.code),
    'server_time', now(),
    'members', coalesce((
      select json_agg(json_build_object(
               'id', m.id,
               'name', m.display_name,
               'is_me', m.id = v_me.id,
               'lat', m.lat,
               'lng', m.lng,
               'accuracy_m', m.accuracy_m,
               'battery_pct', m.battery_pct,
               'last_seen_at', m.last_seen_at,
               'trip_status', m.trip_status,
               'trip_destination', m.trip_destination,
               'trip_eta', m.trip_eta,
               'trip_started_at', m.trip_started_at,
               'sharing', m.sharing)
             order by m.created_at)
        from public.members m
       where m.group_id = v_me.group_id), '[]'::json));
end;
$$;

-- Only the public (anon) role calls these; there are no signed-in users.
revoke execute on function public.create_group(text, text) from public, authenticated;
revoke execute on function public.join_group(text, text) from public, authenticated;
revoke execute on function public.update_location(uuid, uuid, double precision, double precision, real, smallint) from public, authenticated;
revoke execute on function public.start_trip(uuid, uuid, text, timestamptz) from public, authenticated;
revoke execute on function public.end_trip(uuid, uuid) from public, authenticated;
revoke execute on function public.leave_group(uuid, uuid) from public, authenticated;
revoke execute on function public.set_sharing(uuid, uuid, boolean) from public, authenticated;
revoke execute on function public.get_group(uuid, uuid) from public, authenticated;
grant execute on function public.create_group(text, text) to anon;
grant execute on function public.join_group(text, text) to anon;
grant execute on function public.update_location(uuid, uuid, double precision, double precision, real, smallint) to anon;
grant execute on function public.start_trip(uuid, uuid, text, timestamptz) to anon;
grant execute on function public.end_trip(uuid, uuid) to anon;
grant execute on function public.leave_group(uuid, uuid) to anon;
grant execute on function public.set_sharing(uuid, uuid, boolean) to anon;
grant execute on function public.get_group(uuid, uuid) to anon;
