const CACHE = "clientrecord-shell-v2";
const SHELL = ["/brand/clientrecord-icon.png", "/brand/clientrecord-logo.png", "/manifest.webmanifest"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin || new URL(request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && (request.destination === "script" || request.destination === "style" || request.destination === "image" || request.mode === "navigate")) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request).then(response => response || caches.match("/brand/clientrecord-icon.png"))));
});
