// ══════════════════════════════════════════════════════════════
// Guarda la app en el teléfono para que abra al instante, con
// datos flojos o sin señal.
//
// Cómo funciona ahora:
//   · SIEMPRE se pide a la red, en segundo plano.
//   · Si contesta en menos de 4 s, se usa esa versión.
//   · Si tarda, se abre la copia guardada para no dejarte esperando,
//     PERO la petición sigue viva y actualiza la copia cuando llega.
//     Así, aunque tu señal esté mal, la próxima vez ya abre la nueva.
//   · Con ?v= o ?reset= se espera a la red sí o sí (recarga forzada).
//
// El error anterior: al pasarse el tiempo se cancelaba la petición,
// así que con señal lenta la copia vieja nunca se reemplazaba y la
// app "bajaba de versión" sola.
// ══════════════════════════════════════════════════════════════

const VERSION  = 'cal-2026-09-26c';
const CACHE    = 'calendario-' + VERSION;
const ARCHIVOS = ['./', './index.html', './app.html', './icon.png', './icon-192.png', './icon-512.png', './manifest.json'];
const ESPERA   = 4000;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ARCHIVOS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(n => Promise.all(n.filter(x => x !== CACHE).map(x => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});

// La copia se guarda sin la parte de "?v=…", para que la recarga
// forzada y la normal compartan la misma entrada.
function claveDe(url){
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

function avisar(msg){
  self.clients.matchAll({ type:'window' })
    .then(cs => cs.forEach(c => c.postMessage(msg)))
    .catch(() => {});
}

// Espera a una promesa, pero se rinde a los ms indicados.
// Importante: NO cancela la promesa original; sigue corriendo.
function conLimite(promesa, ms){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('lenta')), ms);
    promesa.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;

  let url;
  try{ url = new URL(req.url); }catch(err){ return; }

  // Solo lo de este sitio. Supabase y la API nunca se guardan.
  if(url.origin !== self.location.origin) return;

  const forzada = url.searchParams.has('v') || url.searchParams.has('reset');
  const clave = claveDe(req.url);

  // Petición a la red que SIEMPRE actualiza la copia guardada,
  // llegue rápido o tarde.
  const red = fetch(req).then(async res => {
    if(res && res.ok){
      try{
        const c = await caches.open(CACHE);
        const antes = await c.match(clave);
        await c.put(clave, res.clone());
        // Si lo que llegó es distinto de lo guardado, hay versión nueva
        if(antes && /text\/html/.test(res.headers.get('content-type') || '')){
          const [a, b] = await Promise.all([antes.clone().text(), res.clone().text()]);
          if(a.length !== b.length) avisar('version-nueva');
        }
      }catch(err){}
    }
    return res;
  });

  // Que el navegador no mate al worker antes de que termine
  e.waitUntil(red.catch(() => {}));

  if(forzada){
    // Recarga forzada: se espera a la red, y solo si falla se usa la copia
    e.respondWith(red.catch(() => caches.match(clave)));
    return;
  }

  e.respondWith(
    conLimite(red, ESPERA).catch(async () => {
      const guardada = await caches.match(clave);
      return guardada || red;   // sin copia, se espera lo que llegue
    })
  );
});

self.addEventListener('message', e => {
  if(e.data === 'actualizar') self.skipWaiting();
});

// ══════════════════════════════════════════════════════════════
// NOTIFICACIONES
// Llegan de la función "avisos" de Supabase, cifradas. Aquí solo
// se muestran; al tocarlas se abre ese día en la app.
// ══════════════════════════════════════════════════════════════
function urlSegura(u){
  try{
    const x = new URL(u, self.registration.scope);
    if(x.origin === self.location.origin) return x.href;
  }catch(err){}
  return self.registration.scope;
}

self.addEventListener('push', e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }
  catch(err){ d = { t:'Recordatorio', b: e.data ? String(e.data.text()).slice(0, 140) : '' }; }
  const titulo = String(d.t || 'Recordatorio').slice(0, 90);
  const ev = typeof d.e === 'string' ? d.e.slice(0, 120) : '';
  const opciones = {
    body: String(d.b || '').slice(0, 160),
    tag: String(d.g || 'aviso').slice(0, 120),
    data: { url: urlSegura(d.u), ev },
    icon: './icon-192.png',
    badge: './icon-192.png',
    timestamp: Date.now(),
  };
  e.waitUntil((async () => {
    // Los avisos de cada hora de un mismo evento no se amontonan:
    // el nuevo reemplaza al anterior (y sí suena, por tener otra etiqueta)
    if(ev){
      try{
        const previas = await self.registration.getNotifications();
        previas.forEach(n => { if(n.data && n.data.ev === ev) n.close(); });
      }catch(err){}
    }
    // El iPhone exige mostrar SIEMPRE algo por cada aviso que llega
    await self.registration.showNotification(titulo, opciones);
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  let dia = null, lista = null;
  try{
    const q = new URL(url).searchParams;
    dia = q.get('dia');
    lista = q.get('lista');
  }catch(err){}
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for(const c of abiertas){
      if(c.url.startsWith(self.registration.scope)){
        try{ await c.focus(); }catch(err){}
        if(dia) c.postMessage({ tipo:'abrir-dia', fecha: dia });
        else if(lista) c.postMessage({ tipo:'abrir-lista', id: lista });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
