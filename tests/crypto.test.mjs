/**
 * Crypto contract tests (must match waidrop-cli/tests/test_crypto.py).
 *
 *   node tests/crypto.test.mjs
 */
import {
  bytesToBase64,
  chatHash,
  decryptObject,
  deriveKeys,
  encryptObject,
  generateMasterKey,
  isValidMasterKey,
} from '../background/crypto.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

// Known-answer fixture shared with the Python CLI tests.
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const NONCE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const PLAINTEXT = 'hello archive';
const EXPECTED_ENVELOPE_HEX =
  '5741415201000102030405060708090a0b2109e73aa5a338c3a33a3b2e2f3ec1b69f67ed340a8f63ae39807c464f';
const EXPECTED_CHAT_HASH = '8e59af6366e6c4aa';

const keys = await deriveKeys(KEY);

check('key generation is 32-byte base64', (() => {
  const generated = generateMasterKey();
  return isValidMasterKey(generated);
})());
check('invalid keys rejected', !isValidMasterKey('abc') && !isValidMasterKey(bytesToBase64(new Uint8Array(16))));
check('derivation rejects short keys', await (async () => {
  try {
    await deriveKeys(bytesToBase64(new Uint8Array(16)));
    return false;
  } catch (e) {
    return /32 bytes/.test(String(e && e.message));
  }
})());

const envelope = await encryptObject(keys, PLAINTEXT, { nonce: NONCE });
check('known-answer envelope', Buffer.from(envelope).toString('hex') === EXPECTED_ENVELOPE_HEX, Buffer.from(envelope).toString('hex'));
check('envelope magic/version', Buffer.from(envelope).toString('hex').startsWith('5741415201'));

check('chat hash known answer', (await chatHash(keys, '49171234567@c.us')) === EXPECTED_CHAT_HASH);
check('chat hash is 16 lowercase hex', /^[0-9a-f]{16}$/.test(await chatHash(keys, 'anything@lid')));
check('chat hash differs per chat', (await chatHash(keys, 'a@lid')) !== (await chatHash(keys, 'b@lid')));

check('roundtrip decrypt', (await decryptObject(keys, envelope)) === PLAINTEXT);

check('tampered envelope fails', await (async () => {
  const copy = Uint8Array.from(envelope);
  copy[copy.length - 1] ^= 0xff;
  try {
    await decryptObject(keys, copy);
    return false;
  } catch (e) {
    return true;
  }
})());

check('wrong key fails', await (async () => {
  const other = await deriveKeys(bytesToBase64(new Uint8Array(32).fill(9)));
  try {
    await decryptObject(other, envelope);
    return false;
  } catch (e) {
    return true;
  }
})());

console.log(failures === 0 ? '\nALL CRYPTO CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
