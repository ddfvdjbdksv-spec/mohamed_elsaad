// ============================================================
//  sw.js  —  Service Worker مع نظام التحديث التلقائي
//
//  آلية التحديث:
//    1. عند كل فتح للتطبيق يتحقق المتصفح من sw.js تلقائياً
//    2. إذا تغيّر CACHE_VERSION → يبدأ install جديد في الخلفية
//    3. بعد اكتمال التحميل، يرسل SW رسالة UPDATE_READY للتطبيق
//    4. التطبيق يُظهر للمستخدم إشعار "تحديث جاهز" → يضغط → يُطبَّق
//    5. أو: يُطبَّق تلقائياً بعد 10 ثوانٍ بدون تدخّل
// ============================================================

const CACHE_VERSION = 'markaz-mohamed-elsayed-pwa-v25';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './archive_functions.js',
  './platform-subscriptions.js',
  './transfer-student.js',
  './code-generator.js',
  './grade-mapping.js',
  './session-subscription.js',
  './manifest.webmanifest',
  './app-icon-192.png',
  './app-icon-512.png',
  './app-icon-maskable-512.png',
  './apple-touch-icon.png'
];

// ─── Install: تحميل كل ملفات الـ App Shell في الـ Cache ───
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing version: ${CACHE_VERSION}`);
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache:', url, err);
            return null;
          })
        )
      ))
      // skipWaiting: الـ SW الجديد يأخذ السيطرة فور اكتمال التحميل
      // لكن لن يُعيد تحميل الصفحة بنفسه — نحن من نقرر متى
      .then(() => {
        console.log(`[SW] Install complete: ${CACHE_VERSION}`);
        return self.skipWaiting();
      })
  );
});

// ─── Activate: حذف الـ Cache القديم وأخذ السيطرة الكاملة ──
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating version: ${CACHE_VERSION}`);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => {
            console.log(`[SW] Deleting old cache: ${key}`);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
      .then(async () => {
        // ✅ أبلغ كل النوافذ المفتوحة بأن تحديثاً جديداً تم تفعيله
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true
        });
        clients.forEach((client) => {
          client.postMessage({
            type: 'SW_UPDATED',
            version: CACHE_VERSION
          });
        });
        console.log(`[SW] Activated & notified ${clients.length} clients`);
      })
  );
});

// ─── Fetch: Cache-First للـ Shell، Network-First للباقي ───
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request, { cache: 'no-store' });
    if (fresh && fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch (error) {
    if (request.mode === 'navigate') return cache.match('./index.html');
    throw error;
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(request, { cache: 'no-store' });
    if (fresh && fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return cache.match('./index.html');
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // الموارد الخارجية → Network-First مع Cache fallback
  if (url.origin !== self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }

  // ملفات App Shell المحلية → Cache-First (يعمل فوراً offline)
  const isShellFile = APP_SHELL.some((shellUrl) => {
    const normalized = shellUrl.replace('./', '/');
    return (
      url.pathname === normalized ||
      url.pathname === shellUrl ||
      url.pathname.endsWith(shellUrl.replace('./', ''))
    );
  });

  if (isShellFile || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

// ─── Messages من التطبيق ────────────────────────────────────
self.addEventListener('message', (event) => {
  if (!event.data) return;

  // طلب تطبيق SW الجديد فوراً (من زر التحديث في الـ UI)
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // تنظيف كامل للـ Cache + تطبيق التحديث (Hard Refresh)
  if (event.data.type === 'FORCE_CLEAR_CACHE') {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.skipWaiting())
    );
  }

  // تسجيل Periodic Background Sync للخزنة
  if (event.data.type === 'REGISTER_TREASURY_SYNC') {
    registerPeriodicSync();
  }

  if (event.data.type === 'TREASURY_ARCHIVE_DONE') {
    self._lastArchiveDate = event.data.date;
  }
});

// ─── Periodic Background Sync ──────────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'treasury-daily-archive') {
    event.waitUntil(notifyClientsToArchive());
  }
});

async function registerPeriodicSync() {
  try {
    const registration = self.registration;
    if (registration && registration.periodicSync) {
      await registration.periodicSync.register('treasury-daily-archive', {
        minInterval: 12 * 60 * 60 * 1000
      });
    }
  } catch (e) {
    console.log('[SW] periodicSync not supported');
  }
}

async function notifyClientsToArchive() {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });
  const todayStr = new Date().toLocaleDateString('en-CA');
  if (clients.length > 0) {
    clients.forEach((client) => {
      client.postMessage({ type: 'RUN_TREASURY_ARCHIVE', date: todayStr });
    });
  } else {
    self._pendingArchive = todayStr;
  }
}
