/**
 * Store-hook integration test: MAIN-world script + content script + parser in
 * one jsdom page with a fake window.require and a stubbed chrome.runtime.
 * Verifies that store messages reach MESSAGE_BATCH, that a store record
 * supersedes a same-msgId DOM record, and that store-only messages (chats the
 * user never opened) are captured.
 *
 *   node tests/store-hook.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { startMainHook } from './helpers/main-hook-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaSettingsSrc = readFileSync(path.join(root, 'utils', 'mediaSettings.js'), 'utf8');
const parserSrc = readFileSync(path.join(root, 'utils', 'messageParser.js'), 'utf8');
const contentSrc = readFileSync(path.join(root, 'content', 'content.js'), 'utf8');

const html = `<!DOCTYPE html><html><body>
<div id="app">
  <div id="main">
    <header data-testid="conversation-header">
      <span data-testid="conversation-info-header-chat-title">Open Chat</span>
    </header>
    <div data-testid="conversation-panel-messages"><div>
      <div role="row">
        <div data-id="3EB0TESTID" data-testid="conv-msg-3EB0TESTID"><div data-virtualized="false">
          <div class="host">
            <div data-testid="msg-container">
              <span data-icon="tail-out"></span>
              <div class="copyable-text" data-pre-plain-text="[13:46, 17.10.2026] Me: ">
                <span data-testid="selectable-text" dir="ltr">DOM copy</span>
              </div>
              <div data-testid="msg-meta" role="button"><span>13:46</span></div>
            </div>
          </div>
        </div></div>
      </div>
    </div></div>
  </div>
</div>
</body></html>`;

const dom = new JSDOM(html, { url: 'https://web.whatsapp.com/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

const sent = [];
window.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage(message, callback) {
      sent.push(message);
      if (callback) callback({ status: 'accepted' });
    },
  },
};

const listeners = {};
const fakeMsgCollection = {
  on(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  },
};
window.require = (name) => {
  if (name !== 'WAWebCollections') return undefined;
  return {
    Msg: fakeMsgCollection,
    Chat: { get: () => ({ name: 'Store Chat' }) },
  };
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const emit = (msg) => (listeners['add'] || []).forEach((cb) => cb(msg));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

window.__WAIDROP_EXPOSE_TEST_API__ = true;
// Plain jsdom: no MessageChannel, so both sides take the legacy bridge.
startMainHook(window);
window.eval(mediaSettingsSrc);
window.eval(parserSrc);
window.eval(contentSrc);

await sleep(400);
check('store hook initialized', window.__waArchiveMain.state.started === true);

emit({
  id: { id: '3EB0TESTID', _serialized: 'true_123@c.us_3EB0TESTID', fromMe: true, remote: { _serialized: '123@c.us' } },
  t: 1729166400,
  type: 'chat',
  body: 'Store copy',
});

emit({
  id: { id: 'STORE-ONLY-1', _serialized: 'false_999@g.us_STORE-ONLY-1', fromMe: false, remote: { _serialized: '999@g.us' } },
  t: 1729166500,
  type: 'chat',
  body: 'From a chat I never opened',
  author: { _serialized: '555@c.us' },
  notifyName: 'Alice',
});

await sleep(1500);

const records = sent.filter((m) => m.type === 'MESSAGE_BATCH').flatMap((b) => b.records || []);

const dup = records.filter((r) => r.msgId === '3EB0TESTID');
check('same-msgId: single record after upsert', dup.length === 1, JSON.stringify(dup.map((r) => r.source)));
check('same-msgId: store record superseded DOM record', dup.length === 1 && dup[0].source === 'store', dup[0] && dup[0].text);

const storeOnly = records.find((r) => r.msgId === 'STORE-ONLY-1');
check('store-only message captured (chat never opened)', !!storeOnly);
check('store-only: chatId jid', storeOnly && storeOnly.chatId === '999@g.us', storeOnly && storeOnly.chatId);
check('store-only: real server ts', storeOnly && storeOnly.ts === 1729166500000, String(storeOnly && storeOnly.ts));
check('store-only: sender from author', storeOnly && storeOnly.senderId === '555@c.us');

window.__waArchiveMain.stop();

console.log(failures === 0 ? '\nALL STORE HOOK CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
