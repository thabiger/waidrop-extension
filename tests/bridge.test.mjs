/**
 * Private bridge test: the production MessageChannel path (jsdom has no real
 * MessageChannel, so this file provides a fake one with working ports).
 *
 * Verifies:
 *   - the handshake uses a MessagePort, not a data-carrying postMessage
 *   - the handshake is a nonce + SHA-256 MAC exchange; the per-session key
 *     is never transmitted on any observable channel
 *   - store records flow over the port with no window.postMessage traffic
 *   - a page-forged config message cannot enable active media downloads
 *   - a page-forged store record is ignored
 *   - a page script that grabs a transferred port cannot impersonate either
 *     side, even when it knows the test key (possession alone must not
 *     authenticate anything - only a valid MAC does)
 *
 *   node tests/bridge.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { FakeMessageChannel, installWindowPostMessage } from './helpers/fake-message-channel.mjs';
import { TEST_BRIDGE_KEY, startMainHook as startHook } from './helpers/main-hook-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaSettingsSrc = readFileSync(path.join(root, 'utils', 'mediaSettings.js'), 'utf8');
const parserSrc = readFileSync(path.join(root, 'utils', 'messageParser.js'), 'utf8');
const contentSrc = readFileSync(path.join(root, 'content', 'content.js'), 'utf8');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deep scan for a leaked string. Binary payloads (ArrayBuffer/typed arrays)
// are skipped: a key leak would surface as a string field.
function stringsContain(value, needle) {
  if (typeof value === 'string') return value.includes(needle);
  if (!value || typeof value !== 'object') return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  if (Array.isArray(value)) return value.some((item) => stringsContain(item, needle));
  return Object.keys(value).some((key) => stringsContain(value[key], needle));
}

const html = '<!DOCTYPE html><html><body></body></html>';

function makeChromeMock(sent, mediaRelay, bridgeKey) {
  return {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        sent.push(message);
        if (message && message.type === 'BRIDGE_INIT') {
          if (callback) callback({ status: 'ok', bridgeKey });
          return;
        }
        if (callback) callback({ status: 'stored', stats: {} });
      },
      connect() {
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage(message) {
            mediaRelay.push(message);
          },
        };
      },
    },
    storage: {
      local: {
        get: async () => ({
          settings: {},
        }),
      },
      onChanged: { addListener() {} },
    },
  };
}

const dom = new JSDOM(html, { url: 'https://web.whatsapp.com/', runScripts: 'outside-only' });
const { window } = dom;
Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
const postCalls = installWindowPostMessage(window);

const sent = [];
const mediaRelay = [];
window.chrome = makeChromeMock(sent, mediaRelay, TEST_BRIDGE_KEY);

const listeners = {};
const collections = {
  Msg: {
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    off(event, cb) {
      listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
    },
  },
  Chat: {
    get: () => ({ name: 'Bridge Chat' }),
    getModelsArray: () => [],
  },
  Contact: { get: () => null },
};
window.require = (name) => (name === 'WAWebCollections' ? collections : undefined);
window.__WAIDROP_EXPOSE_TEST_API__ = true;

const emit = (msg) => (listeners['add'] || []).forEach((cb) => cb(msg));

startHook(window);
const api = window.__waArchiveMain;
check('main hook initialized', api && api.state.started === true);

// --- a page script grabs transferred ports and tries to impersonate the
// --- content script with the old clear-key protocol (or a forged MAC).
let evilCount = 0;
{
  const evil = new window.MessageChannel();
  evilCount++;
  const evilSeen = [];
  evil.port1.onmessage = (event) => evilSeen.push(event.data);
  window.postMessage({}, window.location.origin, [evil.port2]);
  await sleep(80);
  const challenge = evilSeen.find((d) => d && typeof d.c === 'string' && d.n === undefined);
  check('hook challenges a grabbed port', !!challenge);
  evil.port1.postMessage({ c: challenge && challenge.c, k: TEST_BRIDGE_KEY });
  await sleep(80);
  check('hook rejects a clear-key (non-MAC) reply', api.getBridgeMode() !== 'port', api.getBridgeMode());

  const evil2 = new window.MessageChannel();
  evilCount++;
  const evil2Seen = [];
  evil2.port1.onmessage = (event) => evil2Seen.push(event.data);
  window.postMessage({}, window.location.origin, [evil2.port2]);
  await sleep(80);
  const challenge2 = evil2Seen.find((d) => d && typeof d.c === 'string' && d.n === undefined);
  check('hook challenges a second grabbed port', !!challenge2);
  evil2.port1.postMessage({ c: challenge2 && challenge2.c, n: 'evilnonce', m1: '0'.repeat(64) });
  await sleep(80);
  check('hook rejects a wrong MAC', api.getBridgeMode() !== 'port', api.getBridgeMode());
}

// --- the real content script connects with the per-session MAC handshake.
const instancesBefore = FakeMessageChannel.instances.length;
window.eval(mediaSettingsSrc);
window.eval(parserSrc);
window.eval(contentSrc);
await sleep(150);

check('bridge connected over MessageChannel', api && api.getBridgeMode() === 'port', api && api.getBridgeMode());
check('media config arrived over the port', api && api.state.mediaConfig.enabled === true);
check('content config enables catch-up over the port', api && api.state.catchUpEnabled === true);

const ourChannels = FakeMessageChannel.instances.slice(instancesBefore);
check('content script used one channel for the successful handshake', ourChannels.length === 1, String(ourChannels.length));

const handshake = postCalls.find(
  (call) =>
    call.ports &&
    call.ports.length === 1 &&
    call.message &&
    typeof call.message === 'object' &&
    Object.keys(call.message).length === 0
);
check('handshake transfers a MessagePort', !!handshake);
check(
  'handshake carries no store/config payload',
  !!handshake && Object.keys(handshake.message).length === 0,
  handshake && JSON.stringify(handshake.message)
);
check(
  'no legacy archive traffic',
  !postCalls.some(
    (call) =>
      call.message &&
      (call.message.source === 'waidrop-main' ||
        call.message.source === 'waidrop-config' ||
        call.message.source === 'waidrop-legacy')
  )
);

// --- the key never crosses any channel our scripts speak on.
{
  const reply = ourChannels[0].port1.sent.find(
    (m) => m.data && typeof m.data.c === 'string' && typeof m.data.n === 'string' && typeof m.data.m1 === 'string'
  );
  check(
    'handshake reply carries a 64-hex MAC, never the key',
    !!reply && /^[0-9a-f]{64}$/.test(reply.data.m1) && !('k' in reply.data),
    reply && JSON.stringify(reply.data)
  );
  const ack = ourChannels[0].port2.sent.find((m) => m.data && m.data.ok === 1);
  check(
    'handshake ack carries a 64-hex MAC, never the key',
    !!ack && /^[0-9a-f]{64}$/.test(ack.data.m2) && !('k' in ack.data),
    ack && JSON.stringify(ack.data)
  );

  const leaks = [];
  for (const call of postCalls) {
    if (stringsContain(call.message, TEST_BRIDGE_KEY)) leaks.push('window.postMessage');
  }
  for (const channel of ourChannels) {
    for (const m of channel.port1.sent) if (stringsContain(m.data, TEST_BRIDGE_KEY)) leaks.push('port1');
    for (const m of channel.port2.sent) if (stringsContain(m.data, TEST_BRIDGE_KEY)) leaks.push('port2');
  }
  check('bridge key never crosses any observable channel', leaks.length === 0, leaks.join(','));
}

// --- store records flow over the authenticated port.
await sleep(50);
postCalls.length = 0;
emit({
  id: { id: 'BRIDGE-1', _serialized: 'false_123@c.us_BRIDGE-1', fromMe: false, remote: { _serialized: '123@c.us' } },
  t: 1729166400,
  type: 'chat',
  body: 'via private port',
});
await sleep(250);

const batches = sent.filter((message) => message.type === 'MESSAGE_BATCH');
const records = batches.flatMap((batch) => batch.records || []);
check('store record reached the background', records.some((record) => record.msgId === 'BRIDGE-1'));
check('store record used the private port', records.some((record) => record.text === 'via private port'));
check('no window.postMessage after connect', postCalls.length === 0, `${postCalls.length} call(s)`);

window.postMessage({ source: 'waidrop-config', media: { activeFetch: true } }, '*');
await sleep(60);
check('forged config cannot enable active fetch', api.state.mediaConfig.activeFetch === false, String(api.state.mediaConfig.activeFetch));

window.postMessage(
  {
    source: 'waidrop-main',
    kind: 'message',
    payload: {
      v: 1,
      msgId: 'FORGED-1',
      chatId: '123@c.us',
      chatName: 'Forged',
      isGroup: false,
      direction: 'in',
      senderName: 'Forged',
      text: 'forged',
      ts: Date.now(),
      capturedAt: Date.now(),
      type: 'chat',
      source: 'store',
    },
  },
  '*'
);
await sleep(150);
const forged = sent
  .filter((message) => message.type === 'MESSAGE_BATCH')
  .flatMap((batch) => batch.records || [])
  .find((record) => record.msgId === 'FORGED-1');
check('forged store record is ignored', !forged);

postCalls.length = 0;
const mediaBytes = new TextEncoder().encode('bridge-media-bytes');
const fakeBlob = {
  type: 'image/jpeg',
  size: mediaBytes.length,
  arrayBuffer: async () => mediaBytes.buffer.slice(0),
  forceToBlob: () => fakeBlob,
};
emit({
  id: { id: 'BRIDGE-IMG', fromMe: false, remote: { _serialized: '123@c.us' } },
  t: Math.floor(Date.now() / 1000),
  type: 'image',
  body: 'media caption',
  size: mediaBytes.length,
  mediaData: { mediaStage: 'RESOLVED', size: mediaBytes.length, mediaBlob: fakeBlob },
  mediaObject: {},
});
await sleep(300);
check(
  'media reached the extension relay over the port',
  mediaRelay.some((message) => message.type === 'MEDIA_BEGIN' && message.msgId === 'BRIDGE-IMG'),
  JSON.stringify(mediaRelay.map((message) => message.type))
);
check(
  'media transfer completed',
  mediaRelay.some((message) => message.type === 'MEDIA_END'),
  JSON.stringify(mediaRelay.map((message) => message.type))
);
check('no window.postMessage for media', postCalls.length === 0, `${postCalls.length} call(s)`);

api.stop();
dom.window.close();

// --- a page script steals the port the content script transfers and tries
// --- to impersonate the MAIN hook with the old clear-key ack. The content
// --- script must reject it on every attempt and end in DOM-only mode.
{
  const dom2 = new JSDOM(html, { url: 'https://web.whatsapp.com/', runScripts: 'outside-only' });
  const window2 = dom2.window;
  Object.defineProperty(window2, 'crypto', { value: webcrypto, configurable: true });
  installWindowPostMessage(window2);

  const sent2 = [];
  window2.chrome = makeChromeMock(sent2, [], TEST_BRIDGE_KEY);
  window2.require = (name) => (name === 'WAWebCollections' ? collections : undefined);
  window2.__WAIDROP_EXPOSE_TEST_API__ = true;

  // Attacker listener registered before the hook: grabs every transferred
  // port, clobbers the hook's handler and answers MAC replies with the old
  // clear-key ack.
  window2.addEventListener('message', (event) => {
    if (!event.ports || !event.ports[0]) return;
    const stolen = event.ports[0];
    setTimeout(() => {
      stolen.onmessage = (ev) => {
        const d = ev && ev.data;
        if (d && typeof d.c === 'string' && typeof d.n === 'string' && typeof d.m1 === 'string') {
          stolen.postMessage({ ok: 1, k: TEST_BRIDGE_KEY, n: d.n });
        }
      };
    }, 0);
  });

  startHook(window2);
  const before = FakeMessageChannel.instances.length;
  const warnings = [];
  window2.console.warn = (...args) => warnings.push(args.join(' '));
  window2.eval(mediaSettingsSrc);
  window2.eval(parserSrc);
  window2.eval(contentSrc);
  await sleep(9000);

  const stolenChannels = FakeMessageChannel.instances.slice(before);
  check('stolen-port handshake failed on every attempt', stolenChannels.length === 4, String(stolenChannels.length));
  check(
    'bridge failure reports the reason',
    warnings.some((line) => line.includes('private store bridge unavailable') && line.includes('handshake-timeout')),
    warnings.join(' | ')
  );
  check(
    'content script never accepted a clear-key ack',
    stolenChannels.every((channel) => !channel.port1.sent.some((m) => m.data && m.data.ok === undefined && 'k' in m.data))
  );
  const stealLeaks = [];
  for (const channel of stolenChannels) {
    // port1 is the content script's end: the key must never appear there.
    for (const m of channel.port1.sent) if (stringsContain(m.data, TEST_BRIDGE_KEY)) stealLeaks.push('port1');
    // port2 carries the hook's challenge (no ok field): it must never carry
    // the key either. (The thief's own clear-key acks on port2 are the
    // attack itself and are expected.)
    for (const m of channel.port2.sent) {
      if (m.data && m.data.ok === undefined && stringsContain(m.data, TEST_BRIDGE_KEY)) stealLeaks.push('port2-challenge');
    }
  }
  check('neither end of our bridge ever disclosed the key to the port thief', stealLeaks.length === 0, stealLeaks.join(','));
  check(
    'port thief only ever sees MACs',
    stolenChannels.every((channel) =>
      channel.port1.sent
        .filter((m) => m.data && typeof m.data.m1 === 'string')
        .every((m) => /^[0-9a-f]{64}$/.test(m.data.m1) && !('k' in m.data))
    )
  );
  check('no store records delivered through a stolen port', !sent2.some((message) => message.type === 'MESSAGE_BATCH'));

  window2.__waArchiveMain.stop();
  dom2.window.close();
}

console.log(failures === 0 ? '\nALL BRIDGE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
