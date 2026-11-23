// Service worker : fonctionnement hors ligne + réception des fichiers partagés depuis Android.
const CACHE = 'mpr-v1';
const FICHIERS = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/vault.js', 'js/zip.js', 'js/extract.js', 'js/pension.js', 'js/params.js', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'inbox').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Partage Android (« Partager → Mes papiers retraite ») : on met les fichiers de côté puis on ouvre l'appli.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open('inbox');
      let i = 0;
      for (const f of form.getAll('files')) {
        if (!(f instanceof File)) continue;
        await cache.put(new Request(new URL(`inbox/${Date.now()}-${i++}`, self.registration.scope)), new Response(f, { headers: { 'x-name': encodeURIComponent(f.name), 'content-type': f.type } }));
      }
      return Response.redirect(new URL('./?partage=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Réseau d'abord (version à jour), cache en secours hors ligne.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copie)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
