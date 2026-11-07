/**
 * WhatsApp Web store-resolver probe (read-only).
 *
 * Paste into the DevTools console on a logged-in https://web.whatsapp.com tab.
 * It inspects the module loader and tries to resolve the Msg/Chat/Contact
 * collections without sending, acknowledging or mutating anything.
 *
 * Requires can execute WhatsApp's own module factories; the probe only reads
 * their exports. Unknown names are skipped when the loader exposes modulesMap.
 */
(async () => {
  'use strict';

  const report = {
    probe: 'whatsapp-store-resolver-probe',
    at: new Date().toISOString(),
    version: (window.Debug && window.Debug.VERSION) || null,
    require: typeof window.require,
    importNamespace: typeof window.importNamespace,
    d: typeof window.__d,
    error: null,
    modules: null,
    tried: {},
    candidates: [],
  };

  const req = typeof window.require === 'function' ? window.require : null;
  const safeRequire = (name) => {
    try {
      return { ok: true, value: req(name) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 160) };
    }
  };

  let modulesMap = null;
  if (req) {
    try {
      if (typeof window.__d !== 'undefined') {
        const debug = safeRequire('__debug');
        if (debug.ok && debug.value && debug.value.modulesMap) modulesMap = debug.value.modulesMap;
      }
    } catch (e) {
      report.error = String(e).slice(0, 160);
    }
  }

  const names = modulesMap ? Object.keys(modulesMap) : null;
  report.modules = names
    ? {
        count: names.length,
        collections: names.filter((name) => /Collection/.test(name)).slice(0, 60),
      }
    : null;

  for (const name of ['WAWebCollections', 'WAWebMsgCollection', 'WAWebChatCollection', 'WAWebContactCollection']) {
    if (names && !names.includes(name)) {
      report.tried[name] = 'skipped (not in modulesMap)';
      continue;
    }
    const result = safeRequire(name);
    report.tried[name] = result.ok
      ? { ok: true, keys: Object.keys(result.value || {}).slice(0, 25) }
      : result;
  }

  if (names && modulesMap) {
    for (const name of names.filter((id) => /^WAWeb.*Collection/.test(id)).slice(0, 30)) {
      const entry = modulesMap[name];
      let exports = entry;
      if (entry && typeof entry === 'object' && typeof entry.factory === 'function') {
        const result = safeRequire(name);
        if (!result.ok) {
          report.candidates.push({ name, error: result.error });
          continue;
        }
        exports = result.value;
      }
      const keys = exports && typeof exports === 'object' ? Object.keys(exports).slice(0, 15) : [];
      report.candidates.push({
        name,
        keys,
        hasMsg: !!(exports && exports.Msg),
        hasChat: !!(exports && exports.Chat),
        hasMsgCollection: !!(exports && exports.MsgCollection),
        hasChatCollection: !!(exports && exports.ChatCollection),
      });
    }
  }

  window.__waStoreProbeReport = report;
  console.log('%c[WA STORE RESOLVER PROBE] report:', 'font-weight:bold;color:#25D366', report);
  const json = JSON.stringify(report, null, 2);
  if (typeof copy === 'function') {
    copy(json);
    console.log('[WA STORE RESOLVER PROBE] JSON copied to clipboard.');
  }
})();
