/**
 * First-run consent: the service worker must refuse archive writes until the
 * current consent version is accepted, then accept them.
 *
 *   node tests/consent.test.mjs
 */
import 'fake-indexeddb/auto';

const storage = {};
const listeners = [];
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(fn) {
        listeners.push(fn);
      },
    },
    sendMessage() {
      return Promise.resolve();
    },
  },
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const key of keys) if (key in storage) out[key] = storage[key];
        return out;
      },
      async set(values) {
        Object.assign(storage, values);
      },
      async remove(keys) {
        for (const key of keys) delete storage[key];
      },
    },
    onChanged: { addListener() {} },
  },
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const idb = await import('../background/idb.js');
await import('../background/background.js');
await sleep(200);

const consent = globalThis.WAConsent;
check('consent module loaded in the service worker', !!consent);
check('no consent by default', consent ? (await consent.hasConsent()) === false : false);
check('listener registered', listeners.length === 1);

const listener = listeners[0];
const record = {
  v: 1,
  msgId: 'CONSENT-1',
  chatId: '123@c.us',
  chatName: 'Consent Chat',
  isGroup: false,
  direction: 'in',
  senderName: 'Jane',
  text: 'hello consent',
  ts: Date.now(),
  capturedAt: Date.now(),
  type: 'chat',
  source: 'store',
};

function sendBatch() {
  return new Promise((resolve) => {
    listener({ type: 'MESSAGE_BATCH', records: [record] }, null, resolve);
  });
}

let response = await sendBatch();
await sleep(100);
check(
  'no consent: batch skipped',
  response && response.stats && response.stats.skipped === 'consent-required',
  JSON.stringify(response)
);
check('no consent: nothing stored', (await idb.countMessages()) === 0);

const accepted = await consent.acceptConsent();
check('accept stores the current consent version', accepted.version === consent.CONSENT_VERSION);
check('hasConsent after acceptance', (await consent.hasConsent()) === true);

response = await sendBatch();
await sleep(150);
check(
  'after consent: batch stored',
  response && response.status === 'stored' && response.stats.inserted === 1,
  JSON.stringify(response)
);
check('after consent: message stored', (await idb.countMessages()) === 1);

storage.waidropConsent = { version: 0, acceptedAt: Date.now() };
check('an old consent version is invalid', (await consent.hasConsent()) === false);

console.log(failures === 0 ? '\nALL CONSENT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
