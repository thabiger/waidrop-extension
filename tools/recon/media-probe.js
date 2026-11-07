/**
 * WhatsApp Web full-resolution media probe (read-only).
 *
 * Open web.whatsapp.com, open a chat with an image, then paste this file into
 * the DevTools console. This probe is read-only: it inspects which media blobs
 * WhatsApp has already cached and never calls downloadMedia(). The report
 * contains sizes, hashes and module shapes only; image bytes are never logged
 * or copied.
 */
(async () => {
  'use strict';

  const report = {
    probe: 'whatsapp-media-probe',
    at: new Date().toISOString(),
    version: window.Debug && window.Debug.VERSION,
    require: typeof window.require,
    modules: {},
    message: null,
    cache: null,
    errors: [],
  };

  const safeRequire = (name) => {
    try {
      return window.require(name);
    } catch (e) {
      return null;
    }
  };

  for (const name of [
    'WAWebCollections',
    'WAWebMediaInMemoryBlobCache',
    'WAWebMediaDataUtils',
    'WAWebMmsMediaTypes',
    'WAWebMediaStore',
    'WAWebMediaStorage',
    'WAWebMediaOpaqueData',
  ]) {
    try {
      const module = safeRequire(name);
      report.modules[name] = module
        ? { ok: true, keys: Object.keys(module).slice(0, 20) }
        : { ok: false };
    } catch (e) {
      report.modules[name] = { ok: false, error: String(e).slice(0, 120) };
    }
  }

  try {
    const Msg = safeRequire('WAWebCollections')?.Msg;
    const models = Msg && typeof Msg.getModelsArray === 'function' ? Msg.getModelsArray() : [];
    const msg = models
      .slice()
      .reverse()
      .find((item) => item && item.mediaData && (['image', 'sticker', 'gif'].includes(item.type) || (item.type === 'video' && item.isGif)));
    if (!msg) {
      report.errors.push('no recent image/sticker/gif with mediaData; open a chat and retry');
    } else {
      report.message = {
        type: msg.type,
        hasId: !!msg.id,
        fromMe: !!(msg.id && msg.id.fromMe),
        isViewOnce: !!msg.isViewOnce,
        mediaStage: msg.mediaData && msg.mediaData.mediaStage,
        declaredSize: msg.size || (msg.mediaData && msg.mediaData.size) || null,
        mime: msg.mimetype || null,
        filehashPresent: !!(msg.mediaObject && msg.mediaObject.filehash),
        methods: Object.getOwnPropertyNames(Object.getPrototypeOf(msg))
          .filter((name) => /media|download/i.test(name))
          .slice(0, 30),
      };

      const started = Date.now();
      const cache = safeRequire('WAWebMediaInMemoryBlobCache');
      const cached =
        cache && cache.InMemoryMediaBlobCache && msg.mediaObject
          ? cache.InMemoryMediaBlobCache.get(msg.mediaObject.filehash)
          : null;
      const mediaStore = safeRequire('WAWebMediaStore');
      const lru = mediaStore && mediaStore.LruMediaStore;
      const lruGetSource = lru && typeof lru.get === 'function' ? String(lru.get).slice(0, 4000) : null;
      const lruSuspiciousCalls = lruGetSource
        ? ['fetch(', 'XMLHttpRequest', 'downloadMedia', 'WAWebMediaStorage', 'sendRequest', 'mediaConn', 'WAWebMediaDownload'].filter(
            (token) => lruGetSource.includes(token)
          )
        : [];
      const opaque = msg.mediaData && msg.mediaData.mediaBlob;
      const blob = cached || (opaque && typeof opaque.forceToBlob === 'function' ? opaque.forceToBlob() : null);
      let sha256 = null;
      if (blob && typeof blob.arrayBuffer === 'function') {
        const bytes = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        sha256 = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      }
      report.cache = {
        checkedInMs: Date.now() - started,
        stage: msg.mediaData && msg.mediaData.mediaStage,
        inMemoryCache: !!cached,
        lruStore: !!lru && typeof lru.get === 'function',
        lruGetSource,
        lruSuspiciousCalls,
        mediaDataBlob: !!opaque,
        blobType: blob && blob.type,
        blobSize: blob && blob.size,
        sha256,
      };
    }
  } catch (e) {
    report.errors.push(String(e && e.message ? e.message : e).slice(0, 200));
  }

  window.__waMediaProbeReport = report;
  console.log('%c[WA MEDIA PROBE] report:', 'font-weight:bold;color:#25D366', report);
  const json = JSON.stringify(report, null, 2);
  if (typeof copy === 'function') {
    copy(json);
    console.log('[WA MEDIA PROBE] JSON copied to clipboard.');
  }
})();
