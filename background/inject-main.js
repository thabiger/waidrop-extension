/**
 * WAiDrop - MAIN-world store hook (v1)
 *
 * Injected into the page's JavaScript world (MAIN) by the background worker
 * via chrome.scripting shortly after document_start. Once WhatsApp's
 * bundle exposes window.require, this READ-ONLY hook resolves WAWebCollections
 * and subscribes to new messages in the in-memory Msg collection - the same
 * data source that powers WhatsApp's own notification previews, but complete:
 * full text, real server timestamp, message ids and chat jids, for every chat
 * (muted or not, open or not).
 *
 * GUARDRAILS (bot-safety by design):
 *   - Subscription and reads only. No send/ack/seen APIs are ever called.
 *   - Automatic media capture reads only media WhatsApp already downloaded.
 *     Active downloading of missing media is an explicit, opt-in setting and
 *     uses WhatsApp's own download manager (no direct network calls).
 *   - Media hashing and dimension decoding run in the extension service
 *     worker, not on the page's main thread.
 *   - No continuous polling after init and no message/chat/send-state mutation.
 *   - Every callback is wrapped: a failure here can never surface inside
 *     WhatsApp's own code.
 *   - If WhatsApp changes its internals, the hook posts a health failure and
 *     disables itself; the DOM layer keeps working.
 *
 * Transport: a private MessageChannel established at document_start. The
 * handshake is a nonce + SHA-256 MAC exchange over a per-session key that the
 * background worker passes into this hook as the hookMain() argument: the key
 * never appears in the page, and it is never transmitted - not even over the
 * port - so a script that steals the transferred port can neither impersonate
 * this hook nor the isolated content script. After the port is open, message
 * records, media bytes, directory data and config never cross
 * window.postMessage. The legacy window.postMessage bridge is kept only
 * for environments without MessageChannel (tests/old browsers); it is not
 * authenticated and must never be used in production Chrome.
 *
 * Records contain primitives only (WA model objects cannot cross worlds).
 *
 * Tests may expose window.__waArchiveMain (serializeStoreMessage, start, stop,
 * state, media helpers) by setting window.__WAIDROP_EXPOSE_TEST_API__ = true
 * before calling hookMain(). Production never exposes it.
 */
