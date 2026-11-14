/**
 * Archive mode contract: the retired plaintext mode is read-only and every
 * write path fails closed. The shipped extension must never write plaintext
 * objects or unkeyed paths.
 *
 *   node tests/archive-mode.test.mjs
 */
import {
  parseArchiveMode,
  normalizeArchiveMode,
  isEncryptedMode,
  objectExtension,
  chatObjectExtension,
  mediaObjectExtension,
  chatHashForMode,
  mediaHashForMode,
  encodeObject,
  encodeMedia,
  decodeObject,
  decodeMedia,
} from '../background/archiveCodec.js';
import { deriveKeys } from '../background/crypto.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const throws = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return true;
  }
};
const rejects = async (promise) => {
  try {
    await promise;
    return false;
  } catch (e) {
    return true;
  }
};

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const keys = await deriveKeys(KEY);

check('parse: encrypted', parseArchiveMode('encrypted') === 'encrypted');
check('parse: retired plaintext is readable', parseArchiveMode('plaintext') === 'plaintext');
check('parse: unknown is null', parseArchiveMode('bogus') === null && parseArchiveMode(undefined) === null);

check('normalize: encrypted passes', normalizeArchiveMode('encrypted') === 'encrypted');
check('normalize: plaintext write rejected', throws(() => normalizeArchiveMode('plaintext')));
check('normalize: missing write rejected', throws(() => normalizeArchiveMode(undefined)));
check('normalize: unknown write rejected', throws(() => normalizeArchiveMode('bogus')));
check('isEncryptedMode fails closed', throws(() => isEncryptedMode('plaintext')));

check('object extension rejects plaintext', throws(() => objectExtension('plaintext')));
check('chat extension rejects plaintext', throws(() => chatObjectExtension('plaintext')));
check('media extension rejects plaintext', throws(() => mediaObjectExtension('plaintext')));
check('chat hash rejects plaintext', await rejects(chatHashForMode('plaintext', keys, '123@c.us')));
check('media hash rejects plaintext', await rejects(mediaHashForMode('plaintext', keys, 'MSG-1')));
check('object encode rejects plaintext', await rejects(encodeObject('plaintext', keys, 'secret')));
check(
  'media encode rejects plaintext',
  await rejects(encodeMedia('plaintext', keys, 'chat=00/media-00.bin', new Uint8Array([1, 2, 3])))
);

const encryptedObject = await encodeObject('encrypted', keys, 'secret text');
check('encrypted object round-trips', (await decodeObject('encrypted', keys, encryptedObject)) === 'secret text');
check(
  'plaintext decode remains read-only compatible',
  (await decodeObject('plaintext', keys, new TextEncoder().encode('legacy text'))) === 'legacy text'
);

const plainMedia = new TextEncoder().encode('legacy media bytes');
check(
  'plaintext media decode remains read-only compatible',
  (await decodeMedia('plaintext', keys, 'chat=00/media-00.bin', plainMedia)).length === plainMedia.length
);

console.log(failures === 0 ? '\nALL ARCHIVE MODE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
