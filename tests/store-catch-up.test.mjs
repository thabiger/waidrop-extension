/**
 * Store-hook startup catch-up: messages WhatsApp materialized before the
 * 'add' subscription must be read from memory and posted once, without
 * loaders, history requests or media downloads.
 *
 *   node tests/store-catch-up.test.mjs
 */
import { JSDOM } from 'jsdom';
import { startMainHook } from './helpers/main-hook-loader.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function message(id, overrides = {}) {
  return {
    id: { id, _serialized: `false_999@g.us_${id}`, fromMe: false, remote: { _serialized: '999@g.us' } },
    t: 1729166400,
    type: 'chat',
    body: `body ${id}`,
    ...overrides,
  };
}

function makeWindow(globalMessages, chatMessages = []) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
  });
  const posted = [];
  dom.window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'waidrop-main') posted.push(event.data);
  });

  const listeners = {};
  const loaders = { calls: 0 };
  const chat = {
    id: { _serialized: '999@g.us' },
    name: 'Catch-up Group',
    msgs: {
      getModelsArray: () => chatMessages,
      loadMessages: () => {
        loaders.calls++;
      },
      loadEarlierMsgs: () => {
        loaders.calls++;
      },
    },
  };
  const Msg = {
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    off(event, cb) {
      listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
    },
    getModelsArray: () => globalMessages,
    loadMessages: () => {
      loaders.calls++;
    },
  };
  const collections = {
    Msg,
    Chat: { get: (id) => (id === '999@g.us' ? chat : null), getModelsArray: () => [chat] },
    Contact: { get: () => null },
  };

  dom.window.require = (name) => (name === 'WAWebCollections' ? collections : undefined);
  dom.window.__WAIDROP_EXPOSE_TEST_API__ = true;
  // Plain jsdom: the hook takes the legacy postMessage transport.
  startMainHook(dom.window);
  return { dom, posted, loaders, api: dom.window.__waArchiveMain };
}

// --- global + per-chat coverage, dedupe, passive media ----------------------
{
  const mediaBytes = new TextEncoder().encode('catch-up-media');
  const cachedBlob = {
    type: 'image/jpeg',
    size: mediaBytes.length,
    arrayBuffer: async () => mediaBytes.buffer.slice(0),
    forceToBlob: () => cachedBlob,
  };
  let downloads = 0;

  const nowSec = Math.floor(Date.now() / 1000);
  const globalMessages = [
    message('GLOBAL-1'),
    message('DUP-1'),
    message('CATCH-IMG', {
      t: nowSec,
      type: 'image',
      mediaData: { mediaStage: 'RESOLVED', size: mediaBytes.length, mediaBlob: cachedBlob },
      mediaObject: { filehash: 'catch-up-hash' },
      downloadMedia: async () => {
        downloads++;
      },
    }),
    message('CATCH-OLD-IMG', {
      t: nowSec - 2 * 24 * 60 * 60,
      type: 'image',
      mediaData: { mediaStage: 'RESOLVED', size: mediaBytes.length, mediaBlob: cachedBlob },
      mediaObject: { filehash: 'old-hash' },
      downloadMedia: async () => {
        downloads++;
      },
    }),
  ];
  const chatMessages = [message('CHAT-ONLY-1'), message('DUP-1')];

  const { dom, posted, loaders, api } = makeWindow(globalMessages, chatMessages);
  await sleep(400);
  check('catch-up: hook initialized', api.state.started === true);

  // Active mode is deliberate: catch-up must still never download.
  api.setMediaConfig({ enabled: true, activeFetch: true, recentMs: 24 * 60 * 60 * 1000 });
  api.setConfig({ catchUp: true });
  api.runCatchUp();
  await sleep(700);

  const records = posted.filter((item) => item.kind === 'message').map((item) => item.payload);
  const byId = (id) => records.filter((record) => record.msgId === id);

  check('catch-up: global collection captured', byId('GLOBAL-1').length === 1);
  check('catch-up: per-chat collection captured', byId('CHAT-ONLY-1').length === 1);
  check('catch-up: global/per-chat duplicate posted once', byId('DUP-1').length === 1);
  check('catch-up: no loader APIs called', loaders.calls === 0, String(loaders.calls));

  const media = posted.filter((item) => item.kind === 'media');
  check('catch-up: cached media captured', media.some((item) => item.payload.msgId === 'CATCH-IMG'));
  check('catch-up: Active mode made no download', downloads === 0, String(downloads));
  check('catch-up: old media not queued', !media.some((item) => item.payload.msgId === 'CATCH-OLD-IMG'));

  const before = records.length;
  api.runCatchUp();
  await sleep(200);
  const after = posted.filter((item) => item.kind === 'message').length;
  check('catch-up: second scan does not repost', after === before, `${before} -> ${after}`);

  api.stop();
  dom.window.close();
}

// --- catch-up can be toggled by config without any entitlement -------------
{
  const messages = [message('CATCH-TOGGLE-1')];
  const { dom, posted, api } = makeWindow(messages);
  await sleep(400);

  api.runCatchUp();
  await sleep(300);
  const beforeEnable = posted.filter((item) => item.kind === 'message').map((item) => item.payload);
  check('catch-up: disabled config skips startup scan', beforeEnable.length === 0, String(beforeEnable.length));

  api.setConfig({ catchUp: true });
  api.runCatchUp();
  await sleep(300);
  const afterEnable = posted.filter((item) => item.kind === 'message').map((item) => item.payload);
  check(
    'catch-up: enabled config starts capture',
    afterEnable.some((record) => record.msgId === 'CATCH-TOGGLE-1'),
    JSON.stringify(afterEnable.map((record) => record.msgId))
  );

  api.setConfig({ catchUp: false });
  messages.push(message('CATCH-TOGGLE-2'));
  api.runCatchUp();
  await sleep(300);
  const afterDisable = posted.filter((item) => item.kind === 'message').map((item) => item.payload);
  check(
    'catch-up: disabling stops future scans',
    !afterDisable.some((record) => record.msgId === 'CATCH-TOGGLE-2'),
    JSON.stringify(afterDisable.map((record) => record.msgId))
  );

  api.stop();
  dom.window.close();
}

// --- hard cap keeps one scan bounded ---------------------------------------
{
  const messages = Array.from({ length: 5001 }, (_, index) =>
    message(`CAP-${index}`, { t: 1729166400 + index })
  );
  const { dom, posted, api } = makeWindow(messages);
  await sleep(400);
  api.setConfig({ catchUp: true });
  api.runCatchUp();
  await sleep(1000);

  const records = posted.filter((item) => item.kind === 'message').map((item) => item.payload);
  check('catch-up: capped at 5000 records', records.length === 5000, String(records.length));
  check(
    'catch-up: oldest record dropped by cap',
    !records.some((record) => record.msgId === 'CAP-0'),
    records.some((record) => record.msgId === 'CAP-0') ? 'CAP-0 present' : ''
  );
  check(
    'catch-up: newest record kept by cap',
    records.some((record) => record.msgId === 'CAP-5000')
  );

  api.stop();
  dom.window.close();
}

console.log(failures === 0 ? '\nALL STORE CATCH-UP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