export function hookMain(bridgeKey) {
  'use strict';

  const SOURCE = 'waidrop-main';
  const CONFIG_SOURCE = 'waidrop-config';
  const LEGACY_SOURCE = 'waidrop-legacy';
  // The per-session bridge key arrives as the hookMain() argument from the
  // background worker (chrome.scripting executeScript args) and exists
  // nowhere in the extension source. Only SHA-256 MACs of it ever cross the
  // MessageChannel port; the key itself is never transmitted anywhere.
  const BRIDGE_PROBE_MS = 5000;
  const BRIDGE_LEGACY_GRACE_MS = 250;
  const BRIDGE_QUEUE_LIMIT = 500;
  const BRIDGE_QUEUE_BYTES = 64 * 1024 * 1024;
  const TEST_MODE = window.__WAIDROP_EXPOSE_TEST_API__ === true;

  // Capture the current MessagePort accessors at injection time, in case
  // WhatsApp's scripts instrument the shared prototype afterwards.
  const nativePortPostMessage =
    typeof MessagePort === 'function' && MessagePort.prototype ? MessagePort.prototype.postMessage : null;
  const nativePortOnMessage =
    typeof MessagePort === 'function' && MessagePort.prototype
      ? Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')
      : null;

  // Poll cheaply until WhatsApp's module loader is ready, then retry failed
  // collection lookups with a backoff instead of hammering an unknown name.
  const READY_POLL_MS = 100;
  const READY_GRACE_MS = 250;
  const APP_READY_GRACE_MS = 1500;
  const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];
  const RETRY_WINDOW_MS = 60000;

  // One-shot startup catch-up: messages WhatsApp loaded into memory before the
  // 'add' subscription existed (offline flush / startup hydration). Strictly
  // read-only: already-materialized models only, no loaders, no history
  // requests, no media downloads.
  const CATCH_UP_DELAYS_MS = [5000, 30000];
  const CATCH_UP_CHUNK_SIZE = 150;
  const CATCH_UP_MAX_RECORDS = 5000;
  const CATCH_UP_MEDIA_MAX = 100;

  // Protocol/system noise that is not conversation content.
  const SKIP_TYPES = new Set([
    'e2e_notification',
    'notification_template',
    'notification',
    'ciphertext',
    'protocol',
    'gp2',
    'call_log',
  ]);

  const MEDIA_TYPES = new Set(['image', 'sticker', 'gif']);
  // Media stays off until the ISOLATED script sends the user's stored mode.
  // A missing bridge or config must never cause a media read.
  const MEDIA_DEFAULT_CONFIG = {
    enabled: false,
    maxBytes: 20 * 1024 * 1024,
    captureViewOnce: false,
    activeFetch: false,
    recentMs: 24 * 60 * 60 * 1000,
    maxConcurrent: 1,
    maxPerMinute: 30,
    timeoutMs: 60000,
  };

  const state = {
    started: false,
    Msg: null,
    Chat: null,
    Contact: null,
    mediaConfig: { ...MEDIA_DEFAULT_CONFIG },
    catchUpEnabled: false,
  };
  let timer = null;
  let lastError = null;
  let appSeenAt = 0;
  let debugSeenAt = 0;
  let loaderNamesCache = null;
  let loaderNamesAt = 0;
  let loaderMapCache = null;
  let loaderMapAt = 0;
  const mediaQueue = [];
  const mediaCaptured = new Set();
  const mediaSettled = new Set();
  const mediaInFlight = new Set();
  const mediaDeferred = new Set();
  const mediaStarts = [];
  let mediaActive = 0;
  let mediaTimer = null;
  let lastPassiveMediaStartAt = 0;
  const PASSIVE_MEDIA_MIN_GAP_MS = 150;
  const MEDIA_MODULE_RETRY_MS = 5000;
  const mediaModuleCache = new Map();
  const catchUp = {
    seen: new Set(),
    queue: [],
    mediaCount: 0,
    timers: [],
    scheduled: false,
    drainTimer: null,
    drainIdle: false,
  };

  // Bridge state: probing -> port (private MessageChannel) or legacy.
  let bridgeMode = 'probing';
  let bridgePort = null;
  let bridgeProbeTimer = null;
  let bridgeLegacyTimer = null;
  let bridgePendingConfig = null;
  let bridgeWarned = false;
  const bridgeQueue = [];
  let bridgeQueueBytes = 0;

  const str = (value) => (typeof value === 'string' && value ? value : null);
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  function storeMsgId(msg) {
    if (!msg || !msg.id) return null;
    return str(msg.id.id) || str(msg.id._serialized);
  }

  // --- bridge authentication ----------------------------------------------

  function randomId() {
    try {
      const bytes = new Uint8Array(16);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return hex;
      }
    } catch (e) {
      /* fall through to the timestamp form */
    }
    return Date.now().toString(16) + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  }

  // HMAC-style MAC over the per-session key. Inputs are ASCII (hex key, hex
  // nonces), so byte-wise encoding is exact and TextEncoder is not needed.
  // The key itself is never returned or transmitted - only this digest.
  // Must stay identical to macHex() in content/content.js.
  function macHex(label, ...nonces) {
    return new Promise((resolve, reject) => {
      try {
        const input = ['wd-bridge/v1', label, bridgeKey, ...nonces].join('|');
        const bytes = new Uint8Array(input.length);
        for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff;
        crypto.subtle.digest('SHA-256', bytes).then(
          (digest) => {
            const view = new Uint8Array(digest);
            let hex = '';
            for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
            resolve(hex);
          },
          reject
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  function widString(wid) {
    if (!wid) return null;
    try {
      const serialized = str(wid._serialized);
      if (serialized) return serialized;
      const user = str(wid.user);
      const server = str(wid.server);
      if (user && server) return user + '@' + server;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function postToLegacy(kind, payload, transfer) {
    try {
      if (transfer && transfer.length) window.postMessage({ source: SOURCE, kind, payload }, '*', transfer);
      else window.postMessage({ source: SOURCE, kind, payload }, '*');
      return true;
    } catch (e) {
      try {
        window.postMessage({ source: SOURCE, kind, payload }, '*');
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  function portPost(port, message, transfer) {
    if (nativePortPostMessage) return nativePortPostMessage.call(port, message, transfer || []);
    return port.postMessage(message, transfer || []);
  }

  function setPortHandler(port, handler) {
    try {
      if (nativePortOnMessage && typeof nativePortOnMessage.set === 'function') {
        nativePortOnMessage.set.call(port, handler);
        return;
      }
    } catch (e) {
      /* fall through to the attribute */
    }
    try {
      port.onmessage = handler;
    } catch (e) {
      /* ignore */
    }
  }

  function postToPort(item) {
    if (!bridgePort) return false;
    try {
      if (item.transfer && item.transfer.length) {
        portPost(bridgePort, { kind: item.kind, payload: item.payload }, item.transfer);
      } else {
        portPost(bridgePort, { kind: item.kind, payload: item.payload });
      }
      return true;
    } catch (e) {
      try {
        portPost(bridgePort, { kind: item.kind, payload: item.payload });
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  function queueBridgeMessage(kind, payload, transfer) {
    const bytes = payload && payload.bytes && typeof payload.bytes.byteLength === 'number' ? payload.bytes.byteLength : 0;
    if (bridgeQueue.length >= BRIDGE_QUEUE_LIMIT || bridgeQueueBytes + bytes > BRIDGE_QUEUE_BYTES) return false;
    bridgeQueue.push({ kind, payload, transfer });
    bridgeQueueBytes += bytes;
    return true;
  }

  function flushBridgeQueue() {
    if (!bridgeQueue.length) return;
    const queued = bridgeQueue.splice(0, bridgeQueue.length);
    bridgeQueueBytes = 0;
    for (const item of queued) {
      if (bridgeMode === 'port' && bridgePort) postToPort(item);
      else if (bridgeMode === 'legacy') postToLegacy(item.kind, item.payload, item.transfer);
    }
  }

  function post(kind, payload, transfer) {
    if (bridgeMode === 'port' && bridgePort) return postToPort({ kind, payload, transfer });
    if (bridgeMode === 'legacy') return postToLegacy(kind, payload, transfer);
    if (bridgeMode === 'probing') return queueBridgeMessage(kind, payload, transfer);
    return false;
  }

  function safeRequire(name) {
    try {
      return typeof window.require === 'function' ? window.require(name) : null;
    } catch (e) {
      return null;
    }
  }

  // Cache lazy WhatsApp modules. A successful lookup is permanent; misses are
  // retried slowly so a module that appears later is still picked up.
  function getMediaModule(name) {
    const now = Date.now();
    const cached = mediaModuleCache.get(name);
    if (cached && (cached.value || now - cached.checkedAt < MEDIA_MODULE_RETRY_MS)) return cached.value;
    const value = safeRequire(name);
    mediaModuleCache.set(name, { value, checkedAt: now });
    return value;
  }

  // WhatsApp's module names change between builds and some modules only appear
  // after their resource bundle loads. Use the loader's own name map when it is
  // exposed so an absent name is skipped instead of triggering an error log.
  function loaderModuleMap() {
    const now = Date.now();
    if (loaderMapCache && now - loaderMapAt < 2000) return loaderMapCache;
    const req = typeof window.require === 'function' ? window.require : null;
    if (!req) return null;
    let map = null;
    // Meta loader: __debug.modulesMap lists every registered module id.
    try {
      const meta = typeof window.__d === 'function' || (window.__d && typeof window.__d === 'object');
      if (meta) {
        const debug = req('__debug');
        if (debug && debug.modulesMap && typeof debug.modulesMap === 'object') map = debug.modulesMap;
      }
    } catch (e) {
      /* legacy loader */
    }
    if (!map) {
      for (const key of ['m', 'modules', 'registry']) {
        let candidate;
        try {
          candidate = req[key];
        } catch (e) {
          continue;
        }
        if (candidate && typeof candidate === 'object') {
          map = candidate;
          break;
        }
      }
    }
    loaderMapCache = map;
    loaderMapAt = now;
    return map;
  }

  function loaderModuleNames() {
    const now = Date.now();
    if (loaderNamesCache && now - loaderNamesAt < 2000) return loaderNamesCache;
    let names = null;
    const map = loaderModuleMap();
    if (map) {
      try {
        names = typeof map.keys === 'function' ? Array.from(map.keys()) : Object.keys(map);
      } catch (e) {
        names = null;
      }
    }
    loaderNamesCache = names;
    loaderNamesAt = now;
    return names;
  }

  function namesAreKeyed(names) {
    return !!names && names.some((name) => typeof name === 'string' && name.startsWith('WAWeb'));
  }

  function requireNamed(name) {
    const req = typeof window.require === 'function' ? window.require : null;
    if (!req) return null;
    const names = loaderModuleNames();
    if (namesAreKeyed(names) && !names.includes(name)) return null;
    try {
      return req(name);
    } catch (e) {
      lastError = 'require-' + name + ': ' + String(e && e.message ? e.message : e).slice(0, 160);
      return null;
    }
  }

  function isMsgCollection(value) {
    return !!value && typeof value.on === 'function';
  }

  function isChatCollection(value) {
    return !!value && typeof value.get === 'function' && typeof value.getModelsArray === 'function';
  }

  function isContactCollection(value) {
    return !!value && typeof value.get === 'function';
  }

  function pickCollection(module, names, predicate) {
    if (!module) return null;
    const roots = [module, module.default];
    for (const root of roots) {
      if (!root || typeof root !== 'object') continue;
      for (const name of names) {
        if (predicate(root[name])) return root[name];
      }
      if (predicate(root)) return root;
    }
    return null;
  }

  // Last-resort shape search for builds that renamed the collection modules.
  // Meta module entries are factories, so require the candidate id (it is in
  // the registry); cap the scan so it stays cheap.
  function findCollectionsInModuleMap() {
    const map = loaderModuleMap();
    const names = loaderModuleNames();
    if (!map || !names) return null;

    const score = (name) => {
      if (name === 'WAWebCollections') return 0;
      if (/MsgCollection/.test(name)) return 1;
      if (/ChatCollection/.test(name)) return 2;
      if (/ContactCollection/.test(name)) return 3;
      return 4;
    };
    const candidates = names
      .filter((name) => typeof name === 'string' && /^WAWeb.*Collection/.test(name))
      .sort((a, b) => score(a) - score(b))
      .slice(0, 12);

    let Msg = null;
    let Chat = null;
    let Contact = null;
    for (const key of candidates) {
      let module;
      try {
        module = typeof map.get === 'function' ? map.get(key) : map[key];
      } catch (e) {
        continue;
      }
      if (!module || typeof module !== 'object') continue;
      // Meta modules are { factory }; require the id to get its exports.
      if (typeof module.factory === 'function') {
        module = requireNamed(key);
      }
      if (!module || typeof module !== 'object') continue;
      const root = module.default && (module.default.Msg || module.default.Chat) ? module.default : module;
      if (!Msg && isMsgCollection(root.Msg)) {
        Msg = root.Msg;
        Chat = Chat || (isChatCollection(root.Chat) ? root.Chat : null);
        Contact = Contact || (isContactCollection(root.Contact) ? root.Contact : null);
      }
      if (!Msg) Msg = pickCollection(module, ['MsgCollection', 'MsgStore', 'Msg'], isMsgCollection);
      if (!Chat) Chat = pickCollection(module, ['ChatCollection', 'ChatStore', 'Chat'], isChatCollection);
      if (!Contact) {
        Contact = pickCollection(module, ['ContactCollection', 'ContactStore', 'Contact'], isContactCollection);
      }
      if (Msg && Chat && Contact) break;
    }
    return Msg ? { Msg, Chat, Contact } : null;
  }

  function resolveCollectionSet() {
    const collections = requireNamed('WAWebCollections');
    if (collections) {
      const root =
        collections.default && (collections.default.Msg || collections.default.Chat)
          ? collections.default
          : collections;
      if (isMsgCollection(root.Msg)) {
        return {
          Msg: root.Msg,
          Chat: isChatCollection(root.Chat) ? root.Chat : null,
          Contact: isContactCollection(root.Contact) ? root.Contact : null,
        };
      }
    }

    // Newer builds also expose the collections as separate modules.
    const msgModule = requireNamed('WAWebMsgCollection');
    const Msg = msgModule ? pickCollection(msgModule, ['MsgCollection', 'MsgStore', 'Msg'], isMsgCollection) : null;
    if (!Msg) return findCollectionsInModuleMap();
    const chatModule = requireNamed('WAWebChatCollection');
    const Chat = chatModule ? pickCollection(chatModule, ['ChatCollection', 'ChatStore', 'Chat'], isChatCollection) : null;
    const contactModule = requireNamed('WAWebContactCollection');
    const Contact = contactModule
      ? pickCollection(contactModule, ['ContactCollection', 'ContactStore', 'Contact'], isContactCollection)
      : null;
    return { Msg, Chat, Contact };
  }

  function loaderReady() {
    if (TEST_MODE) return true;
    try {
      if (window.Debug && window.Debug.VERSION) {
        if (!debugSeenAt) debugSeenAt = Date.now();
        if (Date.now() - debugSeenAt >= READY_GRACE_MS) return true;
      }
    } catch (e) {
      /* ignore */
    }
    if (!appSeenAt) {
      try {
        if (document.querySelector('#app')) appSeenAt = Date.now();
      } catch (e) {
        /* ignore */
      }
    }
    return !!(appSeenAt && Date.now() - appSeenAt >= APP_READY_GRACE_MS);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function scheduleIdle(fn, timeoutMs = 2000) {
    try {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(
          () => {
            try {
              fn();
            } catch (e) {
              /* never surface into the page */
            }
          },
          { timeout: timeoutMs }
        );
        return;
      }
    } catch (e) {
      /* fall through to a task */
    }
    setTimeout(() => {
      try {
        fn();
      } catch (e) {
        /* ignore */
      }
    }, 0);
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  }

  function toBlob(value) {
    if (!value) return null;
    try {
      if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
    } catch (e) {
      /* cross-realm Blob */
    }
    try {
      if (typeof value.forceToBlob === 'function') {
        const blob = value.forceToBlob();
        if (blob) return blob;
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (value.blob) return value.blob;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function declaredMediaSize(msg) {
    return (
      num(msg && msg.size) ||
      num(msg && msg.mediaData && msg.mediaData.size) ||
      num(msg && msg.mediaObject && msg.mediaObject.size) ||
      null
    );
  }

  function mediaStatus(record, status, error) {
    post('media-status', {
      msgId: record.msgId,
      chatId: record.chatId || null,
      isGroup: record.isGroup === true,
      status,
      error: error ? String(error).slice(0, 160) : null,
    });
  }

  function mediaEligible(record, msg) {
    if (!state.mediaConfig.enabled || !record || !record.msgId) return false;
    const isGif = record.type === 'video' && msg && msg.isGif === true;
    if (!MEDIA_TYPES.has(record.type) && !isGif) return false;
    if (record.chatId && /@(broadcast|newsletter)$/.test(record.chatId)) return false;
    return true;
  }

  function mediaAllowed() {
    const now = Date.now();
    while (mediaStarts.length && now - mediaStarts[0] > 60000) mediaStarts.shift();
    return mediaStarts.length < Math.max(1, num(state.mediaConfig.maxPerMinute) || 30);
  }

  const COMPLETED_MEDIA_STAGES = new Set(['RESOLVED', 'READY', 'DOWNLOADED']);

  // The LRU media store is only read after WhatsApp itself reports a completed
  // download. Reading it while FETCHING/REUPLOADING could, on some builds,
  // start a media request; passive mode must never do that.
  function lruReadAllowed(msg) {
    const stage = msg && msg.mediaData && msg.mediaData.mediaStage;
    if (!stage) return false;
    return COMPLETED_MEDIA_STAGES.has(String(stage).toUpperCase());
  }

  function resolveMediaBlob(msg) {
    const filehash = msg && msg.mediaObject && msg.mediaObject.filehash;
    if (filehash) {
      const cache = getMediaModule('WAWebMediaInMemoryBlobCache');
      const cacheBlob =
        cache && cache.InMemoryMediaBlobCache ? toBlob(cache.InMemoryMediaBlobCache.get(filehash)) : null;
      if (cacheBlob) return cacheBlob;
    }

    const mediaBlob = toBlob(msg && msg.mediaData && msg.mediaData.mediaBlob);
    if (mediaBlob) return mediaBlob;

    const objectBlob = toBlob(msg && msg.mediaObject && msg.mediaObject.mediaBlob);
    if (objectBlob) return objectBlob;

    return null;
  }

  async function resolveCachedMediaBlob(msg, timeoutMs, skipDirect) {
    const direct = skipDirect ? null : resolveMediaBlob(msg);
    if (direct) return direct;
    const filehash = msg && msg.mediaObject && msg.mediaObject.filehash;
    if (!filehash || !lruReadAllowed(msg)) return null;
    const mediaStore = getMediaModule('WAWebMediaStore');
    const lru = mediaStore && mediaStore.LruMediaStore;
    if (!lru || typeof lru.get !== 'function') return null;
    try {
      const data = await withTimeout(Promise.resolve(lru.get(filehash)), Math.max(250, num(timeoutMs) || 1000));
      if (!data) return null;
      const size = data.byteLength != null ? data.byteLength : data.length;
      if (!size) return null;
      if (typeof Blob === 'function') {
        return new Blob([data], { type: msg.mimetype || 'application/octet-stream' });
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  async function resolveMediaBlobWithWait(msg, timeoutMs) {
    if (!(timeoutMs > 0)) return resolveMediaBlob(msg);
    const deadline = Date.now() + timeoutMs;
    await sleep(100);
    do {
      const blob = resolveMediaBlob(msg);
      if (blob) return blob;
      await sleep(100);
    } while (Date.now() < deadline);
    return null;
  }

  function waitForOutgoingMedia(msg) {
    if (!msg || !msg.id || msg.id.fromMe !== true) return Promise.resolve();
    const stage = msg.mediaData && msg.mediaData.mediaStage;
    if (!msg.isUnsentMedia && stage !== 'REUPLOADING' && stage !== 'FETCHING') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        try {
          if (state.Msg && typeof state.Msg.off === 'function') {
            state.Msg.off('change:isUnsentMedia', onChange);
            state.Msg.off('change:mediaStage', onChange);
          }
        } catch (e) {
          /* ignore */
        }
        resolve();
      };
      const onChange = (changed) => {
        if (!changed || changed === msg) finish();
      };
      const timeout = setTimeout(finish, Math.max(1000, state.mediaConfig.timeoutMs));
      try {
        if (state.Msg && typeof state.Msg.on === 'function') {
          state.Msg.on('change:isUnsentMedia', onChange);
          state.Msg.on('change:mediaStage', onChange);
        } else {
          finish();
        }
      } catch (e) {
        finish();
      }
    });
  }

  async function captureMedia(msg, record, options = {}) {
    const allowDownload = options.allowDownload === true;
    const waitMs = num(options.waitMs) || 0;
    if (!record || !record.msgId || !state.mediaConfig.enabled) return false;
    const canDownload = () =>
      allowDownload && state.mediaConfig.enabled && state.mediaConfig.activeFetch === true;
    let downloadAttempted = false;
    try {
      const viewOnce = msg.isViewOnce === true || (msg.mediaData && msg.mediaData.isViewOnce === true);
      if (viewOnce && !state.mediaConfig.captureViewOnce) {
        mediaSettled.add(record.msgId);
        mediaDeferred.delete(record.msgId);
        mediaStatus(record, 'view_once');
        return false;
      }
      if (!msg.mediaData) {
        mediaStatus(record, 'unavailable');
        return false;
      }
      const limit = num(state.mediaConfig.maxBytes) || MEDIA_DEFAULT_CONFIG.maxBytes;

      let blob = options.cachedBlob || null;
      if (!blob) blob = await resolveCachedMediaBlob(msg, waitMs || 1000, options.directChecked === true);
      if (!blob && waitMs > 0) blob = await resolveMediaBlobWithWait(msg, waitMs);

      if (!blob && canDownload()) {
        const declared = declaredMediaSize(msg);
        if (declared && declared > limit) {
          mediaSettled.add(record.msgId);
          mediaDeferred.delete(record.msgId);
          mediaStatus(record, 'too_large');
          return false;
        }
        await waitForOutgoingMedia(msg);
        if (canDownload()) {
          if (typeof msg.downloadMedia !== 'function') {
            mediaStatus(record, 'unavailable');
            return false;
          }
          downloadAttempted = true;
          const download = msg.downloadMedia({
            downloadEvenIfExpensive: true,
            rmrReason: 1,
          });
          await withTimeout(Promise.resolve(download), Math.max(1000, state.mediaConfig.timeoutMs));

          const stage = msg.mediaData && msg.mediaData.mediaStage;
          if (stage && (String(stage).includes('ERROR') || stage === 'FETCHING')) {
            mediaStatus(record, 'failed', stage);
            return false;
          }
          blob = await resolveMediaBlobWithWait(msg, 5000);
        }
      }

      if (!blob) {
        if (downloadAttempted) {
          mediaStatus(record, 'unavailable');
        } else if (!mediaDeferred.has(record.msgId)) {
          mediaDeferred.add(record.msgId);
          mediaStatus(record, 'not_downloaded');
        }
        return false;
      }

      if (!state.mediaConfig.enabled) return false;
      const bytes = await blob.arrayBuffer();
      if (bytes.byteLength > limit) {
        mediaSettled.add(record.msgId);
        mediaDeferred.delete(record.msgId);
        mediaStatus(record, 'too_large');
        return false;
      }

      if (!state.mediaConfig.enabled) return false;
      const posted = post('media', {
        msgId: record.msgId,
        chatId: record.chatId || null,
        isGroup: record.isGroup === true,
        fetchMode: downloadAttempted ? 'active' : 'passive',
        kind: record.type === 'video' && msg.isGif === true ? 'gif' : record.type,
        ts: record.ts || record.sortTs || record.capturedAt || null,
        mime: blob.type || msg.mimetype || null,
        size: bytes.byteLength,
        bytes,
      });
      if (posted) mediaDeferred.delete(record.msgId);
      return posted;
    } catch (e) {
      mediaStatus(record, 'failed', e && e.message ? e.message : e);
      return false;
    }
  }

  function scheduleMediaDrain(delayMs) {
    if (mediaTimer) return;
    const run = () => {
      mediaTimer = null;
      drainMediaQueue();
    };
    mediaTimer = setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        try {
          window.requestIdleCallback(run, { timeout: 1000 });
          return;
        } catch (e) {
          /* fall through to a task */
        }
      }
      run();
    }, Math.max(0, delayMs));
  }

  function drainMediaQueue() {
    if (mediaTimer) {
      clearTimeout(mediaTimer);
      mediaTimer = null;
    }
    if (!state.mediaConfig.enabled) {
      mediaQueue.length = 0;
      return;
    }
    while (mediaActive < Math.max(1, num(state.mediaConfig.maxConcurrent) || 1) && mediaQueue.length) {
      const item = mediaQueue.shift();
      const cached = resolveMediaBlob(item.msg);
      const allowDownload = item.allowDownload && state.mediaConfig.enabled && state.mediaConfig.activeFetch;
      if (!cached && allowDownload) {
        if (!mediaAllowed()) {
          mediaQueue.unshift(item);
          scheduleMediaDrain(1000);
          return;
        }
        mediaStarts.push(Date.now());
      }
      const now = Date.now();
      if (!allowDownload && now - lastPassiveMediaStartAt < PASSIVE_MEDIA_MIN_GAP_MS) {
        mediaQueue.unshift(item);
        scheduleMediaDrain(PASSIVE_MEDIA_MIN_GAP_MS - (now - lastPassiveMediaStartAt));
        return;
      }
      if (!allowDownload) lastPassiveMediaStartAt = now;
      mediaActive++;
      captureMedia(item.msg, item.record, {
        allowDownload,
        waitMs: item.waitMs,
        cachedBlob: cached,
        directChecked: true,
      })
        .then((captured) => {
          if (captured) mediaCaptured.add(item.record.msgId);
        })
        .catch(() => {})
        .finally(() => {
          mediaInFlight.delete(item.record.msgId);
          mediaActive--;
          // Space passive captures out from completion as well as from start,
          // so a media backlog cannot keep the page thread continuously busy.
          if (!allowDownload) lastPassiveMediaStartAt = Date.now();
          drainMediaQueue();
        });
    }
  }

  function enqueueMedia(msg, record, options = {}) {
    if (!mediaEligible(record, msg)) return;
    if (mediaCaptured.has(record.msgId) || mediaSettled.has(record.msgId) || mediaInFlight.has(record.msgId)) return;
    const ts = num(record.ts) || num(record.capturedAt);
    const recent = !ts || Date.now() - ts <= Math.max(0, num(state.mediaConfig.recentMs) || 0);
    const allowDownload = options.allowDownload !== false && state.mediaConfig.activeFetch && recent;
    mediaInFlight.add(record.msgId);
    mediaQueue.push({
      msg,
      record,
      allowDownload,
      waitMs: num(options.waitMs) || 0,
    });
    drainMediaQueue();
  }

  function handleMediaChange(msg) {
    try {
      if (!msg || !msg.id) return;
      const record = serializeStoreMessage(msg);
      if (!mediaEligible(record, msg)) return;
      enqueueMedia(msg, record, { allowDownload: false, waitMs: 500 });
    } catch (e) {
      /* ignore */
    }
  }

  function applyMediaConfig(media) {
    try {
      if (!media || typeof media !== 'object') return;
      const previous = state.mediaConfig;
      state.mediaConfig = { ...state.mediaConfig, ...media };
      if (!state.mediaConfig.enabled) {
        mediaQueue.length = 0;
        if (mediaTimer) {
          clearTimeout(mediaTimer);
          mediaTimer = null;
        }
      } else if (previous.activeFetch && !state.mediaConfig.activeFetch) {
        for (const item of mediaQueue) item.allowDownload = false;
      }
    } catch (e) {
      /* ignore malformed config */
    }
  }

  function applyConfig(config) {
    if (!config || typeof config !== 'object') return;
    if (config.media) applyMediaConfig(config.media);
    if (typeof config.catchUp === 'boolean') applyCatchUpEnabled(config.catchUp);
  }

  function handleBridgePortMessage(event) {
    try {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'config') applyConfig(data);
    } catch (e) {
      /* never throw into the port event dispatch */
    }
  }

  function acceptBridgePort(port) {
    if (!port || bridgeMode === 'port') return;
    // Without a per-session key (or SubtleCrypto) no private port is ever
    // accepted; the bridge then degrades to legacy/test mode or fails.
    if (!bridgeKey || typeof crypto === 'undefined' || !crypto.subtle) return;
    const nonce = randomId();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        port.close();
      } catch (e) {
        /* ignore */
      }
    }, 1000);

    setPortHandler(port, (event) => {
      try {
        if (settled) return;
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;
        if (data.ok !== undefined) return;
        // Reply must echo our challenge nonce, contribute a fresh nonce and
        // carry a valid MAC over both - proof of key possession without
        // ever disclosing the key.
        if (typeof data.c !== 'string' || data.c !== nonce) return;
        if (typeof data.n !== 'string' || !data.n || data.n.length > 128) return;
        if (typeof data.m1 !== 'string' || data.m1.length !== 64) return;
        macHex('reply', nonce, data.n)
          .then((expected) => {
            if (settled || expected !== data.m1) return;
            settled = true;
            clearTimeout(timeout);
            bridgePort = port;
            bridgeMode = 'port';
            bridgePendingConfig = null;
            if (bridgeProbeTimer) {
              clearTimeout(bridgeProbeTimer);
              bridgeProbeTimer = null;
            }
            if (bridgeLegacyTimer) {
              clearTimeout(bridgeLegacyTimer);
              bridgeLegacyTimer = null;
            }
            window.removeEventListener('message', onBridgeWindowMessage);
            setPortHandler(port, handleBridgePortMessage);
            // Acknowledge with a MAC over the isolated script's nonce so it
            // can verify this side holds the same key.
            macHex('ack', data.n)
              .then((m2) => {
                try {
                  portPost(port, { ok: 1, n: data.n, m2 });
                } catch (e) {
                  /* the isolated script retries if the ack is lost */
                }
              })
              .catch(() => {});
            flushBridgeQueue();
          })
          .catch(() => {});
      } catch (e) {
        /* ignore malformed handshake messages */
      }
    });

    try {
      port.start();
    } catch (e) {
      /* assigning onmessage also starts the port in Chrome */
    }
    try {
      portPost(port, { c: nonce });
    } catch (e) {
      settled = true;
      clearTimeout(timeout);
      try {
        port.close();
      } catch (err) {
        /* ignore */
      }
    }
  }

  function enterLegacyMode() {
    if (bridgeMode !== 'probing') return;
    bridgeMode = 'legacy';
    if (bridgeProbeTimer) {
      clearTimeout(bridgeProbeTimer);
      bridgeProbeTimer = null;
    }
    if (bridgeLegacyTimer) {
      clearTimeout(bridgeLegacyTimer);
      bridgeLegacyTimer = null;
    }
    if (bridgePendingConfig) {
      const config = bridgePendingConfig;
      bridgePendingConfig = null;
      applyConfig(config);
    }
    flushBridgeQueue();
  }

  function onBridgeWindowMessage(event) {
    try {
      if (event.source && event.source !== window) return;
      if (event.origin && event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data) return;

      if (event.ports && event.ports[0]) {
        acceptBridgePort(event.ports[0]);
        return;
      }

      if (data.source === LEGACY_SOURCE) {
        if (bridgeMode !== 'probing') return;
        if (!bridgeLegacyTimer) {
          bridgeLegacyTimer = setTimeout(() => {
            bridgeLegacyTimer = null;
            enterLegacyMode();
          }, BRIDGE_LEGACY_GRACE_MS);
        }
        return;
      }

      if (data.source === CONFIG_SOURCE && (data.media || typeof data.catchUp === 'boolean')) {
        if (bridgeMode === 'legacy') applyConfig(data);
        else if (bridgeMode === 'probing') bridgePendingConfig = data;
      }
    } catch (e) {
      /* never throw into the page's message dispatch */
    }
  }

  function initBridge() {
    window.addEventListener('message', onBridgeWindowMessage);
    if (TEST_MODE && typeof MessageChannel !== 'function') {
      bridgeMode = 'legacy';
      return;
    }
    bridgeProbeTimer = setTimeout(() => {
      bridgeProbeTimer = null;
      if (bridgeMode !== 'probing') return;
      bridgeMode = 'failed';
      bridgeQueue.length = 0;
      bridgeQueueBytes = 0;
      if (!bridgeWarned) {
        bridgeWarned = true;
        console.warn('[WAiDrop] store bridge unavailable; DOM capture only');
      }
    }, BRIDGE_PROBE_MS);
  }

  function firstString(...values) {
    for (const value of values) {
      const s = str(value);
      if (s) return s;
    }
    return null;
  }

  function phoneOfJid(wid) {
    const serialized = str(wid) || widString(wid);
    if (!serialized) return null;
    const at = serialized.indexOf('@');
    if (at < 0) return null;
    const user = serialized.slice(0, at);
    const server = serialized.slice(at + 1);
    if (server !== 'c.us' && server !== 's.whatsapp.net') return null;
    return /^\d{5,}$/.test(user) ? user : null;
  }

  function contactFor(jid) {
    try {
      if (!jid) return null;
      return state.Contact && typeof state.Contact.get === 'function' ? state.Contact.get(jid) || null : null;
    } catch (e) {
      return null;
    }
  }

  function contactDisplayName(contact) {
    if (!contact) return null;
    try {
      return firstString(contact.name, contact.pushname, contact.shortName, contact.displayName);
    } catch (e) {
      return null;
    }
  }

  function chatModelFor(chatId, msg) {
    try {
      if (msg && msg.chat && typeof msg.chat === 'object') return msg.chat;
      if (state.Chat && chatId && typeof state.Chat.get === 'function') return state.Chat.get(chatId) || null;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function chatDisplayName(chat, contact, chatId) {
    let title = null;
    try {
      title = firstString(chat && chat.formattedTitle, chat && chat.name);
    } catch (e) {
      /* ignore */
    }
    return title || contactDisplayName(contact) || phoneOfJid(chatId);
  }

  function buildNameDirectory() {
    const chats = [];
    try {
      const models =
        state.Chat && typeof state.Chat.getModelsArray === 'function' ? state.Chat.getModelsArray() : [];
      for (const chat of models) {
        if (chats.length >= 2000) break;
        const chatId = widString(chat && chat.id);
        if (!chatId) continue;
        const contact = contactFor(chatId);
        const chatName = chatDisplayName(chat, contact, chatId);
        if (!chatName) continue;
        chats.push({
          chatId,
          chatName,
          chatPhone: phoneOfJid(contact && contact.phoneNumber) || phoneOfJid(chatId) || null,
          chatPushname: firstString(contact && contact.pushname) || null,
          isGroup: /@g\.us$/i.test(chatId),
        });
      }
    } catch (e) {
      /* directory is best effort */
    }
    if (chats.length) post('directory', { chats });
  }

  function serializeStoreMessage(msg) {
    if (!msg || !msg.id) return null;
    const id = msg.id;
    const type = str(msg.type) || 'unknown';
    if (SKIP_TYPES.has(type)) return null;

    const serialized = str(id._serialized);
    const msgId = storeMsgId(msg);
    if (!msgId) return null;

    const fromMe = id.fromMe === true;
    const chatId = widString(id.remote) || widString(fromMe ? msg.to : msg.from);
    const isGroup = !!(chatId && /@g\.us$/.test(chatId));

    const t = num(msg.t);
    const text = typeof msg.body === 'string' ? msg.body : '';
    const senderId = widString(msg.author) || widString(msg.from) || null;
    const notifyName = str(msg.notifyName);

    const chat = chatModelFor(chatId, msg);
    const chatContact = contactFor(chatId);
    const chatName = chatDisplayName(chat, chatContact, chatId) || 'unknown';
    const chatPhone = phoneOfJid(chatContact && chatContact.phoneNumber) || phoneOfJid(chatId) || null;
    const chatPushname = firstString(chatContact && chatContact.pushname) || null;

    const senderContact = senderId && senderId !== chatId ? contactFor(senderId) : chatContact;
    let senderName;
    if (fromMe) {
      senderName = 'You';
    } else if (!isGroup) {
      senderName =
        chatName !== 'unknown'
          ? chatName
          : firstString(notifyName, contactDisplayName(senderContact), phoneOfJid(senderId));
    } else {
      senderName = firstString(notifyName, contactDisplayName(senderContact), phoneOfJid(senderId));
    }
    const senderPushname = firstString(senderContact && senderContact.pushname, notifyName) || null;
    const senderPhone = phoneOfJid(senderContact && senderContact.phoneNumber) || phoneOfJid(senderId) || null;

    return {
      v: 1,
      msgId,
      msgKey: serialized || null,
      chatId: chatId || null,
      chatName,
      chatPhone,
      chatPushname,
      isGroup,
      direction: fromMe ? 'out' : 'in',
      senderId,
      senderName,
      senderPushname,
      senderPhone,
      text,
      ts: t != null && t > 0 ? t * 1000 : null,
      tsRaw: null,
      type,
      capturedAt: Date.now(),
      source: 'store',
    };
  }

  function collectionModels(collection) {
    try {
      if (collection && typeof collection.getModelsArray === 'function') {
        const models = collection.getModelsArray();
        return Array.isArray(models) ? models : [];
      }
    } catch (e) {
      /* a missing/renamed collection is not an error */
    }
    return [];
  }

  function maybeCatchUpMedia(msg, record) {
    if (!state.mediaConfig.enabled) return;
    if (!mediaEligible(record, msg)) return;
    if (catchUp.mediaCount >= CATCH_UP_MEDIA_MAX) return;
    const ts = num(record.ts) || num(record.capturedAt);
    if (!ts) return;
    const recentMs = Math.max(0, num(state.mediaConfig.recentMs) || 0);
    if (Date.now() - ts > recentMs) return;
    catchUp.mediaCount++;
    // Passive only: even in Active mode, catch-up must never call
    // downloadMedia. captureMedia reads cached blobs and nothing else.
    enqueueMedia(msg, record, { allowDownload: false, waitMs: 0 });
  }

  function collectCatchUpMessages() {
    const candidates = new Map();
    const add = (msg) => {
      if (!msg) return;
      const id = storeMsgId(msg);
      if (!id || catchUp.seen.has(id) || candidates.has(id)) return;
      candidates.set(id, msg);
    };

    // The global collection is the notification/search window; per-chat
    // collections hold whatever WhatsApp already materialized for a chat.
    // Both are read-only snapshots of memory, never loaders.
    for (const msg of collectionModels(state.Msg).slice(-CATCH_UP_MAX_RECORDS)) add(msg);
    const chats = collectionModels(state.Chat);
    for (const chat of chats) {
      if (candidates.size >= CATCH_UP_MAX_RECORDS * 2) break;
      const models = collectionModels(chat && chat.msgs);
      if (!models.length) continue;
      for (const msg of models.slice(-CATCH_UP_MAX_RECORDS)) add(msg);
    }

    const ordered = [...candidates.values()]
      .sort((a, b) => (num(b && b.t) || 0) - (num(a && a.t) || 0))
      .slice(0, CATCH_UP_MAX_RECORDS);
    for (const msg of ordered) {
      const id = storeMsgId(msg);
      if (!id || catchUp.seen.has(id)) continue;
      catchUp.seen.add(id);
      catchUp.queue.push(msg);
    }
  }

  function cancelCatchUpTimers() {
    for (const timer of catchUp.timers) clearTimeout(timer);
    catchUp.timers.length = 0;
    catchUp.scheduled = false;
    if (catchUp.drainTimer !== null) {
      if (catchUp.drainIdle && typeof window.cancelIdleCallback === 'function') {
        try {
          window.cancelIdleCallback(catchUp.drainTimer);
        } catch (e) {
          /* ignore */
        }
      } else {
        clearTimeout(catchUp.drainTimer);
      }
      catchUp.drainTimer = null;
    }
    catchUp.drainIdle = false;
  }

  function applyCatchUpEnabled(enabled) {
    const previous = state.catchUpEnabled;
    state.catchUpEnabled = enabled;
    if (!enabled) {
      catchUp.queue.length = 0;
      cancelCatchUpTimers();
      return;
    }
    if (!previous && state.started) scheduleCatchUp();
  }

  function scheduleCatchUpDrain() {
    if (catchUp.drainTimer !== null) return;
    const run = () => {
      catchUp.drainTimer = null;
      drainCatchUpQueue();
    };
    try {
      if (typeof window.requestIdleCallback === 'function') {
        catchUp.drainIdle = true;
        catchUp.drainTimer = window.requestIdleCallback(run, { timeout: 1000 });
        return;
      }
    } catch (e) {
      /* fall through to a task */
    }
    catchUp.drainIdle = false;
    catchUp.drainTimer = setTimeout(run, 0);
  }

  function drainCatchUpQueue() {
    if (!state.catchUpEnabled || !state.started || (bridgeMode !== 'port' && bridgeMode !== 'legacy')) {
      catchUp.queue.length = 0;
      return;
    }
    let processed = 0;
    while (catchUp.queue.length && processed < CATCH_UP_CHUNK_SIZE) {
      const msg = catchUp.queue.shift();
      processed++;
      try {
        const record = serializeStoreMessage(msg);
        if (!record) continue;
        if (!post('message', record)) {
          catchUp.queue.length = 0;
          return;
        }
        maybeCatchUpMedia(msg, record);
      } catch (e) {
        /* never surface into the page */
      }
    }
    if (catchUp.queue.length) scheduleCatchUpDrain();
  }

  function runCatchUp() {
    if (!state.catchUpEnabled || !state.started) return;
    if (bridgeMode !== 'port' && bridgeMode !== 'legacy') return;
    collectCatchUpMessages();
    scheduleCatchUpDrain();
  }

  function scheduleCatchUp() {
    if (!state.catchUpEnabled || !state.started || catchUp.scheduled) return;
    catchUp.scheduled = true;
    for (const delay of CATCH_UP_DELAYS_MS) {
      const timer = setTimeout(() => {
        try {
          runCatchUp();
        } catch (e) {
          /* ignore */
        }
      }, delay);
      catchUp.timers.push(timer);
    }
  }

  function tryInit() {
    const collections = resolveCollectionSet();
    if (!collections || !collections.Msg) {
      if (!lastError) lastError = 'collections-unavailable';
      return false;
    }
    const Msg = collections.Msg;
    if (!Msg || typeof Msg.on !== 'function') {
      lastError = 'msg-collection-unavailable';
      return false;
    }

    state.Msg = Msg;
    state.Chat = collections.Chat || null;
    state.Contact = collections.Contact || null;

    Msg.on('add', (msg) => {
      try {
        const record = serializeStoreMessage(msg);
        if (record) {
          post('message', record);
          enqueueMedia(msg, record, { allowDownload: true });
        }
      } catch (e) {
        /* never throw into WhatsApp's emitter */
      }
    });
    Msg.on('change:mediaStage', handleMediaChange);
    Msg.on('change:isUnsentMedia', handleMediaChange);

    state.started = true;
    post('health', { status: 'active' });
    // The directory scan touches every chat and contact; keep it off the
    // startup path and out of WhatsApp's first paint.
    scheduleIdle(() => {
      if (!state.started) return;
      buildNameDirectory();
    });
    // Catch messages WhatsApp loaded before the 'add' subscription existed.
    scheduleCatchUp();
    return true;
  }

  function start() {
    if (timer || state.started) return;
    let attemptIndex = 0;
    let readyAt = 0;
    const attempt = () => {
      timer = null;
      const hasRequire = typeof window.require === 'function';
      const ready = hasRequire && loaderReady();
      if (ready) {
        if (!readyAt) readyAt = Date.now();
        try {
          if (tryInit()) return;
        } catch (e) {
          lastError = 'init-failed: ' + String(e && e.message ? e.message : e).slice(0, 160);
        }
        if (Date.now() - readyAt > RETRY_WINDOW_MS) {
          post('health', { status: 'hook-timeout', error: lastError });
          return;
        }
      }
      let delay = READY_POLL_MS;
      if (ready) {
        delay = RETRY_BACKOFF_MS[Math.min(attemptIndex, RETRY_BACKOFF_MS.length - 1)];
        attemptIndex++;
      }
      timer = setTimeout(attempt, delay);
    };
    attempt();
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (mediaTimer) {
      clearTimeout(mediaTimer);
      mediaTimer = null;
    }
    mediaQueue.length = 0;
    mediaCaptured.clear();
    mediaSettled.clear();
    mediaInFlight.clear();
    mediaDeferred.clear();
    cancelCatchUpTimers();
    catchUp.queue.length = 0;
    catchUp.seen.clear();
    catchUp.mediaCount = 0;
    bridgeQueue.length = 0;
    bridgeQueueBytes = 0;
    if (bridgeProbeTimer) {
      clearTimeout(bridgeProbeTimer);
      bridgeProbeTimer = null;
    }
    if (bridgeLegacyTimer) {
      clearTimeout(bridgeLegacyTimer);
      bridgeLegacyTimer = null;
    }
    if (bridgePort) {
      try {
        bridgePort.close();
      } catch (e) {
        /* ignore */
      }
      bridgePort = null;
    }
    window.removeEventListener('message', onBridgeWindowMessage);
    bridgeMode = 'failed';
    state.started = false;
  }

  if (TEST_MODE) {
    window.__waArchiveMain = {
      serializeStoreMessage,
      widString,
      start,
      stop,
      state,
      SKIP_TYPES,
      MEDIA_TYPES,
      enqueueMedia,
      captureMedia,
      runCatchUp,
      catchUpState: () => ({
        queued: catchUp.queue.length,
        seen: catchUp.seen.size,
        mediaCount: catchUp.mediaCount,
      }),
      getBridgeMode: () => bridgeMode,
      setConfig(config) {
        applyConfig(config || {});
      },
      setMediaConfig(config) {
        applyMediaConfig(config || {});
      },
    };
  }

  initBridge();
  start();
}
