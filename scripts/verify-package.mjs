#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from './runtime-files.mjs';

const publicBuild = process.argv.includes('--public');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const stageSuffix = publicBuild ? '-public' : '';
const stage = path.join(root, 'dist', `waidrop-${manifest.version}${stageSuffix}`);
const zipPath = path.join(root, 'dist', `waidrop-${manifest.version}${stageSuffix}.zip`);
const allowedFiles = new Set(runtimeFiles);
const expectedDirs = new Set();
const failures = [];
const warnings = [];

for (const file of runtimeFiles) {
  let dir = path.posix.dirname(file);
  while (dir !== '.') {
    expectedDirs.add(dir);
    dir = path.posix.dirname(dir);
  }
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function relative(file) {
  return path.relative(root, file);
}

function reportFailures() {
  if (!failures.length) return;
  const unique = [...new Set(failures)];
  console.error('Package verification failed:');
  for (const failure of unique) console.error(`- ${failure}`);
  process.exitCode = 1;
}

try {
  await lstat(zipPath);
} catch {
  console.error(`Missing ${relative(zipPath)}. Run npm run build first.`);
  process.exit(1);
}

function readZipEntry(entry) {
  return execFileSync('unzip', ['-p', zipPath, entry], { maxBuffer: 10 * 1024 * 1024 });
}

const rawZipEntries = execFileSync('unzip', ['-Z1', zipPath], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
})
  .split(/\r?\n/)
  .filter(Boolean);
const zipFiles = new Set();
const zipDirs = new Set();
const seenZipEntries = new Set();

for (const raw of rawZipEntries) {
  if (raw.startsWith('/') || raw.includes('\\') || raw.split('/').includes('..')) {
    fail(`Unsafe ZIP path: ${raw}`);
    continue;
  }
  const segments = raw.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) {
    fail(`Hidden path in ZIP: ${raw}`);
    continue;
  }
  const normalized = raw.replace(/\/+$/, '');
  if (!normalized) continue;
  if (seenZipEntries.has(normalized)) {
    fail(`Duplicate ZIP entry: ${raw}`);
    continue;
  }
  seenZipEntries.add(normalized);
  if (raw.endsWith('/')) zipDirs.add(normalized);
  else zipFiles.add(normalized);
}

for (const file of zipFiles) {
  if (!allowedFiles.has(file)) fail(`Unexpected file in ZIP: ${file}`);
}
for (const file of runtimeFiles) {
  if (!zipFiles.has(file)) fail(`Missing file in ZIP: ${file}`);
}
for (const dir of zipDirs) {
  if (!expectedDirs.has(dir)) fail(`Unexpected directory in ZIP: ${dir}`);
}
for (const dir of expectedDirs) {
  if (!zipDirs.has(dir)) fail(`Missing directory in ZIP: ${dir}`);
}

const stageFiles = new Set();
const stageDirs = new Set();

async function walkStage(dir, base = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    fail(`Missing staging directory: ${relative(dir)}`);
    return;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      fail(`Symlink in staging directory: ${rel}`);
      continue;
    }
    if (entry.isDirectory()) {
      stageDirs.add(rel);
      await walkStage(path.join(dir, entry.name), rel);
    } else if (entry.isFile()) {
      stageFiles.add(rel);
    } else {
      fail(`Unsupported staging entry: ${rel}`);
    }
  }
}

await walkStage(stage);

for (const file of stageFiles) {
  if (!allowedFiles.has(file)) fail(`Unexpected file in staging directory: ${file}`);
}
for (const file of runtimeFiles) {
  if (!stageFiles.has(file)) fail(`Missing file in staging directory: ${file}`);
}
for (const dir of stageDirs) {
  if (!expectedDirs.has(dir)) fail(`Unexpected directory in staging directory: ${dir}`);
}
for (const dir of expectedDirs) {
  if (!stageDirs.has(dir)) fail(`Missing directory in staging directory: ${dir}`);
}

