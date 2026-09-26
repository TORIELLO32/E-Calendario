// ══════════════════════════════════════════════════════════════
// avisos — manda las notificaciones de E-Calendario
//
// Lo llama:
//   · Supabase cada minuto (tarea programada) → accion "enviar"
//   · la app, con tu sesión → "llave", "suscribir", "baja", "probar", "estado"
//
// No necesita que configures ninguna llave: la primera vez genera
// sola su par de llaves de envío y las guarda en la tabla push_config,
// que nadie puede leer desde afuera.
// ══════════════════════════════════════════════════════════════
import webpush from 'npm:web-push@3.6.7';
import postgres from 'npm:postgres@3.4.5';

const APP_URL = 'https://toriello32.github.io/E-Calendario/';
const ORIGENES = ['https://toriello32.github.io'];
const VENTANA_MS = 15 * 60 * 1000;      // tolera que la tarea llegue tarde
const TTL_S = 6 * 60 * 60;              // si el teléfono está apagado, hasta 6 h
const MAX_SUBS_POR_USUARIO = 10;
const TZ_OMISION = 'America/Mexico_City';

const PRUEBAS = !!Deno.env.get('AVISOS_TEST');

// Solo se manda a servicios de notificaciones reales (evita que
// alguien use el servidor para pegarle a cualquier dirección).
const HOSTS_PUSH = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /\.push\.apple\.com$/,
];
if (PRUEBAS) HOSTS_PUSH.push(/^127\.0\.0\.1$/, /^localhost$/);

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    _sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
      prepare: false,
      max: Number(Deno.env.get('AVISOS_DB_MAX') || 3),
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return _sql;
}

// ───────────── Utilidades ─────────────
function cors(origen: string | null) {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origen && ORIGENES.includes(origen)) h['Access-Control-Allow-Origin'] = origen;
  return h;
}
function json(datos: unknown, status: number, origen: string | null) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: { ...cors(origen), 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function igualSeguro(a: string, b: string) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function tzValida(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+){0,2}$/.test(tz)) return TZ_OMISION;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return TZ_OMISION; }
}
function textoLimpio(s: unknown, tope: number): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, tope);
}

