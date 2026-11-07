/**
 * IndexedDB archive layer tests (fake-indexeddb).
 *
 *   node tests/idb.test.mjs
 */
import 'fake-indexeddb/auto';

const idb = await import('../background/idb.js');
await (await import('./helpers/local-codec.mjs')).installLocalCodec();

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const domRecord = (id, extra = {}) => ({
  v: 1,
  msgId: id,
  chatName: 'Demo Chat',
  isGroup: false,
  direction: 'in',
  senderName: 'Jane',
  text: 'dom text',
  ts: 1729166400000,
  capturedAt: 1729166400100,
  type: 'text',
  source: 'dom',
  ...extra,
});
const storeRecord = (id, extra = {}) => ({
  v: 1,
  msgId: id,
  chatId: '123@c.us',
  chatName: 'Demo Chat',
  isGroup: false,
  direction: 'in',
  senderId: '123@c.us',
  senderName: 'Jane',
  text: 'store text',
  ts: 1729166400000,
  capturedAt: 1729166400200,
  type: 'chat',
  source: 'store',
  ...extra,
});

// --- insert + outbox enqueue ---------------------------------------------------
{
  await idb.clearAll();
  const stats = await idb.putRecords([domRecord('M1'), storeRecord('M2')]);
  check('insert stats', stats.inserted === 2 && stats.upgraded === 0 && stats.skipped === 0, JSON.stringify(stats));
  check('count 2', (await idb.countMessages()) === 2);
  check('pending 2', (await idb.getPendingCount()) === 2);
  const pending = await idb.listPendingOutbox();
  check('outbox entries pending', pending.length === 2 && pending.every((e) => e.status === 'pending'));
}

// --- upsert semantics -----------------------------------------------------------
{
  const stats = await idb.putRecords([storeRecord('M1')]);
  check('dom -> store upgrade counted', stats.upgraded === 1, JSON.stringify(stats));
  check('count still 2', (await idb.countMessages()) === 2);
  const m1 = (await idb.getMessagesByIds(['M1']))[0];
  check('record upgraded to store data', m1.source === 'store' && m1.text === 'store text', JSON.stringify(m1 && m1.text));
  check('outbox stays pending (no dup enqueue)', (await idb.getPendingCount()) === 2);

  const stats2 = await idb.putRecords([domRecord('M2')]);
  check('store -> dom downgrade skipped', stats2.skipped === 1, JSON.stringify(stats2));
  const m2 = (await idb.getMessagesByIds(['M2']))[0];
  check('store record preserved', m2.source === 'store');

  const stats3 = await idb.putRecords([storeRecord('M2')]);
  check('store -> store identical duplicate skipped', stats3.skipped === 1, JSON.stringify(stats3));

  const stats4 = await idb.putRecords([storeRecord('M2', { text: 'edited body' })]);
  check('store -> store changed text updated (edits win)', stats4.updated === 1, JSON.stringify(stats4));
  const m2b = (await idb.getMessagesByIds(['M2']))[0];
  check('edited body stored', m2b.text === 'edited body', m2b.text);
}