async function checkSourceTree(relDir) {
  let entries;
  try {
    entries = await readdir(path.join(root, relDir), { withFileTypes: true });
  } catch {
    fail(`Missing source directory: ${relDir}`);
    return;
  }
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      fail(`Symlink in source runtime directory: ${rel}`);
      continue;
    }
    if (entry.isDirectory()) {
      await checkSourceTree(rel);
      continue;
    }
    if (entry.isFile() && !allowedFiles.has(rel)) {
      fail(`Source runtime file is not in the package allowlist: ${rel}`);
    }
  }
}

for (const dir of ['background', 'content', 'popup', 'utils']) {
  await checkSourceTree(dir);
}

// The public build rewrites these files at build time; every other runtime
// file must match the source tree byte-for-byte.
const variantFiles = new Set(['utils/buildFlags.js', 'popup/popup.html']);

for (const file of runtimeFiles) {
  let sourceBytes;
  let stageBytes;
  let zipBytes;
  try {
    sourceBytes = await readFile(path.join(root, file));
    stageBytes = await readFile(path.join(stage, file));
    zipBytes = readZipEntry(file);
  } catch (error) {
    fail(`Could not compare ${file}: ${error.message}`);
    continue;
  }
  if (!stageBytes.equals(zipBytes)) {
    fail(`ZIP is stale for ${file}; run npm run build.`);
  }
  if (publicBuild && variantFiles.has(file)) continue;
  if (!sourceBytes.equals(stageBytes)) {
    fail(`Staging directory is stale for ${file}; run npm run build.`);
  }
}

function addManifestRef(value, label) {
  if (typeof value !== 'string') return;
  if (/^(?:https?:)?\/\//i.test(value)) {
    fail(`Manifest ${label} references remote code: ${value}`);
    return;
  }
  const normalized = value.replace(/^\/+/, '');
  if (!allowedFiles.has(normalized)) {
    fail(`Manifest ${label} references a missing runtime file: ${value}`);
  }
}

if (manifest.manifest_version !== 3) fail('manifest.json must use manifest_version 3');
addManifestRef(manifest.background?.service_worker, 'background.service_worker');
addManifestRef(manifest.action?.default_popup, 'action.default_popup');

if (typeof manifest.action?.default_icon === 'string') {
  addManifestRef(manifest.action.default_icon, 'action.default_icon');
} else {
  for (const [size, icon] of Object.entries(manifest.action?.default_icon || {})) {
    addManifestRef(icon, `action.default_icon.${size}`);
  }
}

for (const [size, icon] of Object.entries(manifest.icons || {})) {
  addManifestRef(icon, `icons.${size}`);
}

for (const [index, script] of (manifest.content_scripts || []).entries()) {
  for (const file of script.js || []) addManifestRef(file, `content_scripts[${index}].js`);
  for (const file of script.css || []) addManifestRef(file, `content_scripts[${index}].css`);
  for (const match of script.matches || []) {
    if (match !== 'https://web.whatsapp.com/*') {
      fail(`Unexpected content script match: ${match}`);
    }
  }
}

addManifestRef(manifest.options_page, 'options_page');
addManifestRef(manifest.options_ui?.page, 'options_ui.page');
addManifestRef(manifest.devtools_page, 'devtools_page');
addManifestRef(manifest.side_panel?.default_path, 'side_panel.default_path');

for (const [key, value] of Object.entries(manifest.chrome_url_overrides || {})) {
  addManifestRef(value, `chrome_url_overrides.${key}`);
}

for (const page of manifest.sandbox?.pages || []) {
  addManifestRef(page, 'sandbox.pages');
}

for (const group of manifest.web_accessible_resources || []) {
  for (const resource of group.resources || []) {
    if (resource.includes('*')) warn(`Web accessible resource wildcard requires review: ${resource}`);
    else addManifestRef(resource, 'web_accessible_resources');
  }
}

