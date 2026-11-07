/**
 * Background service worker tests: message batches persist to IndexedDB and
 * legacy chrome.storage.local data migrates once.
 *
 *   node tests/background.test.mjs
 */
import 'fake-indexeddb/auto';
import { DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';

const idb = await import('../background/idb.js');
const sanity = await import('../background/recordSanity.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const legacyMessages = [
  {
    v: 1,
    msgId: 'LEGACY-DOM-1',
    chatName: 'Legacy Chat',
    isGroup: false,
    direction: 'in',
    senderName: 'Jane',
    text: 'legacy dom',
    ts: 1729166000000,
    capturedAt: 1729166000100,
    type: 'text',
    source: 'dom',
  },
  {
    v: 1,
    msgId: 'LEGACY-STORE-1',
    chatId: '123@c.us',
    chatName: 'Legacy Chat',
    isGroup: false,
    direction: 'out',
    senderId: '123@c.us',
    senderName: 'You',
    text: 'legacy store',
    ts: 1729166100000,
    capturedAt: 1729166100100,
    type: 'chat',
    source: 'store',
  },
];

const storageData = {
  messages: legacyMessages,
  lastSync: 1729166100200,
  installedAt: 0,
};

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
      get(keys) {
        const out = {};
        for (const k of keys) if (k in storageData) out[k] = storageData[k];
        return Promise.resolve(out);
      },
      set(values) {
        Object.assign(storageData, values);
        return Promise.resolve();
      },
      remove(keys) {
        for (const k of keys) delete storageData[k];
        return Promise.resolve();
      },
    },
  },
};

await import('../background/background.js');
await sleep(150);

check('listener registered', listeners.length === 1);
check('migration completed: idb count 2', (await idb.countMessages()) === 2);
check('migration flag set', !!(await idb.getMeta('migratedFromStorageLocal')));
check('legacy messages removed from chrome.storage', storageData.messages === undefined);
check('legacy lastSync removed from chrome.storage', storageData.lastSync === undefined);
check('migrated records enqueued in outbox', (await idb.getPendingCount()) === 2);

const listener = listeners[0];

// unknown type
{
  let response = null;
  listener({ type: 'NOPE' }, null, (r) => (response = r));
  check('unknown type answered', response && response.status === 'unknown', JSON.stringify(response));
}

// BRIDGE_INIT: per-session key minting + MAIN-world injection
{
  let response = null;
  listener({ type: 'BRIDGE_INIT' }, null, (r) => (response = r));
  check(
    'BRIDGE_INIT without scripting/tab answers unavailable',
    response && response.status === 'unavailable',
    JSON.stringify(response)
  );

  const injections = [];
  globalThis.chrome.scripting = {
    executeScript(options, callback) {
      injections.push(options);
      callback();
    },
  };
  response = null;
  const keep = listener({ type: 'BRIDGE_INIT' }, { tab: { id: 42 } }, (r) => (response = r));
  check('BRIDGE_INIT keeps the channel open', keep === true);
  check(
    'BRIDGE_INIT mints a per-session key',
    !!response && response.status === 'ok' && /^[0-9a-f]{64}$/.test(response.bridgeKey),
    JSON.stringify(response)
  );
  check(
    'BRIDGE_INIT injects hookMain into the MAIN world with the key as its argument',
    injections.length === 1 &&
      injections[0].target.tabId === 42 &&
      injections[0].world === 'MAIN' &&
      typeof injections[0].func === 'function' &&
      injections[0].func.name === 'hookMain' &&
      injections[0].args.length === 1 &&
      injections[0].args[0] === response.bridgeKey,
    JSON.stringify(injections.map((i) => ({ world: i.world, tabId: i.target.tabId, args: i.args })))
  );
  response = null;
  listener({ type: 'BRIDGE_INIT' }, { tab: { id: 43 } }, (r) => (response = r));
  check(
    'BRIDGE_INIT keys are per-session, never reused',
    injections.length === 2 && injections[1].args[0] !== injections[0].args[0]
  );
}

