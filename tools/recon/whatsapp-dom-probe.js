/**
 * WhatsApp Web DOM + Store probe v2 (read-only).
 *
 * HOW TO USE
 *   1. Open https://web.whatsapp.com in Chrome, log in, OPEN A CHAT.
 *   2. Open DevTools (F12) -> Console.
 *   3. Paste this whole file, press Enter.
 *   4. The report is logged, copied to the clipboard, and exposed as
 *      window.__waDomProbeReport.
 *   5. Save it to tools/recon/out/dom-probe.json (DM run) and
 *      tools/recon/out/dom-probe-group.json (group run). Never commit that dir.
 *
 * CHANGELOG v2 (2026-10-17)
 *   - Current builds (seen on 2.3000.1050712378) no longer render
 *     div.message-in / div.message-out or [data-testid="msg-text"].
 *     Rows are [role="row"][data-id] (mostly [data-testid="msg-container"]),
 *     so samples come from those anchors. Direction is guessed from geometry
 *     and reported alongside the data-id prefix (true_/false_).
 *   - Store access: probes window.mR (module registry used by modern
 *     whatsapp-web.js) first; keeps the webpack chunk-push capture as fallback.
 *
 * WHAT IT DOES
 *   - Counts candidate DOM selectors so we know which anchors survive.
 *   - Sanitized snapshots of the newest message rows (text -> «t:N» placeholders,
 *     numbers masked, titles redacted) for building test fixtures.
 *   - Reports how the header exposes the current chat.
 *   - Reports whether window.mR / the webpack registry can reach WhatsApp Store
 *     modules (WAWebCollections etc.) for the read-only store hook in M4.
 *
 *   Nothing on the WhatsApp side is mutated. The only "trick" used is the
 *   standard webpack chunk-push capture to obtain the module require function.
 */
