/**
 * Store-hook serializer tests: fake WhatsApp model objects -> serialized
 * primitive records. Plus transport and resilience checks for the MAIN-world
 * script evaluated in jsdom with a fake window.require.
 *
 *   node tests/store-serializer.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { startMainHook } from './helpers/main-hook-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCollections() {
  const listeners = {};
  const chats = {
    '123@c.us': { id: { _serialized: '123@c.us' }, name: 'Test Chat' },
    '999@g.us': { id: { _serialized: '999@g.us' }, name: 'Group Chat' },
  };
  return {
    Msg: {
      on(event, cb) {
        (listeners[event] = listeners[event] || []).push(cb);
      },
    },
    Chat: {
      get(id) {
        return chats[id] || null;
      },
      getModelsArray() {
        return Object.values(chats);
      },
    },
    Contact: {
      get() {
        return null;
      },
    },
    emit(event, msg) {
      (listeners[event] || []).forEach((cb) => cb(msg));
    },
  };
}

function makeWindow(collections) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
  });
  const posted = [];
  dom.window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'waidrop-main') posted.push(e.data);
  });
  dom.window.require = (name) => (name === 'WAWebCollections' ? collections : undefined);
  dom.window.__WAIDROP_EXPOSE_TEST_API__ = true;
  // Plain jsdom: the hook takes the legacy postMessage transport.
  startMainHook(dom.window);
  return { dom, api: dom.window.__waArchiveMain, posted };
}

// --- outgoing DM -------------------------------------------------------------
{
  const collections = fakeCollections();
  const { dom, api, posted } = makeWindow(collections);
  await sleep(30);
  const health = posted.find((p) => p.kind === 'health');
  check('health active posted', !!health && health.payload.status === 'active', health && health.payload.status);
  check('state.started set', api.state.started === true);

  const directory = posted.find((p) => p.kind === 'directory');
  check(
    'name directory emitted on init',
    !!directory && Array.isArray(directory.payload.chats) && directory.payload.chats.length === 2,
    directory && directory.payload.chats && directory.payload.chats.length
  );

  const rec = api.serializeStoreMessage({
    id: {
      id: '3EB0TESTID',
      _serialized: 'true_123@c.us_3EB0TESTID',
      fromMe: true,
      remote: { _serialized: '123@c.us', user: '123', server: 'c.us' },
    },
    t: 1729166400,
    type: 'chat',
    body: 'Hello world',
    from: { _serialized: '123@c.us' },
    to: { _serialized: '123@c.us' },
    notifyName: 'Jane',
  });
  check('outgoing: record built', !!rec);
  check('outgoing: msgId is raw id (matches DOM data-id)', rec.msgId === '3EB0TESTID', rec.msgId);
  check('outgoing: msgKey full serialized kept', rec.msgKey === 'true_123@c.us_3EB0TESTID', rec.msgKey);
  check('outgoing: chatId jid', rec.chatId === '123@c.us', rec.chatId);
  check('outgoing: chatName from Chat collection', rec.chatName === 'Test Chat', rec.chatName);
  check('outgoing: direction out', rec.direction === 'out', rec.direction);
  check('outgoing: not group', rec.isGroup === false);
  check('outgoing: ts = t * 1000', rec.ts === 1729166400000, String(rec.ts));
  check('outgoing: type/text', rec.type === 'chat' && rec.text === 'Hello world');
  check('outgoing: senderName You', rec.senderName === 'You', rec.senderName);
  check('outgoing: schema v1 + source store', rec.v === 1 && rec.source === 'store');
  check('outgoing: serializable', (() => { try { JSON.parse(JSON.stringify(rec)); return true; } catch { return false; } })());

  collections.emit('add', {
    id: { id: 'X1', fromMe: true, remote: { _serialized: '123@c.us' } },
    t: 1729166401,
    type: 'chat',
    body: 'via emitter',
  });
  await sleep(30);
  const postedMsg = posted.filter((p) => p.kind === 'message').map((p) => p.payload);
  check('emitter posts record', postedMsg.length === 1 && postedMsg[0].msgId === 'X1', JSON.stringify(postedMsg.map((r) => r.msgId)));

  api.stop();
}

// --- LID chats + contact-based names (probe-shaped models) -------------------
{
  const collections = fakeCollections();
  collections.Contact = {
    get(id) {
      if (id === 'LIDCHAT@lid') {
        return {
          name: 'Saved Name',
          pushname: 'Profile Name',
          shortName: 'SN',
          phoneNumber: { _serialized: '49171234567@c.us' },
        };
      }
      if (id === 'AUTHOR@lid') {
        return {
          name: 'Author Name',
          pushname: 'Author Push',
          phoneNumber: { _serialized: '49179999999@c.us' },
        };
      }
      return null;
    },
  };
  const { api } = makeWindow(collections);

  const dm = api.serializeStoreMessage({
    id: { id: 'LID-1', fromMe: false, remote: { _serialized: 'LIDCHAT@lid' } },
    t: 1729167000,
    type: 'chat',
    body: 'hello lid',
  });
  check('lid dm: chatName from contact.name', dm.chatName === 'Saved Name', dm.chatName);
  check('lid dm: chatPhone recovered from contact.phoneNumber', dm.chatPhone === '49171234567', dm.chatPhone);
  check('lid dm: chatPushname captured', dm.chatPushname === 'Profile Name', dm.chatPushname);
  check('lid dm: senderName falls back to chat name', dm.senderName === 'Saved Name', dm.senderName);

  const grp = api.serializeStoreMessage({
    id: { id: 'LID-2', fromMe: false, remote: { _serialized: '999@g.us' } },
    author: { _serialized: 'AUTHOR@lid' },
    t: 1729167001,
    type: 'chat',
    body: 'group msg',
  });
  check('group sender: contact fallback', grp.senderName === 'Author Name', grp.senderName);
  check('group sender: pushname captured', grp.senderPushname === 'Author Push', grp.senderPushname);
  check('group sender: phone recovered', grp.senderPhone === '49179999999', grp.senderPhone);

  const cUs = api.serializeStoreMessage({
    id: { id: 'CUS-1', fromMe: false, remote: { _serialized: '49171234567@c.us' } },
    t: 1729167002,
    type: 'chat',
    body: 'plain jid',
  });
  check('c.us jid: chatPhone derived from jid', cUs.chatPhone === '49171234567', cUs.chatPhone);

  api.stop();
}

// --- incoming group ----------------------------------------------------------
{
  const collections = fakeCollections();
  const { api } = makeWindow(collections);
  const rec = api.serializeStoreMessage({
    id: {
      id: 'AC8F0001',
      fromMe: false,
      remote: { _serialized: '999@g.us', user: '999', server: 'g.us' },
    },
    t: 1729167000,
    type: 'chat',
    body: 'Group hello',
    author: { _serialized: '555@c.us' },
    from: { _serialized: '555@c.us' },
    notifyName: 'Alice',
  });
  check('group: direction in', rec.direction === 'in');
  check('group: isGroup true', rec.isGroup === true);
  check('group: senderId = author', rec.senderId === '555@c.us', rec.senderId);
  check('group: senderName = notifyName', rec.senderName === 'Alice', rec.senderName);
  check('group: chatName', rec.chatName === 'Group Chat', rec.chatName);

  const rec2 = api.serializeStoreMessage({
    id: { id: 'NO-REMOTE', fromMe: false },
    t: 1729167001,
    type: 'chat',
    body: 'fallback',
    from: { _serialized: '777@c.us' },
  });
  check('missing remote falls back to from', rec2.chatId === '777@c.us', rec2.chatId);

  const rec3 = api.serializeStoreMessage({
    id: { id: 'STR-T', fromMe: true, remote: { _serialized: '123@c.us' } },
    t: '1729167002',
    type: 'chat',
    body: 'numeric string',
  });
  check('string t coerced to number', rec3.ts === 1729167002000, String(rec3.ts));

  const skipped = [
    api.serializeStoreMessage({ id: { id: 'S1', fromMe: false }, type: 'e2e_notification', t: 1 }),
    api.serializeStoreMessage({ id: { id: 'S2', fromMe: false }, type: 'notification_template', t: 1 }),
    api.serializeStoreMessage({ id: { id: 'S3', fromMe: false }, type: 'call_log', t: 1 }),
  ];
  check('protocol noise skipped', skipped.every((r) => r === null));

  const revoked = api.serializeStoreMessage({ id: { id: 'R1', fromMe: false, remote: { _serialized: '123@c.us' } }, type: 'revoked', t: 2, body: '' });
  check('revoked kept as tombstone', !!revoked && revoked.type === 'revoked');

  check('no id -> null', api.serializeStoreMessage({ type: 'chat', body: 'x' }) === null);
  check('empty id -> null', api.serializeStoreMessage({ id: {}, type: 'chat' }) === null);

  // resilience: hostile getter must not throw through the emitter
  let threw = false;
  try {
    const evil = {};
    Object.defineProperty(evil, 'id', { get() { throw new Error('boom'); } });
    collections.emit('add', evil);
  } catch (e) {
    threw = true;
  }
  check('hostile message does not throw', threw === false);

  api.stop();
}

// --- fallback: collections exposed as separate modules ------------------------
{
  const collections = fakeCollections();
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
  });
  const posted = [];
  dom.window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'waidrop-main') posted.push(event.data);
  });
  dom.window.require = (name) => {
    if (name === 'WAWebCollections') throw new Error('Requiring unknown module "WAWebCollections"');
    if (name === 'WAWebMsgCollection') return { MsgCollection: collections.Msg };
    if (name === 'WAWebChatCollection') return { ChatCollection: collections.Chat };
    if (name === 'WAWebContactCollection') return { ContactCollection: collections.Contact };
    return undefined;
  };
  dom.window.__WAIDROP_EXPOSE_TEST_API__ = true;
  startMainHook(dom.window);
  await sleep(40);

  const api = dom.window.__waArchiveMain;
  check('fallback: hook initialized from separate collection modules', api && api.state.started === true);
  collections.emit('add', {
    id: { id: 'FALLBACK-1', fromMe: false, remote: { _serialized: '123@c.us' } },
    t: 1729167000,
    type: 'chat',
    body: 'fallback message',
  });
  await sleep(30);
  const record = posted.find((item) => item.kind === 'message' && item.payload.msgId === 'FALLBACK-1');
  check('fallback: message posted', !!record);
  check('fallback: chat collection resolved', record && record.payload.chatName === 'Test Chat', record && record.payload.chatName);
  api.stop();
  dom.window.close();
}

// --- Meta loader: renamed modules discovered from the __debug map ------------
{
  const collections = fakeCollections();
  const modulesMap = {
    WAWebMsgCollectionMd: { factory: () => ({ MsgCollection: collections.Msg }) },
    WAWebChatCollectionMd: { factory: () => ({ ChatCollection: collections.Chat }) },
    WAWebContactCollectionMd: { factory: () => ({ ContactCollection: collections.Contact }) },
  };
  const requireCalls = [];
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
  });
  const posted = [];
  dom.window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'waidrop-main') posted.push(event.data);
  });
  dom.window.__d = {};
  dom.window.require = (name) => {
    requireCalls.push(name);
    if (name === '__debug') return { modulesMap };
    if (modulesMap[name]) return modulesMap[name].factory();
    throw new Error(`Requiring unknown module "${name}"`);
  };
  dom.window.__WAIDROP_EXPOSE_TEST_API__ = true;
  startMainHook(dom.window);
  await sleep(40);

  const api = dom.window.__waArchiveMain;
  check('meta map: hook initialized from renamed collection modules', api && api.state.started === true);
  check('meta map: WAWebCollections was never required', !requireCalls.includes('WAWebCollections'), JSON.stringify(requireCalls));

  collections.emit('add', {
    id: { id: 'META-1', fromMe: false, remote: { _serialized: '123@c.us' } },
    t: 1729167000,
    type: 'chat',
    body: 'meta map message',
  });
  await sleep(30);
  const record = posted.find((item) => item.kind === 'message' && item.payload.msgId === 'META-1');
  check('meta map: message posted', !!record);
  check('meta map: chat collection resolved', record && record.payload.chatName === 'Test Chat', record && record.payload.chatName);
  api.stop();
  dom.window.close();
}

// --- production mode: test API hidden, hook still works -----------------------
{
  const collections = fakeCollections();
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
  });
  const posted = [];
  dom.window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'waidrop-main') posted.push(event.data);
  });
  dom.window.require = (name) => (name === 'WAWebCollections' ? collections : undefined);
  dom.window.Debug = { VERSION: '2.3000.test' };
  startMainHook(dom.window);

  check('production: test API not exposed', dom.window.__waArchiveMain === undefined);

  // jsdom has no MessageChannel, so the real isolated content script would
  // announce the legacy transport. Simulate that signal here.
  dom.window.postMessage({ source: 'waidrop-legacy' }, '*');
  await sleep(600);
  const health = posted.find((item) => item.kind === 'health');
  check('production: hook still initializes', !!health && health.payload.status === 'active', health && health.payload.status);

  collections.emit('add', {
    id: { id: 'PROD-1', fromMe: false, remote: { _serialized: '123@c.us' } },
    t: 1729167000,
    type: 'chat',
    body: 'production message',
  });
  await sleep(30);
  check(
    'production: messages still posted',
    posted.some((item) => item.kind === 'message' && item.payload.msgId === 'PROD-1')
  );
  dom.window.close();
}

console.log(failures === 0 ? '\nALL STORE SERIALIZER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
