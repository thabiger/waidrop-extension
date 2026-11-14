/**
 * WAiDrop - Content Script (v2)
 *
 * Read-only DOM capture: observes #main, parses newly added message cells
 * directly with window.WAControlParser and keeps a low-frequency full sweep as
 * a safety net. No WhatsApp UI controls are touched; no DOM nodes are ever
 * sent through runtime messaging (that was the v1 serialization bug).
 *
 * Store records arrive from the MAIN-world hook over a private MessageChannel.
 * The channel is established at document_start and authenticated with a
 * nonce + SHA-256 MAC handshake over a per-session key that this script
 * requests from the background worker (BRIDGE_INIT): the key never appears
 * in the page and never crosses window.postMessage - not even the port
 * carries it, so a page script that steals the transferred port cannot
 * impersonate either side. Every post-handshake frame is additionally MAC'd
 * and sequence-numbered with that key, so the port thief cannot forge
 * records, media or config. Without MessageChannel the bridge fails and DOM
 * capture keeps working.
 */
(async function () {
  'use strict';

  const consent = window.WAConsent;
  if (!consent) {
    console.warn('[WAiDrop] consent module not loaded - content script disabled');
    return;
  }
  if (!(await consent.waitForConsent())) return;

  const DEBUG = false;
  const SWEEP_DEBOUNCE_MS = 250;
  const MIN_SWEEP_INTERVAL_MS = 250;
  const FULL_SWEEP_MS = 5000;
  const MAIN_CHECK_DEBOUNCE_MS = 500;
  const SEEN_LIMIT = 5000;
  const FLUSH_DEBOUNCE_MS = 800;
  const STORE_FLUSH_DEBOUNCE_MS = 100;
  const FLUSH_RETRY_MS = 1000;
  const FLUSH_RETRY_MAX_MS = 30000;
  const FLUSH_ACK_TIMEOUT_MS = 15000;
  const FLUSH_AT = 25;

  // The bridge key is a per-session random secret minted by the background
  // worker (BRIDGE_INIT) and injected into the MAIN-world hook via
  // chrome.scripting args. It is used only inside SHA-256 MACs, so it is
  // never transmitted - not over window.postMessage, not even over the port.
  const BRIDGE_KEY_TIMEOUT_MS = 8000;
  const BRIDGE_KEY_RETRY_MS = 1000;
  const BRIDGE_RETRY_MS = 700;
  const BRIDGE_MAX_ATTEMPTS = 4;
  const BRIDGE_HANDSHAKE_TIMEOUT_MS = 1000;

  const Parser = window.WAControlParser;
  if (!Parser) {
    console.warn('[WAiDrop] parser not loaded - content script disabled');
    return;
  }

  if (DEBUG) console.log('[WAiDrop] Content script loaded (v2)');

  const seen = new Set();
  const storeSeen = new Set();
  const pendingCells = new Set();
  const chatDirectory = new Map();
  const CHAT_DIRECTORY_LIMIT = 4000;
  let mainEl = null;
  let shellEl = null;
  let mainCheckTimer = null;
  let fullSweepInterval = null;
  let lastSweepAt = 0;
  let lastFullSweepAt = 0;
  let fullSweepRequested = false;
  let pending = [];
  let sweepTimer = null;
  let flushTimer = null;
  let retryTimer = null;
  let retryDelay = FLUSH_RETRY_MS;
  let flushInFlight = false;
  let flushAgain = false;

  let bridgeMode = 'probing';
  let bridgePort = null;
  let pendingConfig = null;
  let bridgeSessionKey = null;
  let bridgeInSeq = 0;
  let bridgeOutSeq = 0;
  let bridgeInChain = Promise.resolve();

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

  // MAC over the per-session bridge key. Inputs are ASCII (hex key, hex
  // nonces), so byte-wise encoding is exact and TextEncoder is not needed.
  // The key itself is never returned or transmitted - only this digest.
  // Must stay identical to macHex() in background/inject-main.js.
  function macHex(label, key, ...nonces) {
    return new Promise((resolve, reject) => {
      try {
        const input = ['wd-bridge/v1', label, key, ...nonces].join('|');
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

  // Canonical payload tag for post-handshake message MACs. Binary media
  // bytes are represented by their byteLength: a stolen port cannot forge a
  // frame without the key, and sequence numbers make replays fail. Must stay
  // identical to bridgePayloadTag() in background/inject-main.js.
  function bridgePayloadTag(payload) {
    try {
      if (!payload || typeof payload !== 'object') return String(payload);
      if (payload.bytes && typeof payload.bytes.byteLength === 'number') {
        const size = payload.bytes.byteLength;
        const rest = { ...payload };
        delete rest.bytes;
        return JSON.stringify(rest) + '|bytes:' + size;
      }
      return JSON.stringify(payload);
    } catch (e) {
      return 'unserializable';
    }
  }

  const MEDIA_CHUNK_CHARS = 256 * 1024;
  let mediaPort = null;
  let mediaSeq = 0;
  const mediaOutstanding = new Map();

  function resolveMediaMode(settings) {
    if (window.WAMediaSettings && typeof window.WAMediaSettings.resolveMediaMode === 'function') {
      return window.WAMediaSettings.resolveMediaMode(settings);
    }
    const value = settings || {};
    if (value.mediaMode === 'off' || value.mediaMode === 'passive' || value.mediaMode === 'active') return value.mediaMode;
    if (value.mediaCaptureEnabled === false) return 'off';
    if (value.mediaActiveFetchEnabled === true) return 'active';
    return 'passive';
  }

  // Fail closed: when the build-flag object is missing or malformed the
  // stricter capability is disabled, never silently enabled.
  function allowViewOnceCapture() {
    const flags = window.WABuildFlags;
    return !!flags && flags.allowViewOnceCapture === true;
  }

  function allowActiveMediaDownloads() {
    if (window.WAMediaSettings && typeof window.WAMediaSettings.activeMediaAllowed === 'function') {
      return window.WAMediaSettings.activeMediaAllowed();
    }
    const flags = window.WABuildFlags;
    return !!flags && flags.allowActiveMediaDownloads === true;
  }

  function mainConfigFrom(settings) {
    const value = settings || {};
    const mode = resolveMediaMode(value);
    return {
      media: {
        enabled: mode !== 'off',
        captureViewOnce: allowViewOnceCapture() && value.mediaCaptureViewOnce === true,
        activeFetch: mode === 'active' && allowActiveMediaDownloads(),
        maxBytes: Number(value.mediaMaxBytes) > 0 ? Number(value.mediaMaxBytes) : 20 * 1024 * 1024,
        recentMs: Number(value.mediaRecentMs) >= 0 ? Number(value.mediaRecentMs) : 24 * 60 * 60 * 1000,
      },
      catchUp: true,
    };
  }

  async function pushMediaConfig() {
    let settings = {};
    try {
      const result = await chrome.storage.local.get(['settings']);
      settings = result.settings || {};
    } catch (e) {
      /* defaults */
    }
    try {
      sendConfig(mainConfigFrom(settings));
    } catch (e) {
      /* ignore */
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function getMediaPort() {
    if (mediaPort) return mediaPort;
    try {
      mediaPort = chrome.runtime.connect({ name: 'waidrop-media' });
    } catch (e) {
      return null;
    }
    mediaPort.onMessage.addListener((message) => {
      if (!message || message.type !== 'MEDIA_ACK') return;
      const entry = mediaOutstanding.get(message.id);
      if (!entry) return;
      mediaOutstanding.delete(message.id);
      if (message.ok === false) {
        if (entry.attempts < 1) {
          transmitMedia(message.id, entry.meta, entry.base64, entry.attempts + 1);
        } else {
          sendMediaStatus({
            msgId: entry.meta.msgId,
            chatId: entry.meta.chatId,
            status: 'failed',
            error: message.error || 'media upload failed',
          });
        }
      }
    });
    mediaPort.onDisconnect.addListener(() => {
      mediaPort = null;
    });
    return mediaPort;
  }

  function transmitMedia(id, meta, base64, attemptNumber) {
    const port = getMediaPort();
    if (!port) {
      mediaOutstanding.delete(id);
      return;
    }
    mediaOutstanding.set(id, { meta, base64, attempts: attemptNumber });
    try {
      port.postMessage({ type: 'MEDIA_BEGIN', id, ...meta, totalChars: base64.length });
      for (let offset = 0; offset < base64.length; offset += MEDIA_CHUNK_CHARS) {
        port.postMessage({ type: 'MEDIA_CHUNK', id, data: base64.slice(offset, offset + MEDIA_CHUNK_CHARS) });
      }
      port.postMessage({ type: 'MEDIA_END', id });
    } catch (e) {
      mediaOutstanding.delete(id);
      if (attemptNumber < 1) {
        setTimeout(() => transmitMedia(id, meta, base64, attemptNumber + 1), 1000);
      } else {
        sendMediaStatus({
          msgId: meta.msgId,
          chatId: meta.chatId,
          status: 'failed',
          error: e && e.message ? e.message : 'media send failed',
        });
      }
      return;
    }

    setTimeout(() => {
      const entry = mediaOutstanding.get(id);
      if (!entry || entry.attempts !== attemptNumber) return;
      mediaOutstanding.delete(id);
      if (attemptNumber < 1) transmitMedia(id, meta, base64, attemptNumber + 1);
      else {
        sendMediaStatus({
          msgId: meta.msgId,
          chatId: meta.chatId,
          status: 'failed',
          error: 'media upload timed out',
        });
      }
    }, 60000);
  }

  function sendMedia(payload) {
    let bytes;
    try {
      bytes = payload.bytes instanceof ArrayBuffer ? new Uint8Array(payload.bytes) : new Uint8Array(payload.bytes || []);
    } catch (e) {
      return;
    }
    if (!bytes.length) return;

    const base64 = bytesToBase64(bytes);
    const id = `${payload.msgId}:${Date.now()}:${mediaSeq++}`;
    const meta = {
      msgId: payload.msgId,
      chatId: payload.chatId || null,
      kind: payload.kind || null,
      mime: payload.mime || null,
      ts: payload.ts || null,
      size: payload.size || bytes.length,
      width: payload.width || null,
      height: payload.height || null,
      sha256: payload.sha256 || null,
    };

    transmitMedia(id, meta, base64, 0);
  }

  function sendMediaStatus(payload) {
    if (!payload || !payload.msgId) return;
    try {
      chrome.runtime.sendMessage({ type: 'MEDIA_STATUS', ...payload }, () => {
        if (chrome.runtime.lastError) {
          /* background asleep; best effort */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  function remember(set, id) {
    if (!id) return;
    set.add(id);
    if (set.size <= SEEN_LIMIT) return;
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }

  function scheduleSweep(delayMs, full) {
    if (full) fullSweepRequested = true;
    if (sweepTimer) return;
    const base = delayMs == null ? SWEEP_DEBOUNCE_MS : delayMs;
    const wait = Math.max(base, MIN_SWEEP_INTERVAL_MS - (Date.now() - lastSweepAt));
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      sweep();
    }, wait);
  }

  function rememberChat(entry) {
    if (!entry || !entry.chatId) return;
    chatDirectory.set(entry.chatName || entry.chatId, entry);
    if (chatDirectory.size > CHAT_DIRECTORY_LIMIT) {
      const oldest = chatDirectory.keys().next().value;
      if (oldest !== undefined) chatDirectory.delete(oldest);
    }
  }

  function enrichRecord(record) {
    if (!record) return record;
    const entry = chatDirectory.get(record.chatName);
    if (!entry) return record;
    if (!record.chatId) {
      if (entry.chatId) record.chatId = entry.chatId;
      if (typeof entry.isGroup === 'boolean') record.isGroup = entry.isGroup;
    } else if (record.isGroup == null && entry.isGroup === true) {
      record.isGroup = true;
    }
    if (!record.chatPhone && entry.chatPhone) record.chatPhone = entry.chatPhone;
    if (!record.chatPushname && entry.chatPushname) record.chatPushname = entry.chatPushname;
    return record;
  }

  function parseCell(cell, ctx) {
    const row = cell.closest('[role="row"]') || cell;
    const msgId = Parser.messageIdFromCell(cell);
    if (!msgId || seen.has(msgId)) return false;
    if (cell.querySelector('[data-virtualized="true"]')) return false;
    if (Parser.isSystemRow(row)) {
      remember(seen, msgId);
      return false;
    }
    const record = enrichRecord(Parser.parseMessageRow(row, ctx));
    if (!record) return false;
    remember(seen, msgId);
    pending.push(record);
    return true;
  }

  function sweep() {
    lastSweepAt = Date.now();
    const main = mainEl && mainEl.isConnected ? mainEl : document.querySelector('#main');
    if (!main) return;
    if (main !== mainEl) ensureMainObserver();
    const ctx = Parser.getChatContext(main);
    let added = 0;

    if (pendingCells.size) {
      const cells = [...pendingCells];
      pendingCells.clear();
      for (const cell of cells) {
        if (!cell.isConnected) continue;
        if (parseCell(cell, ctx)) added++;
      }
    }

    if (fullSweepRequested || Date.now() - lastFullSweepAt >= FULL_SWEEP_MS) {
      fullSweepRequested = false;
      lastFullSweepAt = Date.now();
      const cells = main.querySelectorAll('[data-testid^="conv-msg-"]');
      for (const cell of cells) {
        if (parseCell(cell, ctx)) added++;
      }
    }

    if (added) scheduleFlush();
  }

  function scheduleFlush(delayMs) {
    if (pending.length >= FLUSH_AT) {
      flush();
      return;
    }
    if (flushTimer) {
      if (delayMs == null || delayMs >= FLUSH_DEBOUNCE_MS) return;
      clearTimeout(flushTimer);
    }
    const delay = delayMs == null ? FLUSH_DEBOUNCE_MS : delayMs;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, delay);
  }

  function scheduleRetry() {
    if (retryTimer || flushTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, FLUSH_RETRY_MAX_MS);
  }

  function requeue(records) {
    const known = new Set(pending.map((record) => record.msgId));
    const missing = records.filter((record) => !known.has(record.msgId));
    pending = missing.concat(pending);
  }

  function flush() {
    if (flushInFlight) {
      flushAgain = true;
      return;
    }
    if (!pending.length) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    const records = pending;
    pending = [];
    const storeCount = records.filter((record) => record.source === 'store').length;
    flushInFlight = true;

    let settled = false;
    let ackTimer = null;
    const finish = (ok, response) => {
      if (settled) return;
      settled = true;
      if (ackTimer) clearTimeout(ackTimer);
      flushInFlight = false;

      if (ok) {
        retryDelay = FLUSH_RETRY_MS;
        const stats = response && response.stats;
        const summary = stats
          ? ` (${stats.inserted || 0} new, ${stats.upgraded || 0} upgraded, ${stats.updated || 0} updated, ${stats.skipped || 0} skipped)`
          : '';
        if (DEBUG) console.log('[WAiDrop] stored', records.length, 'record(s)' + summary);
      } else {
        requeue(records);
        scheduleRetry();
      }

      if (pending.length || flushAgain) {
        flushAgain = false;
        scheduleFlush();
      }
    };

    ackTimer = setTimeout(() => {
      if (DEBUG) console.warn('[WAiDrop] no archive acknowledgement; will retry');
      finish(false);
    }, FLUSH_ACK_TIMEOUT_MS);

    try {
      chrome.runtime.sendMessage({ type: 'MESSAGE_BATCH', records }, (response) => {
        if (chrome.runtime.lastError) {
          if (DEBUG) {
            console.warn(
              '[WAiDrop] batch send failed, will retry:',
              chrome.runtime.lastError.message
            );
          }
          finish(false);
          return;
        }
        if (!response || response.status === 'error') {
          if (DEBUG) {
            console.warn(
              '[WAiDrop] batch was not stored, will retry:',
              response && response.error ? response.error : 'no acknowledgement'
            );
          }
          finish(false);
          return;
        }
        finish(true, response);
      });
      if (DEBUG) {
        console.log(
          '[WAiDrop] captured',
          records.length,
          `record(s) (store: ${storeCount}, dom: ${records.length - storeCount}); session total`,
          seen.size
        );
      }
    } catch (e) {
      if (DEBUG) console.warn('[WAiDrop] batch send threw, will retry:', e && e.message);
      finish(false);
    }
  }

  // Store-hook records (MAIN world) enter the same pipeline; a store record
  // supersedes a same-msgId DOM record that has not been flushed yet.
  function handleMainMessage(data) {
    if (!data) return;

    if (data.kind === 'health') {
      if (DEBUG) {
        const status = data.payload && data.payload.status;
        console.log(
          '[WAiDrop] store hook health:',
          status,
          data.payload && data.payload.error ? data.payload.error : ''
        );
      }
      return;
    }
    if (data.kind === 'media-status') {
      sendMediaStatus(data.payload);
      return;
    }
    if (data.kind === 'media') {
      sendMedia(data.payload);
      return;
    }
    if (data.kind === 'directory') {
      const chats = data.payload && Array.isArray(data.payload.chats) ? data.payload.chats : null;
      if (chats && chats.length) {
        for (const chat of chats) rememberChat(chat);
        try {
          chrome.runtime.sendMessage({ type: 'NAME_DIRECTORY', chats }, () => {
            if (chrome.runtime.lastError) {
              /* background asleep; directory is best effort */
            }
          });
          if (DEBUG) console.log('[WAiDrop] name directory sent:', chats.length, 'chat(s)');
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }
    if (data.kind !== 'message' || !data.payload || !data.payload.msgId) return;

    const record = enrichRecord(data.payload);
    if (storeSeen.has(record.msgId)) return;
    remember(storeSeen, record.msgId);

    const pendingIndex = pending.findIndex((r) => r.msgId === record.msgId);
    if (pendingIndex !== -1) pending.splice(pendingIndex, 1);

    remember(seen, record.msgId);
    pending.push(record);
    scheduleFlush(STORE_FLUSH_DEBOUNCE_MS);
  }

  function handleBridgePortMessage(event) {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (typeof data.kind !== 'string' || !Number.isInteger(data.seq) || typeof data.mac !== 'string') return;
    const frame = data;
    // Frames are verified and processed strictly in arrival order so the
    // replay counter stays monotonic even while MAC digests are in flight.
    bridgeInChain = bridgeInChain
      .then(async () => {
        if (bridgeMode !== 'port' || !bridgeSessionKey) return;
        if (frame.seq <= bridgeInSeq) return;
        const expected = await macHex(
          'h2c',
          bridgeSessionKey,
          String(frame.seq),
          frame.kind,
          bridgePayloadTag(frame.payload)
        );
        if (expected !== frame.mac || frame.seq <= bridgeInSeq) return;
        bridgeInSeq = frame.seq;
        handleMainMessage(frame);
      })
      .catch(() => {});
  }

  function sendConfig(config) {
    if (!config) return;
    if (bridgeMode === 'port' && bridgePort && bridgeSessionKey) {
      const seq = ++bridgeOutSeq;
      const frame = { type: 'config', media: config.media, catchUp: config.catchUp, seq };
      macHex('c2h', bridgeSessionKey, String(seq), 'config', bridgePayloadTag({ media: frame.media, catchUp: frame.catchUp }))
        .then((mac) => {
          if (bridgeMode !== 'port' || !bridgePort) return;
          try {
            bridgePort.postMessage({ ...frame, mac });
          } catch (e) {
            /* the hook keeps its last verified config */
          }
        })
        .catch(() => {});
      return;
    }
    pendingConfig = config;
  }

  function markBridgeFailed(reason) {
    bridgeMode = 'failed';
    const detail = reason ? ` (${reason})` : '';
    try {
      console.warn(`[WAiDrop] private store bridge unavailable${detail}; DOM capture only`);
    } catch (e) {
      /* console is unavailable in some embedded contexts */
    }
  }

  // Ask the background worker for this tab's per-session bridge key. The
  // worker also (re)injects the MAIN-world hook with the same key via
  // chrome.scripting args; both endpoints then hold a secret that never
  // existed anywhere in the page or the extension source.
  function requestBridgeKey() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (key, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ key: key || null, error: error || null });
      };
      const timer = setTimeout(() => finish(null, 'key-request-timeout'), BRIDGE_KEY_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: 'BRIDGE_INIT' }, (response) => {
          if (chrome.runtime.lastError) {
            finish(null, chrome.runtime.lastError.message || 'bridge-init-failed');
            return;
          }
          const key =
            response && response.status === 'ok' && typeof response.bridgeKey === 'string' && response.bridgeKey
              ? response.bridgeKey
              : null;
          if (key) {
            finish(key, null);
            return;
          }
          const reason =
            response && typeof response.error === 'string' && response.error
              ? response.error
              : response && typeof response.status === 'string' && response.status
                ? `bridge-init-${response.status}`
                : 'bridge-init-no-key';
          finish(null, reason);
        });
      } catch (e) {
        finish(null, e && e.message ? e.message : 'bridge-init-threw');
      }
    });
  }

  async function initBridge() {
    try {
      if (typeof MessageChannel !== 'function') {
        markBridgeFailed('message-channel-unavailable');
        return;
      }
      if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
        markBridgeFailed('subtle-crypto-unavailable');
        return;
      }
      let result = await requestBridgeKey();
      if (!result.key) {
        // Fast failure (worker asleep, closed channel): one short retry.
        await new Promise((resolve) => setTimeout(resolve, BRIDGE_KEY_RETRY_MS));
        result = await requestBridgeKey();
      }
      if (result.key) connectBridge(result.key);
      else markBridgeFailed(result.error || 'no-bridge-key');
    } catch (e) {
      markBridgeFailed(e && e.message ? e.message : 'bridge-init-failed');
    }
  }

  function connectBridge(bridgeKey) {
    let attempts = 0;
    let connected = false;

    const attempt = () => {
      if (connected) return;
      if (attempts >= BRIDGE_MAX_ATTEMPTS) {
        markBridgeFailed('handshake-timeout');
        return;
      }
      attempts++;

      let channel;
      try {
        channel = new MessageChannel();
      } catch (e) {
        markBridgeFailed('message-channel-unavailable');
        return;
      }

      const port = channel.port1;
      let closed = false;
      let myNonce = null;

      const retryTimer = setTimeout(() => {
        if (connected || closed) return;
        closed = true;
        try {
          port.close();
        } catch (e) {
          /* ignore */
        }
        setTimeout(attempt, BRIDGE_RETRY_MS);
      }, BRIDGE_HANDSHAKE_TIMEOUT_MS);

      port.onmessage = (event) => {
        if (connected || closed) return;
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;
        // Challenge from the MAIN-world hook: answer with a MAC over the
        // key and a fresh nonce. The key itself is never sent - not even to
        // a script that stole the transferred port.
        if (data.ok === undefined && typeof data.c === 'string' && data.n === undefined) {
          myNonce = randomId();
          macHex('reply', bridgeKey, data.c, myNonce)
            .then((m1) => {
              if (connected || closed) return;
              try {
                port.postMessage({ c: data.c, n: myNonce, m1 });
              } catch (e) {
                /* MAIN will retry the handshake */
              }
            })
            .catch(() => {});
          return;
        }
        // Acknowledgement: the hook must prove possession of the same key
        // with a MAC over our nonce.
        if (data.ok === 1 && typeof data.n === 'string' && typeof data.m2 === 'string' && data.n === myNonce) {
          macHex('ack', bridgeKey, data.n)
            .then((expected) => {
              if (connected || closed || expected !== data.m2) return;
              connected = true;
              clearTimeout(retryTimer);
              bridgePort = port;
              bridgeMode = 'port';
              bridgeSessionKey = bridgeKey;
              port.onmessage = handleBridgePortMessage;
              if (pendingConfig) {
                const config = pendingConfig;
                pendingConfig = null;
                sendConfig(config);
              }
            })
            .catch(() => {});
        }
      };

      try {
        port.start();
      } catch (e) {
        /* assigning onmessage also starts the port in Chrome */
      }
      try {
        window.postMessage({}, window.location.origin, [channel.port2]);
      } catch (e) {
        closed = true;
        clearTimeout(retryTimer);
        try {
          port.close();
        } catch (err) {
          /* ignore */
        }
        setTimeout(attempt, BRIDGE_RETRY_MS);
      }
    };

    attempt();
  }

  initBridge().catch((e) => markBridgeFailed(e && e.message ? e.message : 'bridge-init-failed'));

  const mainObserver = new MutationObserver((records) => {
    let addedCells = false;
    let other = false;
    for (const record of records) {
      if (record.type !== 'childList') continue;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('[data-testid^="conv-msg-"]')) {
          pendingCells.add(node);
          addedCells = true;
        } else if (node.querySelector) {
          const cells = node.querySelectorAll('[data-testid^="conv-msg-"]');
          if (cells.length) {
            for (const cell of cells) pendingCells.add(cell);
            addedCells = true;
          } else {
            other = true;
          }
        } else {
          other = true;
        }
      }
    }
    if (addedCells) scheduleSweep(150);
    if (other && Date.now() - lastFullSweepAt >= FULL_SWEEP_MS) scheduleSweep(0, true);
  });

  const shellObserver = new MutationObserver((records) => {
    if (mainEl) {
      let relevant = false;
      for (const record of records) {
        if (record.target === mainEl || mainEl.contains(record.target)) continue;
        relevant = true;
        break;
      }
      if (!relevant) return;
    }
    scheduleMainCheck();
  });

  function ensureShellObserver() {
    const root = document.querySelector('#app') || document.documentElement;
    if (!root || root === shellEl) return;
    shellObserver.disconnect();
    shellEl = root;
    shellObserver.observe(shellEl, { childList: true, subtree: true });
  }

  function scheduleMainCheck() {
    if (mainCheckTimer) return;
    mainCheckTimer = setTimeout(() => {
      mainCheckTimer = null;
      ensureMainObserver();
    }, MAIN_CHECK_DEBOUNCE_MS);
  }

  function ensureMainObserver() {
    ensureShellObserver();
    const main = document.querySelector('#main');
    if (main === mainEl) return;
    mainObserver.disconnect();
    mainEl = main;
    pendingCells.clear();
    if (!mainEl) {
      if (fullSweepInterval) {
        clearInterval(fullSweepInterval);
        fullSweepInterval = null;
      }
      return;
    }
    mainObserver.observe(mainEl, { childList: true, subtree: true });
    if (!fullSweepInterval) {
      fullSweepInterval = setInterval(() => scheduleSweep(0, true), FULL_SWEEP_MS);
    }
    scheduleSweep(0, true);
  }

  function startObserving() {
    ensureShellObserver();
    ensureMainObserver();
    if (DEBUG) console.log('[WAiDrop] DOM observers attached');
  }

  if (document.documentElement) startObserving();
  else window.addEventListener('DOMContentLoaded', startObserving);

  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }, () => {
      if (chrome.runtime.lastError) {
        /* background asleep; harmless */
      }
    });
  } catch (e) {
    /* ignore */
  }

  pushMediaConfig();
  setTimeout(pushMediaConfig, 1000);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) pushMediaConfig();
    });
  } catch (e) {
    /* storage events unavailable */
  }
})();
