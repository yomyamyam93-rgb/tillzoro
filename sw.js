/* Till Zero 서비스워커
 *
 * 하는 일은 셋이다.
 *   1. 인터넷이 끊겨도 앱이 열리게 한다
 *   2. 앱이 꺼져 있을 때 알림을 대신 받는다 (R-6)
 *   3. 안드로이드에 "설치할 수 있는 앱"으로 알려준다
 *
 * 화면(HTML)은 언제나 새것을 먼저 받아온다. 캐시를 우선하면
 * 고친 것이 폰에 안 보이는 일이 생긴다.
 */
const VERSION = "tz-0904-1630";
const ASSETS = [
  "./index.html",
  "./manifest.json",
  "./favicon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // 서버(API)로 가는 요청은 건드리지 않는다
  if (new URL(req.url).origin !== location.origin) return;

  // 화면은 새것 먼저, 인터넷이 없을 때만 캐시
  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // 아이콘처럼 바뀌지 않는 것은 캐시 먼저
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
    )
  );
});

/* 앱이 꺼져 있을 때 오는 알림. 서버가 실제로 보내기 시작하면 여기로 들어온다. */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "Till Zero", {
      body: d.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      data: d,
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
      for (const w of ws) if ("focus" in w) return w.focus();
      return self.clients.openWindow("./index.html");
    })
  );
});
