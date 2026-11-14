/**
 * Loader for background/inject-main.js in jsdom tests.
 *
 * Production injects the MAIN-world hook via chrome.scripting executeScript
 * with the per-session bridge key as an argument, so the file is an ES
 * module exporting hookMain(). Tests eval it as a plain script inside the
 * jsdom window and call hookMain() explicitly with a fixed test key.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Fixed test-only key. Every value here is public by definition; the point
// of the tests is that the key never leaks and that possession of it alone
// no longer authenticates anything (only a valid MAC does).
export const TEST_BRIDGE_KEY = '00112233445566778899aabbccddeeff0123456789abcdef0123456789abcdef';

export function readMainHookSrc() {
  return readFileSync(path.join(root, 'background', 'inject-main.js'), 'utf8');
}

export function startMainHook(window, key = TEST_BRIDGE_KEY, options = { testApi: true }) {
  const src = readMainHookSrc().replace(/^export\s+function\s+hookMain/m, 'function hookMain');
  window.eval(src);
  if (typeof window.hookMain !== 'function') {
    throw new Error('hookMain not defined after eval - did the export shape change?');
  }
  window.hookMain(key, options);
}