const allowedPermissions = new Set(['storage', 'unlimitedStorage', 'alarms', 'identity', 'scripting']);
const allowedHosts = new Set([
  'https://web.whatsapp.com/*',
  'https://api.dropboxapi.com/*',
  'https://content.dropboxapi.com/*',
]);

for (const permission of manifest.permissions || []) {
  if (!allowedPermissions.has(permission)) fail(`Unexpected permission: ${permission}`);
}
for (const permission of manifest.optional_permissions || []) {
  fail(`Unexpected optional permission: ${permission}`);
}
for (const host of manifest.host_permissions || []) {
  if (!allowedHosts.has(host)) fail(`Unexpected host permission: ${host}`);
}
for (const host of manifest.optional_host_permissions || []) {
  fail(`Unexpected optional host permission: ${host}`);
}

const csp = JSON.stringify(manifest.content_security_policy || {});
if (/unsafe-eval/i.test(csp)) fail('Manifest CSP allows unsafe-eval');
if (/https?:/i.test(csp)) fail('Manifest CSP references a remote source');

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const file of runtimeFiles.filter((entry) => entry.endsWith('.png'))) {
  const bytes = readZipEntry(file);
  if (bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    fail(`Invalid PNG: ${file}`);
  }
}

const secretPatterns = [
  { label: 'private key', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'Stripe secret key', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: 'client secret literal', re: /client_secret\s*[:=]\s*['"][^'"]{8,}['"]/i },
];

const assignmentPattern =
  /([A-Za-z_$][\w$]*(?:key|secret|token|password|passwd|credential)[\w$]*)\s*[:=]\s*['"]([^'"]{24,})['"]/i;
