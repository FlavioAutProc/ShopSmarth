/* ==================================================================
   ShopSmart — Service Worker
   Estratégia: cache-first para o "app shell" (HTML/CSS/JS/ícones),
   com atualização em segundo plano; network-first para navegação,
   caindo pro cache quando estiver offline. Os dados das listas ficam
   no IndexedDB (não passam pelo service worker).
   ================================================================== */

const CACHE_VERSION = "v2";
const CACHE_NAME = `shopsmart-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./script.js",
  "./manifest.json",
  "./icons/icon-72.png",
  "./icons/icon-96.png",
  "./icons/icon-128.png",
  "./icons/icon-144.png",
  "./icons/icon-152.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

// Leitor de código de barras (ZXing) — usado quando o navegador não tem BarcodeDetector.
// É "opcional": se falhar o download, a instalação do app não é derrubada.
const OPTIONAL_ASSETS = ["./vendor/zxing.min.js"];

// ---------- Instalação: pré-carrega o app shell ----------
// cache: "reload" ignora o cache HTTP do navegador/CDN, para não gravar arquivos velhos.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })));
        await Promise.allSettled(OPTIONAL_ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      })
      .then(() => self.skipWaiting())
  );
});

// ---------- Ativação: limpa caches de versões antigas ----------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((name) => name.startsWith("shopsmart-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------- Requisições ----------
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Navegação (abrir/recarregar o app): tenta rede primeiro, cai pro cache se offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // App shell do mesmo domínio: cache-first, atualizando em segundo plano.
  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Recursos externos (fontes, ícones): stale-while-revalidate best-effort.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
