/**
 * Parser tests: unit coverage for time/date parsing, direction cascade and
 * full-row parsing against real (sanitized) DOM fixtures captured from the
 * live WhatsApp Web build on 2026-10-17.
 *
 *   node tests/parse.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parserSrc = readFileSync(path.join(root, 'utils', 'messageParser.js'), 'utf8');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const loadParser = (html) => {
  const dom = new JSDOM(html, { url: 'https://web.whatsapp.com/', runScripts: 'outside-only' });
  dom.window.eval(parserSrc);
  return { dom, parser: dom.window.WAControlParser };
};

const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime();

// --- unit: parsePrePlainText ------------------------------------------------
{
  const { parser } = loadParser('<html><body></body></html>');
  const de = parser.parsePrePlainText('[13:45, 17.10.2026] Jane: ', { locale: 'de-DE', now: NOW });
  check('de timestamp', de.ts === new Date(2026, 9, 17, 13, 45).getTime(), String(de.ts));
  check('de sender', de.sender === 'Jane', String(de.sender));

  const us = parser.parsePrePlainText('[7:32 AM, 10/17/2026] John: ', { locale: 'en-US', now: NOW });
  check('us timestamp (AM)', us.ts === new Date(2026, 9, 17, 7, 32).getTime(), String(us.ts));

  const de2 = parser.parsePrePlainText('[10:00, 05.10.26] Bob: ', { locale: 'de-DE', now: NOW });
  check('2-digit year + day-first', de2.ts === new Date(2026, 9, 5, 10, 0).getTime(), String(de2.ts));

  const us2 = parser.parsePrePlainText('[10:00, 05.10.2026] Bob: ', { locale: 'en-US', now: NOW });
  check('ambiguous date follows en-US month-first', us2.ts === new Date(2026, 4, 10, 10, 0).getTime(), String(us2.ts));

  const de3 = parser.parsePrePlainText('[10:00, 05.11.2026] Bob: ', { locale: 'de-DE', now: NOW });
  check('future-guard overrides day-first when day-first is future', de3.ts === new Date(2026, 4, 11, 10, 0).getTime(), String(de3.ts));

  const unamb = parser.parsePrePlainText('[13:45, 17.10.2026] Jane: ', { locale: 'en-US', now: NOW });
  check('unambiguous dd.mm parsed regardless of locale', unamb.ts === new Date(2026, 9, 17, 13, 45).getTime());

  const bad = parser.parsePrePlainText('totally not a preplain', { locale: 'de-DE' });
  check('garbage -> nulls', bad.ts === null && bad.sender === null);

  check('time only -> ts null', parser.parsePrePlainText('[10:00] X: ', { locale: 'de-DE' }).ts === null);

  check('parseTimeOfDay pm', (() => { const t = parser.parseTimeOfDay('7:32 pm'); return t.hours === 19 && t.minutes === 32; })());
  check('parseTimeOfDay midnight', (() => { const t = parser.parseTimeOfDay('12:00 AM'); return t.hours === 0; })());
  check('parseTimeOfDay invalid', parser.parseTimeOfDay('25:99') === null);
}

// --- unit: direction cascade -------------------------------------------------
{
  const row = (inner) => `<div id="main"><div role="application"><div role="row">
    <div data-id="TEST-1" data-testid="conv-msg-TEST-1"><div data-virtualized="false">
      <div class="host"><div data-testid="msg-container">${inner}</div></div>
    </div></div></div></div></div>`;

  const tailOut = loadParser(row('<span data-icon="tail-out"></span>'));
  let r = tailOut.parser.parseMessageRow(tailOut.dom.window.document.querySelector('[role="row"]'), { chatName: 'C', isGroup: false });
  check('tail-out -> out', r && r.direction === 'out', r && r.direction);

  const tailIn = loadParser(row('<span data-icon="tail-in"></span>'));
  r = tailIn.parser.parseMessageRow(tailIn.dom.window.document.querySelector('[role="row"]'), { chatName: 'C', isGroup: false });
  check('tail-in -> in', r && r.direction === 'in', r && r.direction);

  const metaBtn = loadParser(row('<div data-testid="msg-meta" role="button"></div>'));
  r = metaBtn.parser.parseMessageRow(metaBtn.dom.window.document.querySelector('[role="row"]'), { chatName: 'C', isGroup: false });
  check('meta role=button -> out', r && r.direction === 'out', r && r.direction);

  const none = loadParser(row('<div data-testid="msg-meta"></div>'));
  r = none.parser.parseMessageRow(none.dom.window.document.querySelector('[role="row"]'), { chatName: 'C', isGroup: false });
  check('no signals -> unknown (jsdom has no layout)', r && r.direction === 'unknown', r && r.direction);
}

// --- fixture: DM incoming ----------------------------------------------------
{
  const html = readFileSync(path.join(root, 'tests', 'fixtures', 'message-in.html'), 'utf8');
  const { dom, parser } = loadParser(html);
  const row = dom.window.document.querySelector('#main [role="row"]');
  const cell = dom.window.document.querySelector('#main [data-testid^="conv-msg-"]');
  const expectedId = cell.getAttribute('data-id');
  const rec = parser.parseMessageRow(row, { chatName: 'Fixture Chat', isGroup: false });
  check('fixture dm-in: record parsed', !!rec);
  check('fixture dm-in: msgId from cell', rec.msgId === expectedId, rec.msgId);
  check('fixture dm-in: direction in', rec.direction === 'in', rec.direction);
  check('fixture dm-in: sender from pre-plain', rec.senderName === '«sender»', rec.senderName);
  check('fixture dm-in: text placeholder captured', rec.text.startsWith('«t:'), rec.text);
  check('fixture dm-in: type text', rec.type === 'text', rec.type);
  check('fixture dm-in: masked ts unparseable -> null ts', rec.ts === null, String(rec.ts));
  check('fixture dm-in: tsRaw kept', typeof rec.tsRaw === 'string' && rec.tsRaw.length > 0, rec.tsRaw);
  check('fixture dm-in: schema v1 + source', rec.v === 1 && rec.source === 'dom');
}

// --- fixture: DM outgoing ----------------------------------------------------
{
  const html = readFileSync(path.join(root, 'tests', 'fixtures', 'message-out.html'), 'utf8');
  const { dom, parser } = loadParser(html);
  const row = dom.window.document.querySelector('#main [role="row"]');
  const rec = parser.parseMessageRow(row, { chatName: 'Fixture Chat', isGroup: false });
  check('fixture dm-out: direction out', rec && rec.direction === 'out', rec && rec.direction);
  check('fixture dm-out: type text', rec && rec.type === 'text');
}

// --- fixture: group incoming (author present) --------------------------------
{
  const html = readFileSync(path.join(root, 'tests', 'fixtures', 'group-message-in.html'), 'utf8');
  const { dom, parser } = loadParser(html);
  const row = dom.window.document.querySelector('#main [role="row"]');
  const rec = parser.parseMessageRow(row, { chatName: 'Fixture Group', isGroup: true });
  check('fixture group-in: direction in', rec && rec.direction === 'in', rec && rec.direction);
  check('fixture group-in: isGroup flag from ctx', rec && rec.isGroup === true);
  check('fixture group-in: sender from author element', rec && typeof rec.senderName === 'string' && rec.senderName.length > 0 && rec.senderName !== '«sender»', rec && rec.senderName);
}

// --- fixture: group system message -------------------------------------------
{
  const html = readFileSync(path.join(root, 'tests', 'fixtures', 'group-system.html'), 'utf8');
  const { dom, parser } = loadParser(html);
  const row = dom.window.document.querySelector('#main [role="row"]');
  check('fixture group-system: isSystemRow true', parser.isSystemRow(row) === true);
}

console.log(failures === 0 ? '\nALL PARSER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