(() => {
  'use strict';

  const report = {
    probe: 'whatsapp-dom-probe',
    version: 2,
    at: new Date().toISOString(),
    location: {
      pathname: window.location.pathname,
      search: window.location.search.replace(/\d{4,}/g, (m) => m.slice(0, 2) + '#'.repeat(Math.max(0, m.length - 4))),
      title: `«title:${(document.title || '').length}»`,
    },
    waDebug: null,
    loggedIn: false,
    selectorReport: {},
    samples: {},
    panel: {},
    header: {},
    paneSide: {},
    localKeys: [],
    store: {},
    errors: [],
  };

  try {
    const dbg = window.Debug;
    if (dbg) {
      report.waDebug = {
        VERSION: typeof dbg.VERSION === 'string' ? dbg.VERSION : typeof dbg.VERSION,
        BUILD: typeof dbg.BUILD === 'string' ? dbg.BUILD : typeof dbg.BUILD,
        keys: Object.keys(dbg).slice(0, 40),
      };
    }
  } catch (e) {
    report.errors.push('debug: ' + String(e));
  }

  // --- sanitization helpers -------------------------------------------------
  const cap = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const maskDigits = (s) => s.replace(/\d/g, '#');
  const maskId = (s) =>
    s.replace(/\d{4,}/g, (m) => m.slice(0, 2) + '#'.repeat(Math.max(0, m.length - 4)) + m.slice(-2));
  const escapeAttr = (s) => s.replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const sanitizeValue = (name, value) => {
    let v = String(value == null ? '' : value);
    if (name === 'data-pre-plain-text') return maskDigits(v).replace(/\]\s[\s\S]*$/, '] «sender»');
    if (name === 'data-id') return maskId(v);
    if (name === 'class') return cap(v, 300);
    if (name === 'title' || name === 'aria-label' || name === 'alt') return `«${name}:${v.length}»`;
    if (name === 'style') return cap(v, 80);
    if (name === 'src') return cap(v, 60);
    return cap(maskId(v), 160);
  };

  const sanitizeNode = (node, depth = 0) => {
    if (!node) return '';
    if (node.nodeType === 3) {
      const t = (node.textContent || '').trim();
      return t ? `«t:${t.length}»` : '';
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'svg') return `<${tag}/>`;
    const attrs = [];
    for (const a of node.attributes) attrs.push(` ${a.name}="${escapeAttr(sanitizeValue(a.name, a.value))}"`);
    if (depth >= 14) return `<${tag}${attrs.join('')}>…</${tag}>`;
    const kids = [];
    for (const c of node.childNodes) kids.push(sanitizeNode(c, depth + 1));
    return `<${tag}${attrs.join('')}>${kids.join('')}</${tag}>`;
  };

  const cls = (el) => cap(typeof el.className === 'string' ? el.className : '', 200);
  const rectInfo = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
    } catch {
      return null;
    }
  };

  // --- selector report ------------------------------------------------------
  const SELECTORS = [
    '#app', '#side', '#pane-side', '#main',
    // legacy anchors (expected 0 on current builds - kept to track change)
    'div.message-in', 'div.message-out', '[data-testid="msg-text"]',
    // current message anchors
    '#main [data-testid="conversation-panel-messages"]',
    '#main [data-testid="msg-container"]',
    '#main [role="row"]',
    '#main [role="row"][data-id]',
    '#main [data-pre-plain-text]',
    '#main .copyable-text', '#main .selectable-text',
    // header / lists
    '#main header', '#main [data-testid="conversation-info-header-chat-title"]',
    '#main [data-testid="chat-subtitle"]',
    '[data-testid="chat-list"]', '[data-testid="cell-frame-container"]', '[data-testid^="list-item-"]',
    'footer div[contenteditable="true"]',
  ];
  for (const sel of SELECTORS) {
    try {
      report.selectorReport[sel] = document.querySelectorAll(sel).length;
    } catch (e) {
      report.selectorReport[sel] = 'ERR';
    }
  }

  const main = document.querySelector('#main');
  report.loggedIn = !!main;
  if (!main) {
    report.errors.push('no #main found - open a chat and run the probe again');
  }

  // --- message row samples --------------------------------------------------
  const mainRect = main ? rectInfo(main) : null;

  const dataIdPrefix = (raw) => {
    if (!raw) return null;
    if (raw.startsWith('true_')) return 'true';
    if (raw.startsWith('false_')) return 'false';
    return 'other';
  };

  const ancestryOf = (el, max) => {
    const out = [];
    let cur = el.parentElement;
    let d = 0;
    while (cur && d < max) {
      out.push({
        tag: cur.tagName ? cur.tagName.toLowerCase() : '?',
        classes: cls(cur),
        role: cur.getAttribute ? cur.getAttribute('role') : null,
      });
      cur = cur.parentElement;
      d++;
    }
    return out;
  };

  const sampleRow = (row, indexFromEnd) => {
    const bubble =
      row.matches && row.matches('[data-testid="msg-container"]')
        ? row
        : row.querySelector('[data-testid="msg-container"]') || row;
    const rowRect = rectInfo(row);
    const bubbleRect = rectInfo(bubble);

    let directionGuess = 'unknown';
    if (mainRect && bubbleRect && mainRect.width > 0) {
      const leftGap = bubbleRect.left - mainRect.left;
      const rightGap = mainRect.right - bubbleRect.right;
      if (leftGap > rightGap * 1.5) directionGuess = 'outgoing?';
      else if (rightGap > leftGap * 1.5) directionGuess = 'incoming?';
      else directionGuess = 'centered/system?';
    }

    const attrs = {};
    for (const name of ['data-id', 'data-pre-plain-text', 'aria-label', 'role', 'data-testid']) {
      const val = row.getAttribute(name);
      if (val != null) attrs[name] = sanitizeValue(name, val);
    }
    const rawId = row.getAttribute('data-id');

    const prePlain = row.querySelector('[data-pre-plain-text]');

    let parentStyle = null;
    try {
      const parent = bubble.parentElement;
      if (parent) {
        const cs = window.getComputedStyle(parent);
        parentStyle = { justifyContent: cs.justifyContent, alignItems: cs.alignItems, classes: cls(parent) };
      }
    } catch {
      /* ignore */
    }
    let bubbleStyle = null;
    try {
      const cs = window.getComputedStyle(bubble);
      bubbleStyle = { marginLeft: cs.marginLeft, marginRight: cs.marginRight, alignSelf: cs.alignSelf };
    } catch {
      /* ignore */
    }

    return {
      indexFromEnd,
      tag: row.tagName.toLowerCase(),
      classes: cls(row),
      attrs,
      dataIdPrefix: dataIdPrefix(rawId),
      isMsgContainer: !!(row.matches && row.matches('[data-testid="msg-container"]')),
      bubbleClasses: cls(bubble),
      parentStyle,
      bubbleStyle,
      directionGuess,
      rowRect,
      bubbleRect,
      mainRect,
      hasDataPrePlain: !!prePlain,
      prePlainMasked: prePlain
        ? sanitizeValue('data-pre-plain-text', prePlain.getAttribute('data-pre-plain-text') || '')
        : null,
      dataTestidsInRow: [...row.querySelectorAll('[data-testid]')]
        .map((el) => el.getAttribute('data-testid'))
        .slice(0, 20),
      descendantDataIds: [...row.querySelectorAll('[data-id]')]
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute('data-testid') || '',
          value: maskId(el.getAttribute('data-id') || ''),
        }))
        .slice(0, 5),
      spanTitlesInRow: [...row.querySelectorAll('span[title]')]
        .map((el) => `«title:${(el.getAttribute('title') || '').length}»`)
        .slice(0, 10),
      ancestry: ancestryOf(row, 6),
      sanitizedHTML: cap(sanitizeNode(row), 20000),
    };
  };

  if (main) {
    const roleRows = [...main.querySelectorAll('[role="row"]')];
    const containerRows = roleRows.length ? [] : [...main.querySelectorAll('[data-testid="msg-container"]')];
    const nodes = roleRows.length ? roleRows : containerRows;
    report.samples.rowSource = roleRows.length ? '[role="row"]' : '[data-testid="msg-container"]';
    report.samples.rowCount = nodes.length;
    const lastN = nodes.slice(-6);
    report.samples.rows = lastN.map((n, i) => sampleRow(n, lastN.length - 1 - i));
  }

  // --- scroll container (virtualization check) -------------------------------
  try {
    const panel = main ? main.querySelector('[data-testid="conversation-panel-messages"]') : null;
    if (panel) {
      const scroller = panel.firstElementChild || panel;
      report.panel = {
        present: true,
        scrollerClasses: cls(scroller),
        scrollHeight: scroller.scrollHeight || null,
        clientHeight: scroller.clientHeight || null,
      };
    }
  } catch (e) {
    report.errors.push('panel: ' + String(e));
  }

  // --- header (chat identification) ------------------------------------------
  try {
    const header = main ? main.querySelector('header') : null;
    if (header) {
      const titleEl = header.querySelector('[data-testid="conversation-info-header-chat-title"]');
      const subtitleEl = header.querySelector('[data-testid="chat-subtitle"]');
      const titleAttr = titleEl ? titleEl.getAttribute('title') : null;
      report.header = {
        hasHeader: true,
        titleTestidPresent: !!titleEl,
        titleTextLength: titleEl ? (titleEl.textContent || '').length : null,
        titleAttrLength: titleAttr != null ? titleAttr.length : null,
        titleNameTestidPresent: !!header.querySelector('[data-testid="conversation-info-header-chat-title-name"]'),
        subtitleTestidPresent: !!subtitleEl,
        subtitleTextLength: subtitleEl ? (subtitleEl.textContent || '').length : null,
        dataTestids: [...header.querySelectorAll('[data-testid]')]
          .map((el) => el.getAttribute('data-testid'))
          .slice(0, 15),
        sanitized: cap(sanitizeNode(header), 8000),
      };
    }
  } catch (e) {
    report.errors.push('header: ' + String(e));
  }

  // --- pane-side (chat list) sample ------------------------------------------
  try {
    const pane = document.querySelector('#pane-side');
    if (pane) {
      const row = pane.querySelector('[role="row"], [data-testid="cell-frame-container"]');
      report.paneSide = {
        present: true,
        rowCount: pane.querySelectorAll('[role="row"]').length,
        sample: row ? cap(sanitizeNode(row), 6000) : null,
      };
    }
  } catch (e) {
    report.errors.push('pane: ' + String(e));
  }

  // --- storage keys (names only) ---------------------------------------------
  try {
    report.localKeys = Object.keys(window.localStorage).slice(0, 40);
  } catch (e) {
    /* ignore */
  }

  // --- Store probe: window.mR first, webpack chunk-push fallback -------------
  const STORE_MODULES = [
    'WAWebCollections',
    'WAWebChatCollection',
    'WAWebMsgCollection',
    'WAWebContactCollection',
    'WAWebSocketModel',
    'WAWebCmd',
  ];

  const probeChunkPush = () =>
    new Promise((resolve) => {
      const res = { attempted: false, requireCaptured: false, error: null };
      try {
        const names = ['webpackChunkwhatsapp_web_client', 'webpackChunkwhatsapp_web'];
        const globalName = names.find((n) => Array.isArray(window[n]));
        if (!globalName) return resolve(res);
        res.attempted = true;
        res.globalName = globalName;
        res.chunkLenBefore = window[globalName].length;
        window.__waProbeRequire = undefined;
        const capture = (req) => {
          window.__waProbeRequire = req;
        };
        window[globalName].push([[`__wa_probe_${Date.now()}`], {}, capture]);
        window[globalName].push([[Math.floor(Math.random() * 1e9)], {}, capture]);
        setTimeout(() => {
          res.requireCaptured = typeof window.__waProbeRequire === 'function';
          if (res.requireCaptured) {
            res.modules = {};
            for (const name of STORE_MODULES) {
              try {
                const mod = window.__waProbeRequire(name);
                res.modules[name] = mod ? { ok: true, keys: Object.keys(mod).slice(0, 25) } : { ok: false };
              } catch (e) {
                res.modules[name] = { ok: false, err: String(e).slice(0, 140) };
              }
            }
          }
          resolve(res);
        }, 600);
      } catch (e) {
        res.error = String(e).slice(0, 200);
        resolve(res);
      }
    });

  const probeStore = async () => {
    const out = { mR: null, mRModules: {}, require: typeof window.require, chunk: null };
    const mR = window.mR;
    out.mR = {
      present: !!mR,
      type: typeof mR,
      keys: mR && typeof mR === 'object' ? Object.keys(mR).slice(0, 30) : [],
      findModule: mR ? typeof mR.findModule : 'undefined',
      findFunction: mR ? typeof mR.findFunction : 'undefined',
      requireById: mR ? typeof mR.requireById : 'undefined',
    };
    if (mR && typeof mR.findModule === 'function') {
      for (const name of STORE_MODULES) {
        try {
          const res = mR.findModule(name);
          out.mRModules[name] = { ok: Array.isArray(res) && res.length > 0, count: Array.isArray(res) ? res.length : null };
        } catch (e) {
          out.mRModules[name] = { ok: false, err: String(e).slice(0, 140) };
        }
      }
      try {
        const res = mR.findModule((m) => m && m.default && m.default.Chat);
        out.mRModules['predicate:default.Chat'] = {
          ok: Array.isArray(res) && res.length > 0,
          count: Array.isArray(res) ? res.length : null,
        };
      } catch (e) {
        out.mRModules['predicate:default.Chat'] = { ok: false, err: String(e).slice(0, 140) };
      }
    }
    out.chunk = await probeChunkPush();
    return out;
  };

  (async () => {
    report.store = await probeStore();
    window.__waDomProbeReport = report;
    console.log('%c[WA DOM PROBE v2] report:', 'font-weight:bold;color:#25D366', report);
    const json = JSON.stringify(report, null, 2);
    if (typeof copy === 'function') {
      copy(json);
      console.log('[WA DOM PROBE v2] Report JSON copied to clipboard. Save it under tools/recon/out/.');
    } else {
      console.log('[WA DOM PROBE v2] (copy() unavailable - select the object above and copy manually)');
    }
  })();
})();