// sanitizer unit checks
check('sanitizeRecord drops oversized msgId', sanity.sanitizeRecord({ msgId: 'x'.repeat(300) }) === null);
check(
  'sanitizeRecord accepts a minimal dom record',
  (() => {
    const r = sanity.sanitizeRecord({ msgId: 'MIN-1', text: 'dup', source: 'dom' });
    return !!r && r.v === 1 && r.source === 'dom' && typeof r.capturedAt === 'number';
  })()
);
check(
  'sanitizeMediaMeta rejects an absurd declared size',
  sanity.sanitizeMediaMeta({ id: 'a', msgId: 'b', totalChars: 1e12 }, 50 * 1024 * 1024) === null
);
check(
  'sanitizeMediaMeta defaults totalChars when absent',
  (() => {
    const m = sanity.sanitizeMediaMeta({ id: 'a', msgId: 'b' }, 100);
    return !!m && m.totalChars === 0;
  })()
);
check('sanitizeChatEntry requires a chatId', sanity.sanitizeChatEntry({ chatName: 'x' }) === null);

// message batch
{
  let response = null;
  const keep = listener(
    {
      type: 'MESSAGE_BATCH',
      records: [
        {
          v: 1,
          msgId: 'NEW-1',
          chatId: '999@g.us',
          chatName: 'Batch Group',
          isGroup: true,
          direction: 'in',
          senderId: '555@c.us',
          senderName: 'Alice',
          text: 'fresh message',
          ts: 1729167000000,
          capturedAt: 1729167000100,
          type: 'chat',
          source: 'store',
        },
        { v: 1, msgId: 'LEGACY-DOM-1', text: 'dup from same batch', source: 'dom' },
        null,
      ],
    },
    null,
    (r) => (response = r)
  );
  check('batch keeps the message channel open', keep === true);
  check('batch not acknowledged before persistence', response === null);
  await sleep(150);
  check(
    'batch acknowledged after persistence',
    !!response && response.status === 'stored' && response.stats.inserted === 1,
    JSON.stringify(response)
  );
  check('batch persisted by the time it is acknowledged', (await idb.countMessages()) === 3);
  check('duplicate id in batch did not double-insert', (await idb.countMessages()) === 3);
  check('pending outbox 3', (await idb.getPendingCount()) === 3);
  const chat = (await idb.getChats()).find((c) => c.chatId === '999@g.us');
  check('chat metadata stored', !!chat && chat.chatName === 'Batch Group');
}

// name directory repair
{
  let response = null;
  listener(
    {
      type: 'MESSAGE_BATCH',
      records: [
        {
          v: 1,
          msgId: 'UNKNOWN-1',
          chatId: '777@lid',
          chatName: 'unknown',
          isGroup: false,
          direction: 'in',
          senderId: '777@lid',
          senderName: null,
          text: 'needs name',
          ts: 1729167100000,
          capturedAt: 1729167100100,
          type: 'chat',
          source: 'store',
        },
      ],
    },
    null,
    (r) => (response = r)
  );
  await sleep(120);
  let rec = (await idb.getMessagesByIds(['UNKNOWN-1']))[0];
  check('directory: record starts with unknown name', !!rec && rec.chatName === 'unknown');

  listener(
    { type: 'NAME_DIRECTORY', chats: [{ chatId: '777@lid', chatName: 'Repaired Name', chatPhone: '49170000000' }] },
    null,
    (r) => (response = r)
  );
  check('directory: accepted immediately', response && response.status === 'accepted' && response.count === 1);
  await sleep(200);
  rec = (await idb.getMessagesByIds(['UNKNOWN-1']))[0];
  check('directory: chat name repaired', rec && rec.chatName === 'Repaired Name', rec && rec.chatName);
  check('directory: chat phone repaired', rec && rec.chatPhone === '49170000000', rec && rec.chatPhone);
}

