-- PairPocket v1.26.0: 超安定DBベース リアルタイムオンライン＆ミニゲーム同時接続セットアップ
-- Supabase の SQL Editor にこのまま貼り付けて「Run」を押してください。

create table if not exists public.pair_live_state (
  pair_id uuid primary key references public.pairs(id) on delete cascade,
  presence jsonb not null default '{}'::jsonb,
  game_state jsonb not null default '{}'::jsonb,
  game_ver bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.pair_live_state enable row level security;

drop policy if exists "pair_live_select" on public.pair_live_state;
create policy "pair_live_select" on public.pair_live_state
  for select using (
    exists (
      select 1 from public.pair_members pm
      where pm.pair_id = pair_live_state.pair_id and pm.user_id = auth.uid()
    )
  );

create or replace function public.ping_pair_live(
  input_pair_id uuid,
  input_online boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  uid_text text := auth.uid()::text;
  rec public.pair_live_state;
begin
  if auth.uid() is null or not exists (
    select 1 from public.pair_members where pair_id = input_pair_id and user_id = auth.uid()
  ) then
    raise exception 'unauthorized';
  end if;

  insert into public.pair_live_state (pair_id, presence)
  values (input_pair_id, jsonb_build_object(uid_text, case when input_online then now_ms else 0 end))
  on conflict (pair_id) do update
  set presence = jsonb_set(coalesce(pair_live_state.presence, '{}'::jsonb), array[uid_text], to_jsonb(case when input_online then now_ms else 0 end), true),
      updated_at = now()
  returning * into rec;

  return jsonb_build_object(
    'presence', rec.presence,
    'game_state', rec.game_state,
    'game_ver', rec.game_ver,
    'server_now_ms', now_ms
  );
end;
$$;

create or replace function public.update_pair_game(
  input_pair_id uuid,
  input_patch jsonb,
  input_map_key text default null,
  input_map_val jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  uid_text text := auth.uid()::text;
  rec public.pair_live_state;
  next_state jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.pair_members where pair_id = input_pair_id and user_id = auth.uid()
  ) then
    raise exception 'unauthorized';
  end if;

  insert into public.pair_live_state (pair_id)
  values (input_pair_id)
  on conflict (pair_id) do nothing;

  select * into rec from public.pair_live_state where pair_id = input_pair_id for update;

  next_state := coalesce(rec.game_state, '{}'::jsonb) || coalesce(input_patch, '{}'::jsonb);

  if input_map_key is not null then
    next_state := jsonb_set(
      next_state,
      array[input_map_key],
      coalesce(next_state -> input_map_key, '{}'::jsonb) || jsonb_build_object(uid_text, input_map_val),
      true
    );
  end if;

  update public.pair_live_state
  set game_state = next_state,
      game_ver = coalesce(game_ver, 0) + 1,
      presence = jsonb_set(coalesce(presence, '{}'::jsonb), array[uid_text], to_jsonb(now_ms), true),
      updated_at = now()
  where pair_id = input_pair_id
  returning * into rec;

  return jsonb_build_object(
    'presence', rec.presence,
    'game_state', rec.game_state,
    'game_ver', rec.game_ver,
    'server_now_ms', now_ms
  );
end;
$$;

grant execute on function public.ping_pair_live(uuid, boolean) to authenticated;
grant execute on function public.update_pair_game(uuid, jsonb, text, jsonb) to authenticated;
