/**
 * Generates tests/fixtures/*.html from the sanitized probe outputs in
 * tools/recon/out/. Runs offline; never touches live WhatsApp data.
 *
 *   node tools/recon/make-fixtures.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'tests', 'fixtures');
const read = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));

const dm = read('tools/recon/out/dom-probe.json');
const grp = read('tools/recon/out/dom-probe-group.json');

const wrap = (rowHtml, opts = {}) => `<!DOCTYPE html>
<html><body>
<div id="main">
  <header data-testid="conversation-header">
    <span data-testid="conversation-info-header-chat-title">Fixture Chat</span>
    <span data-testid="chat-subtitle">${opts.isGroup ? 'group subtitle fixture' : 'online'}</span>
  </header>
  <div data-testid="conversation-panel-messages">
    <div>
${rowHtml}
    </div>
  </div>
</div>
</body></html>
`;

const pick = (rows, pred, label) => {
  const found = (rows || []).find(pred);
  if (!found) throw new Error(`fixture row not found: ${label}`);
  return found.sanitizedHTML;
};

const rows = (probe) => (probe.samples && probe.samples.rows) || [];
const hasTestid = (row, id) => (row.dataTestidsInRow || []).includes(id);

const dmIn = pick(
  rows(dm),
  (r) => r.directionGuess === 'incoming?' && hasTestid(r, 'msg-container'),
  'dm incoming'
);
const dmOut = pick(
  rows(dm),
  (r) => r.directionGuess === 'outgoing?' && hasTestid(r, 'msg-container'),
  'dm outgoing'
);
const grpIn = pick(
  rows(grp),
  (r) => r.directionGuess === 'incoming?' && hasTestid(r, 'author'),
  'group incoming'
);
const grpSys = pick(rows(grp), (r) => hasTestid(r, 'msg-notification-container'), 'group system');

writeFileSync(path.join(outDir, 'message-in.html'), wrap(dmIn));
writeFileSync(path.join(outDir, 'message-out.html'), wrap(dmOut));
writeFileSync(path.join(outDir, 'group-message-in.html'), wrap(grpIn, { isGroup: true }));
writeFileSync(path.join(outDir, 'group-system.html'), wrap(grpSys, { isGroup: true }));

console.log('fixtures written to tests/fixtures/');