// writes are not blocked by a running upload
{
  const validKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  storageData.settings = {
    uploadEnabled: true,
    accountAlias: 'primary',
    dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
    encryptionKey: validKey,
    encryptionKeyAcknowledged: true,
  };
  storageData.dropboxAuth = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  };

  let fetchStartedResolve;
  const fetchStarted = new Promise((resolve) => (fetchStartedResolve = resolve));
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchStartedResolve();
    return new Promise(() => {});
  };

  listener({ type: 'TRIGGER_UPLOAD' }, null, () => {});
  const uploadReached = await Promise.race([
    fetchStarted.then(() => true),
    sleep(2000).then(() => false),
  ]);
  check('upload started and is still running', uploadReached === true);

  let response = null;
  listener(
    {
      type: 'MESSAGE_BATCH',
      records: [
        {
          v: 1,
          msgId: 'NOT-BLOCKED-BY-UPLOAD',
          chatId: '123@c.us',
          chatName: 'Realtime',
          isGroup: false,
          direction: 'in',
          senderName: 'Jane',
          text: 'must persist during upload',
          ts: 1729167200000,
          capturedAt: 1729167200100,
          type: 'chat',
          source: 'store',
        },
      ],
    },
    null,
    (r) => (response = r)
  );
  await sleep(300);
  check(
    'batch is acknowledged while an upload is in flight',
    !!response && response.status === 'stored',
    JSON.stringify(response)
  );
  check(
    'batch is persisted while an upload is in flight',
    (await idb.getMessagesByIds(['NOT-BLOCKED-BY-UPLOAD'])).length === 1
  );

  globalThis.fetch = realFetch;
}

// --- inbound sanitization: the bridge is untrusted input --------------------
{
  let response = null;
  listener(
    {
      type: 'MESSAGE_BATCH',
      records: [
        {
          v: 1,
          msgId: 'SANITIZE-1',
          chatId: '999@g.us',
          chatName: 'Sanitize Group',
          isGroup: true,
          direction: 'in',
          text: 'clean message',
          ts: 1729168000000,
          capturedAt: 1729168000100,
          type: 'chat',
          source: 'store',
          evilField: 'must be stripped',
        },
        { v: 1, text: 'record without any msgId' },
        { v: 1, msgId: 'JUNK-TEXT', text: 'x'.repeat(200001), source: 'dom' },
        { v: 1, msgId: 'JUNK-FIELDS', direction: 'sideways', ts: 'not-a-number', source: 'fake', evil: 1 },
        null,
        'not an object',
      ],
    },
    null,
    (r) => (response = r)
  );
  await sleep(150);
  check(
    'forged batch stored only the clean records',
    !!response && response.status === 'stored' && response.stats.inserted === 2,
    JSON.stringify(response)
  );
  check('junk records counted as rejected', !!response && response.stats.rejected === 4, JSON.stringify(response && response.stats));
  const stored = (await idb.getMessagesByIds(['SANITIZE-1']))[0];
  check(
    'stored record is whitelisted (unknown fields stripped)',
    !!stored && stored.evilField === undefined && stored.text === 'clean message' && stored.chatId === '999@g.us',
    JSON.stringify(stored && Object.keys(stored))
  );
  const scrubbed = (await idb.getMessagesByIds(['JUNK-FIELDS']))[0];
  check(
    'malformed enum/type fields scrubbed, usable record kept',
    !!scrubbed && scrubbed.direction === undefined && scrubbed.source === undefined && scrubbed.ts === undefined && scrubbed.evil === undefined,
    JSON.stringify(scrubbed && Object.keys(scrubbed))
  );
  check(
    'unusable forgeries never persisted',
    (await idb.getMessagesByIds(['JUNK-NO-ID', 'JUNK-TEXT'])).every((record) => !record)
  );
}

{
  let response = null;
  listener(
    {
      type: 'NAME_DIRECTORY',
      chats: [
        { chatId: '555@g.us', chatName: 'Good Group', isGroup: true },
        { chatName: 'No Id' },
        { chatId: '', chatName: 'Empty Id' },
        'garbage',
      ],
    },
    null,
    (r) => (response = r)
  );
  check(
    'directory junk rejected, valid counted',
    !!response && response.status === 'accepted' && response.count === 1 && response.rejected === 3,
    JSON.stringify(response)
  );
  await sleep(200);
}

console.log(failures === 0 ? '\nALL BACKGROUND CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