// --- re-delivered duplicates are idempotent -------------------------------------
{
  await idb.clearAll();
  await idb.putRecords([storeRecord('S1')]);
  await idb.setOutboxStatus(['S1'], 'done');
  const chatsBefore = (await idb.getChats()).find((c) => c.chatId === '123@c.us');

  const stats = await idb.putRecords([storeRecord('S1', { capturedAt: 1729166999999 })]);
  check(
    'redelivery: store duplicate with new capturedAt skipped',
    stats.skipped === 1 && stats.updated === 0,
    JSON.stringify(stats)
  );
  check('redelivery: done outbox stays done', (await idb.getPendingCount()) === 0);
  const kept = (await idb.getMessagesByIds(['S1']))[0];
  check('redelivery: first capturedAt preserved', kept.capturedAt === 1729166400200, String(kept.capturedAt));
  const chatsAfter = (await idb.getChats()).find((c) => c.chatId === '123@c.us');
  check(
    'redelivery: chat lastSeen untouched',
    chatsAfter.lastSeen === chatsBefore.lastSeen,
    `${chatsBefore.lastSeen} -> ${chatsAfter.lastSeen}`
  );

  await idb.putRecords([domRecord('D1', { ts: null, capturedAt: 5000 })]);
  await idb.setOutboxStatus(['D1'], 'done');
  const domStats = await idb.putRecords([domRecord('D1', { ts: null, capturedAt: 6000 })]);
  check('redelivery: dom duplicate without ts skipped', domStats.skipped === 1, JSON.stringify(domStats));
  check('redelivery: dom done outbox stays done', (await idb.getPendingCount()) === 0);

  const editStats = await idb.putRecords([storeRecord('S1', { text: 'real edit', capturedAt: 1729167000000 })]);
  check(
    'redelivery: genuine edit still updates and re-enqueues',
    editStats.updated === 1 && (await idb.getPendingCount()) === 1,
    JSON.stringify(editStats)
  );
  const edited = (await idb.getMessagesByIds(['S1']))[0];
  check(
    'redelivery: genuine edit persists new capturedAt',
    edited.text === 'real edit' && edited.capturedAt === 1729167000000,
    JSON.stringify({ text: edited.text, capturedAt: edited.capturedAt })
  );
}

// --- media recapture is idempotent ------------------------------------------------
{
  await idb.clearAll();
  await idb.putRecords([domRecord('MEDIA-1', { type: 'image' })]);
  await idb.setOutboxStatus(['MEDIA-1'], 'done');
  await idb.putMedia({ msgId: 'MEDIA-1', status: 'stored', path: 'chat=x/dt=y/media-z.enc', byteLength: 10, capturedAt: 1000 });
  await idb.setOutboxStatus(['MEDIA-1'], 'done');

  await idb.putMedia({ msgId: 'MEDIA-1', status: 'pending', byteLength: 10, capturedAt: 2000 });
  const media = await idb.getMedia('MEDIA-1');
  check('media redelivery: first capturedAt kept', media.capturedAt === 1000, String(media.capturedAt));
  check('media redelivery: stored status kept', media.status === 'stored', media.status);
  check('media redelivery: message not re-enqueued', (await idb.getPendingCount()) === 0);
}

// --- names never downgrade on upgrade -----------------------------------------
{
  await idb.putRecords([domRecord('M6', { chatName: 'DOM Name', senderName: 'DOM Sender' })]);
  const stats = await idb.putRecords([storeRecord('M6', { chatName: 'unknown', senderName: null })]);
  check('blank-name store upgrade counted', stats.upgraded === 1, JSON.stringify(stats));
  const rec = (await idb.getMessagesByIds(['M6']))[0];
  check(
    'DOM names preserved on upgrade',
    rec.chatName === 'DOM Name' && rec.senderName === 'DOM Sender',
    JSON.stringify({ chatName: rec.chatName, senderName: rec.senderName })
  );
  check(
    'store payload still applied on upgrade',
    rec.source === 'store' && rec.chatId === '123@c.us' && rec.text === 'store text',
    JSON.stringify({ source: rec.source, chatId: rec.chatId, text: rec.text })
  );
}

// --- upgrade after upload re-enqueues --------------------------------------------
{
  await idb.putRecords([domRecord('M5')]);
  await idb.setOutboxStatus(['M5'], 'done');
  const before = await idb.getPendingCount();
  const stats = await idb.putRecords([storeRecord('M5', { text: 'late store upgrade' })]);
  check('late dom->store upgrade after done counted', stats.upgraded === 1, JSON.stringify(stats));
  const m5 = (await idb.getMessagesByIds(['M5']))[0];
  check('M5 now carries store data', m5.source === 'store' && m5.text === 'late store upgrade');
  const after = await idb.getPendingCount();
  check('upgrade after done re-enqueues for upload', after === before + 1, `before=${before} after=${after}`);
  const entry = (await idb.listPendingOutbox()).find((e) => e.msgId === 'M5');
  check('re-enqueue reason marked upgrade', entry && entry.reason === 'upgrade', entry && entry.reason);
}

