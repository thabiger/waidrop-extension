/**
 * Integration test: runs the real content script + parser inside jsdom with a
 * stubbed chrome.runtime and a realistic #main fixture, then asserts what the
 * service worker would have received.
 *
 *   node tests/content.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consentSrc = readFileSync(path.join(root, 'utils', 'consent.js'), 'utf8');
const mediaSettingsSrc = readFileSync(path.join(root, 'utils', 'mediaSettings.js'), 'utf8');
const parserSrc = readFileSync(path.join(root, 'utils', 'messageParser.js'), 'utf8');
const contentSrc = readFileSync(path.join(root, 'content', 'content.js'), 'utf8');

const html = `<!DOCTYPE html><html><body>
<div id="app">
  <div id="main">
    <header data-testid="conversation-header">
      <span data-testid="conversation-info-header-chat-title">Test Chat</span>
      <span data-testid="chat-subtitle">online</span>
    </header>
    <div data-testid="conversation-panel-messages"><div>
      <div role="row">
        <div data-id="IN-1" data-testid="conv-msg-IN-1"><div data-virtualized="false">
          <div class="host">
            <div data-testid="msg-container">
              <span data-icon="tail-in"></span>
              <div class="copyable-text" data-pre-plain-text="[13:45, 17.10.2026] Jane: ">
                <span data-testid="selectable-text" dir="ltr">Hello there</span>
              </div>
              <div data-testid="msg-meta"><span>13:45</span></div>
            </div>
          </div>
        </div></div>
      </div>
      <div role="row">
        <div data-id="OUT-1" data-testid="conv-msg-OUT-1"><div data-virtualized="false">
          <div class="host">
            <div data-testid="msg-container">
              <span data-icon="tail-out"></span>
              <div class="copyable-text" data-pre-plain-text="[13:46, 17.10.2026] Me: ">
                <span data-testid="selectable-text" dir="ltr">My reply</span>
              </div>
              <div data-testid="msg-meta" role="button"><span>13:46</span></div>
            </div>
          </div>
        </div></div>
      </div>
      <div role="row">
        <div data-id="SYS-1" data-testid="conv-msg-SYS-1"><div data-virtualized="false">
          <div data-testid="msg-notification-container"><span data-testid="system_message">Encryption notice</span></div>
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
      if (callback) callback({ status: 'stored', stats: {} });
    },
    onMessage: { addListener() {} },
  },
  storage: {
    local: {
      async get() {
        return { waidropConsent: { version: 1, acceptedAt: Date.now() }, settings: {} };
      },
    },
    onChanged: { addListener() {} },
  },
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

window.eval(consentSrc);
window.eval(mediaSettingsSrc);
window.eval(parserSrc);
window.eval(contentSrc);

await new Promise((resolve) => setTimeout(resolve, 1500));

check('content script sent CONTENT_SCRIPT_READY', sent.some((m) => m.type === 'CONTENT_SCRIPT_READY'));

const batches = sent.filter((m) => m.type === 'MESSAGE_BATCH');
check('at least one MESSAGE_BATCH sent', batches.length >= 1, String(batches.length));

const records = batches.flatMap((b) => b.records || []);
check('two user records captured (system skipped)', records.length === 2, JSON.stringify(records.map((r) => r.msgId)));

const inRec = records.find((r) => r.msgId === 'IN-1');
const outRec = records.find((r) => r.msgId === 'OUT-1');
check('IN-1 parsed', !!inRec);
check('OUT-1 parsed', !!outRec);
check('IN-1 direction in', inRec && inRec.direction === 'in');
check('OUT-1 direction out', outRec && outRec.direction === 'out');
check('IN-1 text', inRec && inRec.text === 'Hello there', inRec && inRec.text);
check('IN-1 sender from pre-plain', inRec && inRec.senderName === 'Jane', inRec && inRec.senderName);
check('IN-1 timestamp parsed', inRec && inRec.ts === new Date(2026, 9, 17, 13, 45).getTime(), String(inRec && inRec.ts));
check('chat name from header', inRec && inRec.chatName === 'Test Chat', inRec && inRec.chatName);
check('records are plain serializable objects', (() => {
  try {
    const clone = JSON.parse(JSON.stringify(records));
    return clone.length === records.length && typeof clone[0].msgId === 'string';
  } catch (e) {
    return false;
  }
})());

// --- scoped #main observer: added cells are parsed directly ------------------
{
  const panel = window.document.querySelector('[data-testid="conversation-panel-messages"] > div');
  const row = window.document.createElement('div');
  row.setAttribute('role', 'row');
  row.innerHTML = `<div data-id="NEW-1" data-testid="conv-msg-NEW-1"><div data-virtualized="false">
    <div class="host">
      <div data-testid="msg-container">
        <span data-icon="tail-in"></span>
        <div class="copyable-text" data-pre-plain-text="[13:47, 17.10.2026] Jane: ">
          <span data-testid="selectable-text" dir="ltr">New message</span>
        </div>
      </div>
    </div>
  </div></div>`;
  panel.appendChild(row);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const laterRecords = sent
    .filter((message) => message.type === 'MESSAGE_BATCH')
    .flatMap((batch) => batch.records || []);
  const newRecord = laterRecords.find((record) => record.msgId === 'NEW-1');
  check('scoped observer captures a newly added message', !!newRecord);
  check('scoped observer parses text', newRecord && newRecord.text === 'New message', newRecord && newRecord.text);
}

// --- failed batches are retried, never silently dropped ----------------------
{
  const retryDom = new JSDOM(html, {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const retryWindow = retryDom.window;
  const retried = [];
  let attempts = 0;
  let failedOnce = false;

  retryWindow.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        if (message.type === 'MESSAGE_BATCH') {
          attempts++;
          if (!failedOnce) {
            failedOnce = true;
            retryWindow.chrome.runtime.lastError = {
              message: 'Could not establish connection. Receiving end does not exist.',
            };
            if (callback) callback(undefined);
            retryWindow.chrome.runtime.lastError = undefined;
            return;
          }
          retried.push(message);
        }
        if (callback) callback({ status: 'stored', stats: {} });
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        async get() {
          return { waidropConsent: { version: 1, acceptedAt: Date.now() }, settings: {} };
        },
      },
      onChanged: { addListener() {} },
    },
  };

  retryWindow.eval(consentSrc);
  retryWindow.eval(mediaSettingsSrc);
  retryWindow.eval(parserSrc);
  retryWindow.eval(contentSrc);
  await new Promise((resolve) => setTimeout(resolve, 2800));

  const retryRecords = retried.flatMap((b) => b.records || []);
  check('failed batch is retried', attempts >= 2, String(attempts));
  check(
    'retry preserves the captured records',
    retryRecords.some((r) => r.msgId === 'IN-1') && retryRecords.some((r) => r.msgId === 'OUT-1'),
    JSON.stringify(retryRecords.map((r) => r.msgId))
  );
  retryDom.window.close();
}

// --- first-run consent gate: no capture before consent ----------------------
{
  const gateDom = new JSDOM(html, {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const gateWindow = gateDom.window;
  const gated = [];
  gateWindow.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        gated.push(message);
        if (callback) callback({ status: 'stored', stats: {} });
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        async get() {
          return {};
        },
      },
      onChanged: { addListener() {} },
    },
  };

  gateWindow.eval(consentSrc);
  gateWindow.eval(mediaSettingsSrc);
  gateWindow.eval(parserSrc);
  gateWindow.eval(contentSrc);
  await new Promise((resolve) => setTimeout(resolve, 500));

  check('no consent: content script stays idle', gated.length === 0, JSON.stringify(gated.map((m) => m.type)));
  gateDom.window.close();
}

console.log(failures === 0 ? '\nALL CONTENT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
