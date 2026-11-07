/**
 * Local archive encryption: record/chat/media round-trips, key mismatch and
 * legacy plaintext detection.
 */
import { createLocalCodec } from '../background/localCrypto.js';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OTHER_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const codec = await createLocalCodec(KEY);
const other = await createLocalCodec(OTHER_KEY);

const record = {
  msgId: 'M1',
  chatId: '123@g.us',
  chatName: 'Family',
  senderName: 'Jane',
  senderPhone: '49170000000',
  text: 'hello secret',
  ts: 1792224000000,
  capturedAt: 1792224000100,
  type: 'chat',
  isGroup: true,
  isGroupKey: 1,
  sortTs: 1792224000000,
};

{
  const sealed = await codec.sealRecord(record);
  check('record sealed', !!sealed.payloadEnc && !sealed.text && !sealed.chatName, JSON.stringify(Object.keys(sealed)));
  const opened = await codec.openRecord(sealed);
  check(
    'record round-trip',
    opened.text === record.text && opened.chatName === record.chatName && opened.senderPhone === record.senderPhone
  );
  let wrong = false;
  try {
    await other.openRecord(sealed);
  } catch (e) {
    wrong = /key-mismatch/.test(String(e.message));
  }
  check('record wrong key rejected', wrong);
}

{
  const chat = {
    chatId: '123@g.us',
    chatName: 'Family',
    chatPhone: '49170000000',
    chatPushname: 'Family Push',
    mapUploadedName: 'Family',
    mapUploadedPhone: '49170000000',
    isGroup: true,
    isGroupKey: 1,
  };
  const sealed = await codec.sealChat(chat);
  check('chat sealed', !!sealed.chatEnc && !sealed.chatName && !sealed.mapUploadedName);
  const opened = await codec.openChat(sealed);
  check('chat round-trip', opened.chatName === chat.chatName && opened.mapUploadedName === 'Family');
}

{
  const bytes = new TextEncoder().encode('secret-media');
  const media = { msgId: 'M1', chatId: '123@g.us', bytes, byteLength: bytes.byteLength, status: 'pending' };
  const sealed = await codec.sealMedia(media);
  check('media sealed', !!sealed.bytesEnc && sealed.bytes == null);
  const opened = await codec.openMedia(sealed);
  check(
    'media round-trip',
    opened.bytes instanceof Uint8Array && Buffer.from(opened.bytes).toString() === 'secret-media'
  );
  let wrong = false;
  try {
    await other.openMedia(sealed);
  } catch (e) {
    wrong = /key-mismatch/.test(String(e.message));
  }
  check('media wrong key rejected', wrong);
}

{
  let legacy = false;
  try {
    await codec.openRecord({ ...record });
  } catch (e) {
    legacy = /legacy-plaintext-local-archive/.test(String(e.message));
  }
  check('legacy plaintext record rejected', legacy);
}

{
  const cleared = await codec.openRecord({ msgId: 'M2', payloadCleared: true, chatId: '123@g.us' });
  check('offloaded stub opens without payload', cleared && cleared.payloadCleared === true);
}

console.log(failures === 0 ? '\nALL LOCAL CRYPTO CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
