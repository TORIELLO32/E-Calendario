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

const VERSION  = 'cal-2026-09-09';
const CACHE    = 'calendario-' + VERSION;
const ARCHIVOS = ['./', './index.html', './app.html', './icon.png'];
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
