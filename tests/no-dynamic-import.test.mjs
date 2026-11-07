/**
 * MV3 service workers reject dynamic import(). Keep runtime files free of it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'background/background.js',
  'background/archivePolicy.js',
  'background/installInfo.js',
  'background/localCrypto.js',
  'background/uploader.js',
  'background/offload.js',
  'background/mediaRepair.js',
  'background/archiveReader.js',
  'background/archiveCodec.js',
  'content/content.js',
  'background/inject-main.js',
  'popup/popup.js',
  'utils/messageParser.js',
  'utils/mediaSettings.js',
];

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

for (const file of files) {
  const source = readFileSync(path.join(root, file), 'utf8');
  check(`${file} has no dynamic import()`, !/\bimport\s*\(/.test(source));
}

console.log(failures === 0 ? '\nALL DYNAMIC IMPORT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
