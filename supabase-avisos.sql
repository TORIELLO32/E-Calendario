-- ══════════════════════════════════════════════════════════════
-- E-Calendario · Notificaciones
-- Pega TODO esto en Supabase → SQL Editor → Run. Se puede correr
-- varias veces sin romper nada.
-- ══════════════════════════════════════════════════════════════

-- 1) Configuración: llaves de envío y la clave de la tarea programada.
--    Las llaves las genera la función sola la primera vez.
create table if not exists public.push_config (
  id            int primary key default 1 check (id = 1),
  vapid_public  text,
  vapid_private text,
  cron_secret   text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  creado        timestamptz not null default now()
);
insert into public.push_config (id) values (1) on conflict (id) do nothing;

-- 2) Los teléfonos/computadoras donde activaste notificaciones
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id  uuid not null references auth.users (id) on delete cascade,
  p256dh   text not null,
  auth     text not null,
  tz       text not null default 'America/Mexico_City',
  equipo   text,
  creado   timestamptz not null default now(),
  visto    timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subs (user_id);

-- 3) Lo que ya se mandó, para no repetir un aviso
create table if not exists public.push_enviados (
  user_id uuid not null,
  clave   text not null,
  enviado timestamptz not null default now(),
  primary key (user_id, clave)
);

-- 4) Candado: nadie desde la app ni desde internet puede leer estas
--    tablas. Solo la función del servidor (que entra como postgres).
alter table public.push_config   enable row level security;
alter table public.push_subs     enable row level security;
alter table public.push_enviados enable row level security;
revoke all on table public.push_config, public.push_subs, public.push_enviados from anon, authenticated;

-- 5) Lo necesario para correr tareas programadas y llamar a la función
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 6) Cada minuto: revisa qué toca avisar y lo manda
do $$
begin
  if exists (select 1 from cron.job where jobname = 'avisos-calendario') then
    perform cron.unschedule('avisos-calendario');
  end if;
end $$;

select cron.schedule(
  'avisos-calendario',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://kihqoosqmephlzpiwdqw.supabase.co/functions/v1/avisos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-secret', (select cron_secret from public.push_config where id = 1)
                 ),
      body    := jsonb_build_object('accion', 'enviar'),
      timeout_milliseconds := 25000
    );
  $job$
);

-- 7) Limpieza del historial de llamadas (pg_net lo guarda un rato)
--    y confirmación de que quedó todo
select jobname, schedule, active from cron.job where jobname = 'avisos-calendario';