const piiPatterns = [
  { label: 'absolute user path', re: /(?:\/Users\/[^/\s'"]+\/|\/home\/[^/\s'"]+\/|[A-Za-z]:\\Users\\[^\\\s'"]+\\)/ },
  {
    label: 'private IP address',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  { label: 'loopback address', re: /\b(?:localhost|127\.0\.0\.1)\b/i },
  { label: 'internal host', re: /\bhermes\b/i },
  { label: 'insecure URL', re: /\bhttp:\/\//i },
];
const codePatterns = [
  { label: 'eval', re: /\beval\s*\(/ },
  { label: 'new Function', re: /\bnew\s+Function\s*\(/ },
  { label: 'dynamic import', re: /\bimport\s*\(/ },
  { label: 'remote script', re: /<script[^>]+src\s*=\s*["']https?:/i },
  { label: 'remote importScripts', re: /\bimportScripts\s*\(\s*["']https?:/i },
  { label: 'remote worker', re: /\bnew\s+(?:Worker|SharedWorker)\s*\(\s*["']https?:/i },
  { label: 'source map reference', re: /\/\/[#@]\s*sourceMappingURL=/ },
];
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const allowedEmails = new Set(['waidrop@tnkrd.com']);

function stripComment(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return '';
  }
  return line.replace(/\/\/.*$/, '').replace(/<!--.*?-->/g, '');
}

function secretLike(value) {
  if (value.length < 24) return false;
  if (/^https?:\/\//i.test(value) || value.includes('/')) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  return new Set(value).size >= 8;
}

function scanText(file, content) {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    for (const rule of secretPatterns) {
      if (rule.re.test(line)) fail(`${rule.label} in ${file}:${lineNumber}`);
    }
    const assignment = line.match(assignmentPattern);
    if (assignment && secretLike(assignment[2])) {
      fail(`possible high-entropy secret assignment (${assignment[1]}) in ${file}:${lineNumber}`);
    }
    for (const rule of piiPatterns) {
      if (rule.re.test(line)) fail(`${rule.label} in ${file}:${lineNumber}`);
    }
    for (const match of line.matchAll(emailPattern)) {
      if (!allowedEmails.has(match[0].toLowerCase())) {
        fail(`unexpected email address in ${file}:${lineNumber}: ${match[0]}`);
      }
    }
    const code = stripComment(line);
    if (!code) continue;
    for (const rule of codePatterns) {
      if (rule.re.test(code)) fail(`${rule.label} in ${file}:${lineNumber}`);
    }
  }
}

for (const file of runtimeFiles.filter((entry) => !entry.endsWith('.png'))) {
  scanText(file, readZipEntry(file).toString('utf8'));
}

if (publicBuild) {
  const publicFlags = await readFile(path.join(root, 'tools/release/buildFlags.public.js'));
  if (!readZipEntry('utils/buildFlags.js').equals(publicFlags)) {
    fail('Public ZIP utils/buildFlags.js does not match tools/release/buildFlags.public.js');
  }
  // The checkbox must be gone from the user-facing surface; popup.js keeps a
  // null-safe dead path that references the element id, which is not shipped UI.
  const publicPopupHtml = readZipEntry('popup/popup.html').toString('utf8');
  if (/setMediaViewOnce/.test(publicPopupHtml)) {
    fail('Public ZIP popup.html still contains the view-once checkbox');
  }
  // Active media downloads are personal-build only.
  if (
    /ACTIVE_MEDIA_(?:BEGIN|END)/.test(publicPopupHtml) ||
    /name="mediaMode"\s+value="active"/.test(publicPopupHtml)
  ) {
    fail('Public ZIP popup.html still contains the active media option');
  }
  if (!/Disappearing\/self-destructing media is not captured\./.test(publicPopupHtml)) {
    fail('Public ZIP popup.html is missing the public consent media wording');
  }
  if (/Disappearing\/self-destructing media is off by default\./.test(publicPopupHtml)) {
    fail('Public ZIP popup.html contains the personal consent media wording');
  }
  // Developer info (Dropbox scopes + redirect URI) is personal-build only.
  if (/Required Dropbox app scopes|chromiumapp\.org|DEVELOPER_BEGIN/.test(publicPopupHtml)) {
    fail('Public ZIP popup.html still contains developer info');
  }
  for (const file of zipFiles) {
    if (file.endsWith('.png')) continue;
    const content = readZipEntry(file).toString('utf8');
    if (/view-once/i.test(content)) {
      fail(`Public ZIP contains view-once copy in ${file}`);
    }
  }
} else {
  const sourceFlags = await readFile(path.join(root, 'utils/buildFlags.js'));
  if (!readZipEntry('utils/buildFlags.js').equals(sourceFlags)) {
    fail('Personal ZIP utils/buildFlags.js differs from the source tree');
  }
  const personalPopupHtml = readZipEntry('popup/popup.html').toString('utf8');
  if (!/setMediaViewOnce/.test(personalPopupHtml)) {
    fail('Personal ZIP popup.html is missing the view-once checkbox');
  }
  if (
    !/ACTIVE_MEDIA_BEGIN[\s\S]*?ACTIVE_MEDIA_END/.test(personalPopupHtml) ||
    !/name="mediaMode"\s+value="active"/.test(personalPopupHtml)
  ) {
    fail('Personal ZIP popup.html is missing the active media option');
  }
  if (
    !/DEVELOPER_BEGIN[\s\S]*?DEVELOPER_END/.test(personalPopupHtml) ||
    !/Required Dropbox app scopes/.test(personalPopupHtml)
  ) {
    fail('Personal ZIP popup.html is missing the developer info block');
  }
  console.warn(
    'PERSONAL BUILD VERIFIED: this ZIP contains view-once media capture and active media downloads. ' +
      'It must never be submitted to the Chrome Web Store.'
  );
}

if (warnings.length) {
  console.warn('Package verification warnings:');
  for (const warning of warnings) console.warn(`- ${warning}`);
}

reportFailures();

if (!failures.length) {
  console.log(`Package verified: ${runtimeFiles.length} runtime files in ${relative(zipPath)}`);
}