// --- chat metadata upsert ---------------------------------------------------------
{
  await idb.putRecords([storeRecord('M3', { chatId: '999@g.us', chatName: 'Old Name', isGroup: true, ts: 1729166500000 })]);
  await idb.putRecords([storeRecord('M4', { chatId: '999@g.us', chatName: 'New Name', isGroup: true, ts: 1729166600000 })]);
  const chats = await idb.getChats();
  const group = chats.find((c) => c.chatId === '999@g.us');
  check('one chat entry for same chatId', chats.filter((c) => c.chatId === '999@g.us').length === 1);
  check('chat name updated', group && group.chatName === 'New Name', group && group.chatName);
  check('chat isGroup set', group && group.isGroup === true);
  check('firstSeen <= lastSeen', group && group.firstSeen <= group.lastSeen);
}

// --- chat store keeps phone/pushname ------------------------------------------
{
  await idb.clearAll();
  await idb.putRecords([storeRecord('N1', { chatPhone: '49171234567', chatPushname: 'Anna Push' })]);
  const chat = (await idb.getChats()).find((c) => c.chatId === '123@c.us');
  check('chats store keeps chatPhone', chat && chat.chatPhone === '49171234567', chat && chat.chatPhone);
  check('chats store keeps chatPushname', chat && chat.chatPushname === 'Anna Push', chat && chat.chatPushname);
}

// --- recency ordering --------------------------------------------------------------
{
  await idb.clearAll();
  await idb.putRecords([
    storeRecord('OLD', { ts: 1000 }),
    storeRecord('NEW', { ts: 3000 }),
    storeRecord('MID', { ts: 2000 }),
    domRecord('NO_TS', { ts: null, capturedAt: 5000 }),
  ]);
  const recent = await idb.getRecentMessages(3);
  check('recent sorted by sortTs desc', recent.map((r) => r.msgId).join(',') === 'NO_TS,NEW,MID', recent.map((r) => r.msgId).join(','));
  const all = await idb.getRecentMessages(10);
  check('limit respected', all.length === 4);
}

// --- chat-name repair from the live directory ---------------------------------
{
  await idb.clearAll();
  await idb.putRecords([storeRecord('R1', { chatName: 'unknown' })]);
  await idb.setOutboxStatus(['R1'], 'done');

  const result = await idb.applyChatDirectory([
    { chatId: '123@c.us', chatName: 'Real Name', chatPhone: '49171234567', chatPushname: 'Profile Name' },
  ]);
  check('repair: updated count', result.updated === 1, JSON.stringify(result));
  const rec = (await idb.getMessagesByIds(['R1']))[0];
  check(
    'repair: names/phone filled',
    rec.chatName === 'Real Name' && rec.chatPhone === '49171234567' && rec.chatPushname === 'Profile Name',
    JSON.stringify({ n: rec.chatName, p: rec.chatPhone, pn: rec.chatPushname })
  );
  check('repair: done entry re-enqueued', (await idb.getPendingCount()) === 1);
  const chat = (await idb.getChats()).find((c) => c.chatId === '123@c.us');
  check('repair: chats store updated', chat && chat.chatName === 'Real Name', chat && chat.chatName);
  check('repair: chats store phone updated', chat && chat.chatPhone === '49171234567', chat && chat.chatPhone);

  const again = await idb.applyChatDirectory([{ chatId: '123@c.us', chatName: 'Real Name' }]);
  check('repair: idempotent (no churn)', again.updated === 0, JSON.stringify(again));
}

// --- meta ---------------------------------------------------------------------------
{
  await idb.setMeta('schema', 1);
  check('meta roundtrip', (await idb.getMeta('schema')) === 1);
  check('missing meta -> null', (await idb.getMeta('nope')) === null);
}

// --- clearAll -----------------------------------------------------------------------
{
  await idb.clearAll();
  check('cleared messages', (await idb.countMessages()) === 0);
  check('cleared outbox', (await idb.getPendingCount()) === 0);
  check('cleared chats', (await idb.getChats()).length === 0);
  check('cleared meta', (await idb.getMeta('schema')) === null);
}

console.log(failures === 0 ? '\nALL IDB CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