// ───────────── Fechas en la zona del usuario ─────────────
function desfaseMin(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const comoUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return Math.round((comoUTC - ms) / 60000);
}
// Hora local (en tz) → instante UTC en ms
export function utcDeLocal(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const base = Date.UTC(y, m - 1, d, hh, mm);
  let ms = base - desfaseMin(base, tz) * 60000;
  ms = base - desfaseMin(ms, tz) * 60000;       // segunda pasada por cambios de horario
  return ms;
}
function restarDias(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// ───────────── Mismas reglas de recordatorios que la app ─────────────
function remSeguro(r: unknown): number {
  const n = Number(r);
  return Number.isInteger(n) && n >= -1 && n <= 30 ? n : -1;
}
export function remsDe(e: any): number[] {
  let crudos: unknown[] = [];
  if (Array.isArray(e?.rems)) crudos = e.rems;
  else if (e?.rem !== undefined && remSeguro(e.rem) >= 0) crudos = remSeguro(e.rem) === 1 ? [1, 0] : [e.rem];
  const out: number[] = [];
  for (const r of crudos) {
    if (typeof r !== 'number' && !(typeof r === 'string' && /^\d{1,2}$/.test(r))) continue;
    const n = remSeguro(r);
    if (n < 0 || out.includes(n)) continue;
    out.push(n);
    if (out.length >= 4) break;
  }
  return out.sort((a, b) => b - a);
}
function diario(e: any, rems: number[]): boolean {
  const pide = Array.isArray(e?.rems) ? e.remDiario === true : remSeguro(e?.rem) >= 1;
  return pide && rems.length > 0 && rems[0] > 1;
}
export function diasDeAviso(e: any): number[] {
  const rems = remsDe(e);
  const dias = new Set(rems);
  if (diario(e, rems)) for (let d = rems[0]; d >= 0; d--) dias.add(d);
  return [...dias].sort((a, b) => b - a);
}

// ───────────── Textos ─────────────
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function hora12(h: string) {
  const [hh, mm] = h.split(':').map(Number);
  const suf = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suf}`;
}
function cuandoTexto(fecha: string, d: number, hora: string | null) {
  const h = hora ? hora12(hora) : null;
  if (d === 0) return h ? `Ahora · ${h}` : 'Hoy';
  if (d === 1) return h ? `Mañana a las ${h}` : 'Mañana';
  const [y, m, dd] = fecha.split('-').map(Number);
  const dia = DIAS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  const semanas = d % 7 === 0 ? (d === 7 ? 'En una semana' : `En ${d / 7} semanas`) : `En ${d} días`;
  return `${semanas} · ${dia} ${dd} de ${MESES[m - 1]}${h ? ` a las ${h}` : ''}`;
}

export type Aviso = { clave: string; titulo: string; cuerpo: string; url: string; tag: string };

// Qué toca mandar AHORA para un calendario. Función pura: fácil de probar.
export function calcularAvisos(datos: any, tz: string, ahora: number, ventana = VENTANA_MS): Aviso[] {
  const eventos: any[] = Array.isArray(datos?.eventos) ? datos.eventos.slice(0, 5000) : [];
  const soloTexto = (a: unknown) => Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  const hechos = new Set(soloTexto(datos?.completados));
  const borrados = new Set(soloTexto(datos?.eliminados));
  const out: Aviso[] = [];
  for (const ev of eventos) {
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) continue;
    if (typeof ev.title !== 'string' || !ev.title.trim()) continue;
    const id = ev.date + '|' + ev.title;
    if (hechos.has(id) || borrados.has(id)) continue;
    const hora = typeof ev.hora === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(ev.hora) ? ev.hora : null;
    const [hh, mm] = hora ? hora.split(':').map(Number) : [9, 0];
    for (const d of diasDeAviso(ev)) {
      const f = restarDias(ev.date, d);
      const cuando = utcDeLocal(f.y, f.m, f.d, hh, mm, tz);
      if (cuando > ahora || cuando <= ahora - ventana) continue;
      const lugar = textoLimpio(ev.lugar, 60);
      out.push({
        clave: `${id}|${hora || ''}|${d}`.slice(0, 300),
        titulo: ((ev.fav === true ? '★ ' : '') + textoLimpio(ev.title, 80)).slice(0, 90),
        cuerpo: (cuandoTexto(ev.date, d, hora) + (lugar ? ` · ${lugar}` : '')).slice(0, 140),
        url: APP_URL + '?dia=' + ev.date,
        tag: id.slice(0, 120),
      });
    }
  }
  return out;
}

// ───────────── Llaves de envío (se crean solas la primera vez) ─────────────
async function llaves(): Promise<{ publica: string; privada: string }> {
  const sql = db();
  await sql`insert into public.push_config (id) values (1) on conflict (id) do nothing`;
  let [c] = await sql`select vapid_public, vapid_private from public.push_config where id = 1`;
  if (!c.vapid_public || !c.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    const nuevas = await sql`
      update public.push_config set vapid_public = ${k.publicKey}, vapid_private = ${k.privateKey}
      where id = 1 and vapid_public is null
      returning vapid_public, vapid_private`;
    [c] = nuevas.length ? nuevas : await sql`select vapid_public, vapid_private from public.push_config where id = 1`;
  }
  return { publica: c.vapid_public, privada: c.vapid_private };
}

// ───────────── Mandar una notificación ─────────────
type Sub = { endpoint: string; p256dh: string; auth: string };
async function mandar(sub: Sub, carga: object, k: { publica: string; privada: string }): Promise<number> {
  const det = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(carga),
    {
      vapidDetails: { subject: APP_URL, publicKey: k.publica, privateKey: k.privada },
      TTL: TTL_S, urgency: 'high', contentEncoding: 'aes128gcm',
    },
  );
  const headers: Record<string, string> = {};
  for (const [h, v] of Object.entries(det.headers)) if (h.toLowerCase() !== 'content-length') headers[h] = String(v);
  try {
    const r = await fetch(det.endpoint, { method: 'POST', headers, body: det.body, signal: AbortSignal.timeout(10000) });
    await r.body?.cancel();
    if (r.status === 404 || r.status === 410) {
      await db()`delete from public.push_subs where endpoint = ${sub.endpoint}`;
    }
    return r.status;
  } catch {
    return 0;
  }
}

// ───────────── La tarea de cada minuto ─────────────
async function enviarPendientes(ahora: number) {
  const sql = db();
  const subs = await sql`select endpoint, user_id, p256dh, auth, tz from public.push_subs order by visto desc`;
  if (!subs.length) return { usuarios: 0, avisos: 0, enviados: 0 };
  const porUsuario = new Map<string, any[]>();
  for (const s of subs) {
    if (!porUsuario.has(s.user_id)) porUsuario.set(s.user_id, []);
    porUsuario.get(s.user_id)!.push(s);
  }
  const ids = [...porUsuario.keys()];
  const cals = await sql`select user_id, datos from public.calendario where user_id in ${sql(ids)}`;
  const k = await llaves();
  let avisos = 0, enviados = 0;
  for (const c of cals) {
    const lista = porUsuario.get(c.user_id) || [];
    const tz = tzValida(lista[0]?.tz);
    for (const a of calcularAvisos(c.datos, tz, ahora)) {
      // Cada aviso sale UNA vez aunque la tarea corra varias veces
      const nuevo = await sql`
        insert into public.push_enviados (user_id, clave) values (${c.user_id}, ${a.clave})
        on conflict do nothing returning 1`;
      if (!nuevo.length) continue;
      avisos++;
      for (const s of lista) {
        const st = await mandar(s, { t: a.titulo, b: a.cuerpo, u: a.url, g: a.tag }, k);
        if (st >= 200 && st < 300) enviados++;
      }
    }
  }
  await sql`delete from public.push_enviados where enviado < now() - interval '60 days'`;
  return { usuarios: cals.length, avisos, enviados };
}

// ───────────── Quién es (con la sesión de la app) ─────────────
async function usuario(req: Request): Promise<string | null> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!token || token.length > 4096 || !apikey) return null;
  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const u = await r.json();
    return typeof u?.id === 'string' && /^[0-9a-f-]{36}$/i.test(u.id) ? u.id : null;
  } catch {
    return null;
  }
}

function subValida(s: any): Sub | null {
  if (!s || typeof s !== 'object') return null;
  const endpoint = s.endpoint, p256dh = s.keys?.p256dh, auth = s.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
  let u: URL;
  try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== 'https:' && !(PRUEBAS && u.protocol === 'http:')) return null;
  if (!HOSTS_PUSH.some((rx) => rx.test(u.hostname))) return null;
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(p256dh)) return null;
  if (typeof auth !== 'string' || !/^[A-Za-z0-9_-]{16,44}={0,2}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

// ───────────── Entrada ─────────────
export async function manejar(req: Request): Promise<Response> {
  const origen = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origen) });
  if (req.method !== 'POST') return json({ error: 'método' }, 405, origen);

  let cuerpo: any = {};
  try {
    const txt = await req.text();
    if (txt.length > 8192) return json({ error: 'muy grande' }, 413, origen);
    cuerpo = txt ? JSON.parse(txt) : {};
  } catch {
    return json({ error: 'formato' }, 400, origen);
  }
  const accion = typeof cuerpo?.accion === 'string' ? cuerpo.accion : '';

  try {
    const sql = db();

    // ── La tarea programada ──
    if (accion === 'enviar') {
      await sql`insert into public.push_config (id) values (1) on conflict (id) do nothing`;
      const [c] = await sql`select cron_secret from public.push_config where id = 1`;
      if (!igualSeguro(req.headers.get('x-cron-secret') || '', c?.cron_secret || '')) {
        return json({ error: 'no autorizado' }, 401, origen);
      }
      const ahora = PRUEBAS && typeof cuerpo.ahora === 'number' ? cuerpo.ahora : Date.now();
      return json({ ok: true, ...(await enviarPendientes(ahora)) }, 200, origen);
    }

    // ── Todo lo demás es con tu sesión ──
    const uid = await usuario(req);
    if (!uid) return json({ error: 'sin sesión' }, 401, origen);

    if (accion === 'llave') {
      return json({ ok: true, llave: (await llaves()).publica }, 200, origen);
    }

    if (accion === 'suscribir') {
      const s = subValida(cuerpo.sub);
      if (!s) return json({ error: 'suscripción inválida' }, 400, origen);
      const tz = tzValida(cuerpo.tz);
      const equipo = textoLimpio(cuerpo.equipo, 40) || null;
      await sql`
        insert into public.push_subs (endpoint, user_id, p256dh, auth, tz, equipo)
        values (${s.endpoint}, ${uid}, ${s.p256dh}, ${s.auth}, ${tz}, ${equipo})
        on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
          auth = excluded.auth, tz = excluded.tz, equipo = excluded.equipo, visto = now()`;
      // Tope de dispositivos: se quedan los más recientes
      await sql`
        delete from public.push_subs where user_id = ${uid} and endpoint not in (
          select endpoint from public.push_subs where user_id = ${uid} order by visto desc limit ${MAX_SUBS_POR_USUARIO})`;
      return json({ ok: true }, 200, origen);
    }

    if (accion === 'baja') {
      const endpoint = typeof cuerpo.endpoint === 'string' ? cuerpo.endpoint.slice(0, 1024) : '';
      if (endpoint) await sql`delete from public.push_subs where user_id = ${uid} and endpoint = ${endpoint}`;
      else await sql`delete from public.push_subs where user_id = ${uid}`;
      return json({ ok: true }, 200, origen);
    }

    if (accion === 'estado') {
      const [n] = await sql`select count(*)::int as n from public.push_subs where user_id = ${uid}`;
      return json({ ok: true, dispositivos: n.n }, 200, origen);
    }

    if (accion === 'probar') {
      // Máximo una prueba cada 15 s
      const [ult] = await sql`select enviado from public.push_enviados where user_id = ${uid} and clave = 'prueba'`;
      if (ult && Date.now() - new Date(ult.enviado).getTime() < 15000) {
        return json({ error: 'espera' }, 429, origen);
      }
      await sql`
        insert into public.push_enviados (user_id, clave, enviado) values (${uid}, 'prueba', now())
        on conflict (user_id, clave) do update set enviado = now()`;
      const subs = await sql`select endpoint, p256dh, auth from public.push_subs where user_id = ${uid}`;
      if (!subs.length) return json({ ok: false, error: 'sin dispositivos' }, 200, origen);
      const k = await llaves();
      let enviados = 0;
      for (const s of subs) {
        const st = await mandar(s as Sub, {
          t: '✓ Notificaciones activadas',
          b: 'Así te van a llegar tus recordatorios, aunque tengas la app cerrada.',
          u: APP_URL, g: 'prueba',
        }, k);
        if (st >= 200 && st < 300) enviados++;
      }
      return json({ ok: enviados > 0, enviados, dispositivos: subs.length }, 200, origen);
    }

    return json({ error: 'acción desconocida' }, 400, origen);
  } catch (e) {
    console.error('avisos:', e instanceof Error ? e.message : e);
    return json({ error: 'falla del servidor' }, 500, origen);
  }
}

if (!PRUEBAS) Deno.serve(manejar);
