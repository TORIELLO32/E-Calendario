// ══════════════════════════════════════════════════════════════
// Guarda la app en el teléfono para que abra al instante,
// con datos flojos o sin señal.
//
// Estrategia: primero se intenta la red (3 s). Si responde, se usa
// esa versión y se guarda una copia. Si tarda o falla, se abre la
// copia guardada. Así siempre abre, y siempre se actualiza cuando
// hay buena conexión.
// ══════════════════════════════════════════════════════════════

const VERSION = 'cal-2026-08-13';
const CACHE = 'calendario-' + VERSION;
const ARCHIVOS = ['./', './index.html', './app.html', './icon.png'];
const ESPERA = 3000;   // ms antes de rendirse y usar la copia

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
      .then(nombres => Promise.all(
        nombres.filter(n => n !== CACHE).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// Pide a la red con un límite de tiempo
function redConLimite(req){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('lenta')), ESPERA);
    fetch(req).then(r => { clearTimeout(t); resolve(r); },
                    e => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);
  // Solo lo de este sitio; Supabase y la API nunca se guardan
  if(url.origin !== self.location.origin) return;

  e.respondWith(
    redConLimite(req)
      .then(res => {
        if(res && res.ok){
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then(guardada => guardada || caches.match('./index.html'))
      )
  );
});

// La app puede pedir que se active una versión nueva de inmediato
self.addEventListener('message', e => {
  if(e.data === 'actualizar') self.skipWaiting();
});
