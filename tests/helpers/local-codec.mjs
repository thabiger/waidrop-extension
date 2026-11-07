import * as idb from '../../background/idb.js';
import { createLocalCodec } from '../../background/localCrypto.js';

export const TEST_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

export async function installLocalCodec(key = TEST_KEY) {
  const codec = await createLocalCodec(key);
  idb.setLocalCodec(codec);
  return codec;
}
