/**
 * WAiDrop - Popup Script (v4)
 * Reads the IndexedDB archive directly (same extension origin as the service
 * worker) and renders the newest records. Export downloads the whole archive
 * as NDJSON for local backup. Storage settings target the encrypted Dropbox
 * backend.
 */
import {
  countMessages,
  countMedia,
  countMediaByStatus,
  countMediaBytes,
  getRecentMessages,
  getPendingCount,
  getMeta,
  getMessagesForExport,
  getRepairCount,
  clearAll,
  countBlockedOutbox,
  setLocalCodec,
} from '../background/idb.js';
import { disconnect, getAuth } from '../background/dropbox.js';
import { generateMasterKey, isValidMasterKey } from '../background/crypto.js';
import { createLocalCodec } from '../background/localCrypto.js';
import { getActivityLog, getActivityLogClearedAt, clearActivityLog } from '../background/activityLog.js';
import { DEFAULT_ACCOUNT_ALIAS, DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';
import { getInstalledAt } from '../background/installInfo.js';
import { PRE_INSTALL_REASON } from '../background/archivePolicy.js';

const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const messagesContainer = document.getElementById('messagesContainer');
const messagesList = document.getElementById('messagesList');
const totalMessagesEl = document.getElementById('totalMessages');
const pendingUploadEl = document.getElementById('pendingUpload');
const totalMediaEl = document.getElementById('totalMedia');
const mediaModeStatusEl = document.getElementById('mediaModeStatus');
const pendingMediaEl = document.getElementById('pendingMedia');
const notDownloadedMediaEl = document.getElementById('notDownloadedMedia');
const localMediaBytesEl = document.getElementById('localMediaBytes');

const redirectUriEl = document.querySelector('.redirect-uri');
if (redirectUriEl && chrome.identity?.getRedirectURL) {
  redirectUriEl.textContent = chrome.identity.getRedirectURL();
}
const offloadedMessagesEl = document.getElementById('offloadedMessages');
const lastOffloadEl = document.getElementById('lastOffload');
const mediaPendingTotalEl = document.getElementById('mediaPendingTotal');
const repairPendingEl = document.getElementById('repairPending');
const lastSyncEl = document.getElementById('lastSync');
const refreshBtn = document.getElementById('refreshBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');

const setAccount = document.getElementById('setAccount');
const setEncryptionKey = document.getElementById('setEncryptionKey');
const setEncryptionKeyAcknowledged = document.getElementById('setEncryptionKeyAcknowledged');
const setEnabled = document.getElementById('setEnabled');
const setSyncPreInstall = document.getElementById('setSyncPreInstall');
const preInstallHintEl = document.getElementById('preInstallHint');
let setMediaViewOnce = document.getElementById('setMediaViewOnce');
const setMediaMaxMb = document.getElementById('setMediaMaxMb');
const setOffloadEnabled = document.getElementById('setOffloadEnabled');
const setOffloadRetentionDays = document.getElementById('setOffloadRetentionDays');
const offloadHintEl = document.getElementById('offloadHint');
const offloadStatusEl = document.getElementById('offloadStatus');
const runOffloadBtn = document.getElementById('runOffloadBtn');
const repairMediaBtn = document.getElementById('repairMediaBtn');
const mediaModeInputs = [...document.querySelectorAll('input[name="mediaMode"]')];
const mediaModeSummaryEl = document.getElementById('mediaModeSummary');
const mediaUploadsHintEl = document.getElementById('mediaUploadsHint');
const advancedMediaEl = document.querySelector('.advanced-media');
const generateKeyBtn = document.getElementById('generateKeyBtn');
const copyKeyBtn = document.getElementById('copyKeyBtn');
const connectDropboxBtn = document.getElementById('connectDropboxBtn');
const disconnectDropboxBtn = document.getElementById('disconnectDropboxBtn');
const dropboxStatusEl = document.getElementById('dropboxStatus');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const testBtn = document.getElementById('testBtn');
const uploadNowBtn = document.getElementById('uploadNowBtn');
const settingsStatusEl = document.getElementById('settingsStatus');
const logBox = document.getElementById('logBox');
const logOutput = document.getElementById('logOutput');
const logCountEl = document.getElementById('logCount');
const logErrorDot = document.getElementById('logErrorDot');
const clearLogBtn = document.getElementById('clearLogBtn');

const buildFlags = window.WABuildFlags || {
  allowViewOnceCapture: true,
  allowActiveMediaDownloads: true,
  developerMode: true,
};

{
  if (buildFlags.allowViewOnceCapture === false && setMediaViewOnce) {
    const label = setMediaViewOnce.closest('.settings-check-stacked');
    if (label) label.remove();
    else setMediaViewOnce.remove();
    setMediaViewOnce = null;
  }
  if (buildFlags.developerMode === false) {
    const developerInfo = document.getElementById('developerInfo');
    if (developerInfo) developerInfo.remove();
  }
}

const MAX_LOG_ENTRIES = 200;
let activityLog = [];
let storedSettings = {};
let localKeyReady = false;

const MediaSettings = window.WAMediaSettings || {
  activeMediaAllowed() {
    return buildFlags.allowActiveMediaDownloads !== false;
  },
  resolveMediaMode(settings) {
    const value = settings || {};
    if (value.mediaMode === 'off' || value.mediaMode === 'passive' || value.mediaMode === 'active') return value.mediaMode;
    if (value.mediaCaptureEnabled === false) return 'off';
    if (value.mediaActiveFetchEnabled === true) return 'active';
    return 'passive';
  },
  effectiveMediaMode(settings) {
    let mode = this.resolveMediaMode(settings);
    if (mode === 'active' && !this.activeMediaAllowed()) mode = 'passive';
    return mode;
  },
  legacyFromMode(mode) {
    let value = mode === 'off' || mode === 'active' ? mode : 'passive';
    if (value === 'active' && !this.activeMediaAllowed()) value = 'passive';
    return {
      mediaMode: value,
      mediaCaptureEnabled: value !== 'off',
      mediaActiveFetchEnabled: value === 'active',
    };
  },
};

const MEDIA_MODE_TEXT = {
  off: {
    short: 'Off',
    summary: 'Media mode: Off — no full-resolution media capture.',
  },
  passive: {
    short: 'Passive (no requests)',
    summary: 'Media mode: Passive — no WhatsApp media requests.',
  },
  active: {
    short: 'Active (may be recognized as automation)',
    summary: 'Media mode: Active — WhatsApp media requests enabled; may be recognized as automation.',
  },
};

if (buildFlags.allowActiveMediaDownloads === false) delete MEDIA_MODE_TEXT.active;

function selectedMediaMode() {
  const checked = mediaModeInputs.find((input) => input.checked);
  return checked ? checked.value : 'passive';
}

function updateMediaUploadsHint() {
  if (mediaUploadsHintEl) mediaUploadsHintEl.hidden = setEnabled.checked || selectedMediaMode() === 'off';
}

function syncMediaModeUI() {
  const mode = selectedMediaMode();
  const disabled = mode === 'off';
  if (setMediaViewOnce) setMediaViewOnce.disabled = disabled;
  setMediaMaxMb.disabled = disabled;
  if (advancedMediaEl) advancedMediaEl.classList.toggle('disabled', disabled);
  for (const input of mediaModeInputs) input.disabled = false;
  const text = MEDIA_MODE_TEXT[mode] || MEDIA_MODE_TEXT.passive;
  mediaModeStatusEl.textContent = text.short;
  mediaModeSummaryEl.textContent = text.summary;
  updateMediaUploadsHint();
}

function setMediaMode(mode) {
  const value = MEDIA_MODE_TEXT[mode] ? mode : 'passive';
  for (const input of mediaModeInputs) input.checked = input.value === value;
  syncMediaModeUI();
}

for (const input of mediaModeInputs) {
  input.addEventListener('change', syncMediaModeUI);
}
setEnabled.addEventListener('change', updateMediaUploadsHint);
for (const el of [
  setOffloadEnabled,
  setOffloadRetentionDays,
  setEnabled,
  setEncryptionKey,
]) {
  el.addEventListener('change', () => updateOffloadStatus());
  el.addEventListener('input', () => updateOffloadStatus());
}
for (const el of [setEncryptionKey]) {
  el.addEventListener('input', () => {
    setEncryptionKeyAcknowledged.checked = false;
    updateOffloadStatus();
  });
}

async function loadMessages() {
  statusEl.textContent = 'Loading...';
  statsEl.style.display = 'none';
  messagesContainer.style.display = 'none';

  if (!localKeyReady) {
    statusEl.textContent =
      'Archive locked. Enter the encryption key that created this archive, or clear the local archive to start over.';
    statusEl.style.display = 'block';
    return;
  }

  try {
    const [
      total,
      pending,
      totalMedia,
      pendingMedia,
      notDownloadedMedia,
      localMediaBytes,
      recent,
      lastSync,
      offloadedMessages,
      pendingRepairs,
      lastOffload,
      blockedPreInstall,
      installedAt,
    ] = await Promise.all([
      countMessages(),
      getPendingCount(),
      countMedia(),
      countMediaByStatus('pending'),
      countMediaByStatus('not_downloaded'),
      countMediaBytes(),
      getRecentMessages(20),
      getMeta('lastSync'),
      getMeta('offloadedCount'),
      getRepairCount(),
      getMeta('lastOffloadSweep'),
      countBlockedOutbox(PRE_INSTALL_REASON),
      getInstalledAt(),
    ]);

    totalMessagesEl.textContent = total;
    pendingUploadEl.textContent = pending;
    const installedLabel = new Date(installedAt).toLocaleDateString();
    if (blockedPreInstall > 0) {
      preInstallHintEl.textContent = `Installed ${installedLabel}. ${blockedPreInstall} older message(s) are waiting; enable full-history sync to upload them.`;
    } else {
      preInstallHintEl.textContent = `Installed ${installedLabel}. Only messages from installation onward are synced.`;
    }
    totalMediaEl.textContent = totalMedia;
    pendingMediaEl.textContent = pendingMedia;
    notDownloadedMediaEl.textContent = notDownloadedMedia;
    localMediaBytesEl.textContent = formatBytes(localMediaBytes);
    offloadedMessagesEl.textContent = Number(offloadedMessages) || 0;
    lastOffloadEl.textContent = lastOffload && lastOffload.at ? new Date(lastOffload.at).toLocaleString() : 'Never';
    mediaPendingTotalEl.textContent = pendingMedia + notDownloadedMedia;
    repairPendingEl.textContent = pendingRepairs;
    lastSyncEl.textContent = lastSync ? new Date(lastSync).toLocaleString() : 'Never';
    statsEl.style.display = 'block';

    if (!total) {
      statusEl.textContent = 'No messages stored yet. Open WhatsApp Web and keep it running.';
      statusEl.style.display = 'block';
      return;
    }

    statusEl.style.display = 'none';
    messagesContainer.style.display = 'block';
    messagesList.innerHTML = recent.map(renderRecord).join('');
  } catch (e) {
    statusEl.textContent = 'Failed to load archive: ' + (e && e.message ? e.message : e);
    statusEl.style.display = 'block';
    statsEl.style.display = 'block';
  }
}

function renderRecord(record) {
  const dirGlyph = record.direction === 'out' ? '→' : record.direction === 'in' ? '←' : '·';
  const when = record.ts ? new Date(record.ts) : record.capturedAt ? new Date(record.capturedAt) : null;
  const senderLabel = record.payloadCleared
    ? 'Archived'
    : record.direction === 'out'
      ? 'You'
      : record.senderName || 'Unknown';

  const MEDIA_TYPES = ['media', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'gif', 'vcard', 'location', 'live_location'];
  const text = String(record.text || '');
  const preview = record.type && MEDIA_TYPES.includes(record.type) && /^[A-Za-z0-9+/=\s]{200,}$/.test(text)
    ? '[preview omitted]'
    : text;
  let body;
  if (record.payloadCleared) {
    body = '[archived in Dropbox]';
  } else if (record.type === 'revoked') {
    body = '[deleted message]';
  } else if (MEDIA_TYPES.includes(record.type)) {
    body = preview ? `[${record.type}] ${preview}` : `[${record.type}]`;
  } else {
    body = preview || '[no text]';
  }

  const flags = [
    record.payloadCleared ? 'archived' : null,
    record.awaitingMedia ? 'media pending' : null,
    record.isGroup ? 'group' : null,
    record.type === 'unknown' ? 'unknown-type' : null,
    record.ts == null ? 'no-timestamp' : null,
    record.source === 'dom' ? 'dom-only' : null,
    record.media && record.media.status === 'stored' ? 'full-res' : null,
    record.media && record.media.status === 'not_downloaded' ? 'preview only' : null,
  ].filter(Boolean);

  return `
    <div class="message-item">
      <div class="message-head">
        <span class="message-dir">${dirGlyph}</span>
        <span class="message-sender">${escapeHtml(record.chatName || 'Unknown chat')}</span>
        <span class="message-time">${when ? when.toLocaleString() : ''}</span>
      </div>
      <div class="message-content">
        <span class="message-sub">${escapeHtml(senderLabel)}:</span>
        <span class="message-body">${escapeHtml(body)}</span>
        ${flags.length ? `<span class="message-flags">${flags.join(' · ')}</span>` : ''}
      </div>
    </div>`;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text == null ? '' : text);
  return div.innerHTML;
}

async function exportArchive() {
  try {
    const messages = await getMessagesForExport();
    const lines = messages.map((m) => JSON.stringify(m)).join('\n');
    const blob = new Blob([lines ? lines + '\n' : ''], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `waidrop-${new Date().toISOString().slice(0, 10)}.ndjson`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const total = await countMessages();
    const suffix =
      total > messages.length
        ? ` ${total - messages.length} archived message(s) are only in Dropbox.`
        : '';
    setSettingsStatus(
      `Exported ${messages.length} local message(s) as plaintext. Store the file securely.${suffix}`
    );
  } catch (e) {
    statusEl.textContent = 'Export failed: ' + (e && e.message ? e.message : e);
    statusEl.style.display = 'block';
  }
}

refreshBtn.addEventListener('click', loadMessages);
exportBtn.addEventListener('click', exportArchive);

// Live updates while the popup stays open: the service worker broadcasts after
// IndexedDB commits a batch. Focus/visibility refresh covers missed messages.
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadMessages();
  }, 300);
}

try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'ARCHIVE_UPDATED') scheduleRefresh();
    if (message && message.type === 'ACTIVITY_LOG' && message.entry) {
      appendLogEntry(message.entry);
      if (/^Upload (finished|failed)/.test(String(message.entry.message || ''))) {
        refreshLastUploadSummary().catch(() => {});
        scheduleRefresh();
      }
    }
  });
} catch (e) {
  /* runtime messaging unavailable */
}

window.addEventListener('focus', scheduleRefresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear the entire local archive? The Dropbox backup is not deleted.')) return;
  await clearAll();
  await loadSettings();
  loadMessages();
});

clearLogBtn.addEventListener('click', async () => {
  await clearActivityLog();
  activityLog = [];
  renderActivityLog();
  setSettingsStatus('Activity log cleared.');
});

// --- storage settings (encrypted Dropbox) ------------------------------------

function setSettingsStatus(text, options = {}) {
  settingsStatusEl.textContent = text;
  settingsStatusEl.classList.toggle('settings-status-error', options.error === true);
}

function setDropboxStatus(text) {
  dropboxStatusEl.textContent = text;
}

function logKey(entry) {
  return `${entry.at}|${entry.level}|${entry.message}`;
}

function padTime(value) {
  return String(value).padStart(2, '0');
}

function formatLogTime(at) {
  const date = new Date(Number(at) || Date.now());
  const now = new Date();
  const day =
    date.toDateString() === now.toDateString()
      ? ''
      : `${padTime(date.getMonth() + 1)}-${padTime(date.getDate())} `;
  return `${day}${padTime(date.getHours())}:${padTime(date.getMinutes())}:${padTime(date.getSeconds())}`;
}

function renderLogEntry(entry) {
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level || 'info'}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = formatLogTime(entry.at);
  const level = document.createElement('span');
  level.className = 'log-level';
  level.textContent = String(entry.level || 'info').toUpperCase();
  const message = document.createElement('span');
  message.className = 'log-message';
  message.textContent = entry.message;
  line.append(time, level, message);
  return line;
}

function scrollLogToEnd() {
  logOutput.scrollTop = logOutput.scrollHeight;
}

function openLogPanel() {
  logBox.open = true;
  if (typeof logBox.scrollIntoView === 'function') logBox.scrollIntoView({ block: 'nearest' });
  scrollLogToEnd();
}

function renderActivityLog() {
  const fragment = document.createDocumentFragment();
  for (const entry of activityLog) fragment.appendChild(renderLogEntry(entry));
  logOutput.replaceChildren(fragment);
  logCountEl.textContent = String(activityLog.length);
  logCountEl.hidden = activityLog.length === 0;
  logErrorDot.hidden = !activityLog.some((entry) => entry.level === 'error');
  if (logBox.open) scrollLogToEnd();
}

function appendLogEntry(entry, options = {}) {
  if (!entry || entry.message == null) return;
  const normalized = {
    at: Number(entry.at) || Date.now(),
    level: ['success', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
    message: String(entry.message),
  };
  if (activityLog.some((existing) => logKey(existing) === logKey(normalized))) return;
  activityLog.push(normalized);
  activityLog.sort((a, b) => a.at - b.at);
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog = activityLog.slice(-MAX_LOG_ENTRIES);
  renderActivityLog();
  if (normalized.level === 'error' && options.openOnError !== false) {
    logBox.open = true;
    scrollLogToEnd();
  }
}

async function loadActivityLog() {
  try {
    const stored = await getActivityLog();
    const merged = new Map();
    for (const entry of activityLog) merged.set(logKey(entry), entry);
    for (const entry of stored) {
      if (!entry || entry.message == null) continue;
      const normalized = {
        at: Number(entry.at) || 0,
        level: ['success', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
        message: String(entry.message),
      };
      merged.set(logKey(normalized), normalized);
    }
    activityLog = [...merged.values()].sort((a, b) => a.at - b.at).slice(-MAX_LOG_ENTRIES);
    renderActivityLog();
  } catch (e) {
    appendLogEntry(
      {
        at: Date.now(),
        level: 'error',
        message: `Could not load activity log: ${e && e.message ? e.message : e}`,
      },
      { openOnError: false }
    );
  }
}

async function refreshDropboxStatus() {
  try {
    const auth = await getAuth();
    if (auth && auth.refreshToken) {
      const who = auth.accountName || auth.email || auth.accountId || 'Dropbox account';
      setDropboxStatus(`Connected as ${who}.`);
    } else {
      setDropboxStatus('Not connected.');
    }
  } catch (e) {
    setDropboxStatus('Status unavailable: ' + (e && e.message ? e.message : e));
  }
}

function formatUploadCounts(stats) {
  const parts = [];
  if (stats.uploaded) parts.push(`${stats.uploaded} message(s)`);
  if (stats.mediaUploaded) parts.push(`${stats.mediaUploaded} media item(s)`);
  if (stats.mediaFailed) parts.push(`${stats.mediaFailed} media failed`);
  if (stats.formatUploaded || stats.chatMapsUploaded || stats.chatIndexUploaded) {
    if (!parts.length) parts.push('archive metadata');
  }
  return parts.join(', ');
}

function renderLastUploadStatus(last) {
  if (!last) {
    setSettingsStatus('No uploads yet.');
    return;
  }
  const when = new Date(last.at).toLocaleString();
  if (last.error && !formatUploadCounts(last)) {
    setSettingsStatus(`Last upload ${when}: failed; details in Activity log.`, { error: true });
    return;
  }
  setSettingsStatus(
    `Last upload ${when}: ${formatUploadCounts(last) || 'nothing new'}${
      last.error ? ' — failed; details in Activity log.' : '.'
    }`,
    { error: Boolean(last.error) }
  );
}

async function refreshLastUploadSummary() {
  const last = await getMeta('lastUpload');
  renderLastUploadStatus(last);
  return last;
}

function updateOffloadStatus(settings = {}) {
  const enabled = setOffloadEnabled.checked;
  const days = Number(setOffloadRetentionDays.value);
  const uploadEnabled = setEnabled.checked;
  const key = settings.encryptionKey != null ? settings.encryptionKey : setEncryptionKey.value.trim();

  offloadHintEl.textContent =
    'Offload only runs after uploads are enabled and the encryption key is acknowledged. Offloaded text is removed from this device and exists only in the encrypted Dropbox archive. Media that is not downloaded yet stays local and is repaired when it arrives.';

  let text;
  if (!enabled) text = 'Offload is off.';
  else if (!uploadEnabled) text = 'Offload paused: uploads are off.';
  else if (!key) text = 'Offload paused: encryption key is missing.';
  else if (days === 0) text = 'Offload active: immediately after a verified upload.';
  else text = `Offload active: after ${days} day(s) from a verified upload.`;
  offloadStatusEl.textContent = text;
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['settings', 'dropboxAuth']);
  const raw = result.settings || {};
  delete raw.dropboxAppSecret;
  const settings = {
    ...raw,
    archiveMode: 'encrypted',
    dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
  };
  storedSettings = settings;
  setAccount.value = settings.accountAlias || DEFAULT_ACCOUNT_ALIAS;
  setEncryptionKey.value = settings.encryptionKey || '';
  setEncryptionKeyAcknowledged.checked = settings.encryptionKeyAcknowledged === true;
  setSyncPreInstall.checked = settings.syncPreInstallMessages === true;
  setEnabled.checked = settings.uploadEnabled === true;
  setMediaMode(MediaSettings.effectiveMediaMode(settings));
  if (setMediaViewOnce) setMediaViewOnce.checked = settings.mediaCaptureViewOnce === true;
  setMediaMaxMb.value = Math.round((Number(settings.mediaMaxBytes) || 20 * 1024 * 1024) / (1024 * 1024));
  setOffloadEnabled.checked = settings.offloadEnabled !== false;
  setOffloadRetentionDays.value = Number.isFinite(Number(settings.offloadRetentionDays))
    ? Number(settings.offloadRetentionDays)
    : 1;

  let messageCount = 0;
  try {
    messageCount = await countMessages();
  } catch (e) {
    messageCount = 0;
  }

  let existingFingerprint = null;
  try {
    existingFingerprint = await getMeta('localKeyFingerprint');
  } catch (e) {
    existingFingerprint = null;
  }

  let key = settings.encryptionKey || '';
  if (!key && messageCount === 0 && !existingFingerprint) {
    key = generateMasterKey();
    settings.encryptionKey = key;
    settings.encryptionKeyAcknowledged = false;
    settings.archiveMode = 'encrypted';
    storedSettings = settings;
    setEncryptionKey.value = key;
    setEncryptionKeyAcknowledged.checked = false;
    try {
      await chrome.storage.local.set({ settings });
    } catch (e) {
      /* the next save retries */
    }
  }

  localKeyReady = false;
  if (isValidMasterKey(key)) {
    try {
      const codec = await createLocalCodec(key);
      if (!existingFingerprint || existingFingerprint === codec.fingerprint) {
        setLocalCodec(codec);
        localKeyReady = true;
      } else {
        setLocalCodec(null);
        setSettingsStatus('This key does not match the local archive. Enter the original key or clear the archive.', {
          error: true,
        });
      }
    } catch (e) {
      setLocalCodec(null);
      setSettingsStatus('Unable to unlock the local archive: ' + (e && e.message ? e.message : e), { error: true });
    }
  } else {
    setLocalCodec(null);
  }

  const keyLocked = localKeyReady && (messageCount > 0 || !!existingFingerprint);
  setEncryptionKey.readOnly = keyLocked;
  generateKeyBtn.disabled = messageCount > 0 || !!existingFingerprint;

  syncMediaModeUI();
  updateOffloadStatus(settings);

  await loadActivityLog();
  const [last, logClearedAt] = await Promise.all([refreshLastUploadSummary(), getActivityLogClearedAt()]);
  if (
    last &&
    last.error &&
    last.at > logClearedAt &&
    !activityLog.some((entry) => entry.level === 'error' && entry.message.includes(last.error))
  ) {
    appendLogEntry(
      { at: last.at, level: 'error', message: `Last upload failed — ${last.error}` },
      { openOnError: false }
    );
  }
  if (last && last.error && last.at > logClearedAt) openLogPanel();
  refreshDropboxStatus();
}

function currentSettings() {
  const alias = setAccount.value.trim() || DEFAULT_ACCOUNT_ALIAS;
  const settings = {
    ...storedSettings,
    uploadEnabled: setEnabled.checked,
    accountAlias: alias,
    dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
    archiveMode: 'encrypted',
    encryptionKey: setEncryptionKey.value.trim(),
    encryptionKeyAcknowledged: setEncryptionKeyAcknowledged.checked,
    offloadEnabled: setOffloadEnabled.checked,
    offloadRetentionDays: Math.max(0, Math.min(365, Number(setOffloadRetentionDays.value) || 0)),
    syncPreInstallMessages: setSyncPreInstall.checked === true,
  };
  Object.assign(settings, MediaSettings.legacyFromMode(selectedMediaMode()));
  if (setMediaViewOnce) settings.mediaCaptureViewOnce = setMediaViewOnce.checked;
  settings.mediaMaxBytes = Math.max(1, Math.min(50, Number(setMediaMaxMb.value) || 20)) * 1024 * 1024;
  return settings;
}

function validateSettings(settings, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(settings.accountAlias)) {
    return 'Account alias may only contain letters, digits and . _ -';
  }
  if (settings.offloadRetentionDays < 0 || settings.offloadRetentionDays > 365) {
    return 'Offload retention must be between 0 and 365 days.';
  }
  if (options.connectOnly) return null;
  if (!settings.uploadEnabled) return null;
  if (settings.encryptionKey && !isValidMasterKey(settings.encryptionKey)) {
    return 'Encryption key must be 32 bytes encoded as base64.';
  }
  if (!settings.encryptionKey) return 'Encryption key is required for an encrypted archive.';
  if (!settings.encryptionKeyAcknowledged) {
    return 'Confirm that you saved the encryption key before enabling uploads.';
  }
  return null;
}

async function persistCurrentSettings(options = {}) {
  const settings = currentSettings();
  const problem = validateSettings(settings, options);
  if (problem) {
    setSettingsStatus('Not saved: ' + problem, { error: true });
    return false;
  }
  const stored = await chrome.storage.local.get(['dropboxAuth']);
  const connected = Boolean(stored.dropboxAuth && stored.dropboxAuth.refreshToken);
  if (settings.uploadEnabled && !options.connectOnly && !connected) {
    setSettingsStatus('Not saved: connect Dropbox before enabling uploads.', { error: true });
    return false;
  }
  await chrome.storage.local.set({ settings });
  storedSettings = settings;
  updateOffloadStatus(settings);
  return true;
}

saveSettingsBtn.addEventListener('click', async () => {
  if (!(await persistCurrentSettings())) return;
  await loadSettings();
  if (localKeyReady) setSettingsStatus('Saved.');
});

generateKeyBtn.addEventListener('click', () => {
  if (generateKeyBtn.disabled) return;
  setEncryptionKey.value = generateMasterKey();
  setEncryptionKey.type = 'text';
  setEncryptionKeyAcknowledged.checked = false;
  updateOffloadStatus();
  setSettingsStatus(
    'Key generated. Copy it to your password manager and to any other tools before uploading — without it the archive cannot be decrypted.'
  );
});

copyKeyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(setEncryptionKey.value);
    setSettingsStatus('Key copied to clipboard.');
  } catch (e) {
    setEncryptionKey.type = 'text';
    setEncryptionKey.focus();
    setEncryptionKey.select();
    setSettingsStatus('Copy failed — select the key manually and copy it.', { error: true });
  }
});

connectDropboxBtn.addEventListener('click', async () => {
  if (!(await persistCurrentSettings({ connectOnly: true }))) return;
  setDropboxStatus('Waiting for Dropbox authorization... (you can close this popup)');
  try {
    // OAuth runs in the service worker: the popup is destroyed as soon as the
    // Dropbox authorization window takes focus, so it cannot own this flow.
    const response = await chrome.runtime.sendMessage({ type: 'DROPBOX_CONNECT' });
    if (response && response.ok) {
      const who = response.accountName || response.email || 'Dropbox account';
      setDropboxStatus(`Connected as ${who}.`);
    } else {
      setDropboxStatus('Connection failed: ' + (response && response.error ? response.error : 'unknown error'));
    }
  } catch (e) {
    // The popup likely closed while the worker finished; refresh on next open.
    setDropboxStatus('Connection state unknown: ' + (e && e.message ? e.message : e));
  }
  await refreshDropboxStatus();
});

disconnectDropboxBtn.addEventListener('click', async () => {
  await disconnect();
  setDropboxStatus('Not connected.');
});

testBtn.addEventListener('click', async () => {
  openLogPanel();
  setDropboxStatus('Testing Dropbox connection...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (response && response.ok) {
      const who = response.accountName || response.email || 'Dropbox account';
      setDropboxStatus(`Connection OK — ${who}.`);
    } else {
      setDropboxStatus('Connection failed: ' + (response && response.error ? response.error : 'unknown error'));
    }
  } catch (e) {
    setDropboxStatus('Connection test error: ' + (e && e.message ? e.message : e));
  }
});

uploadNowBtn.addEventListener('click', async () => {
  openLogPanel();
  setDropboxStatus('Uploading...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'TRIGGER_UPLOAD' });
    if (response && response.status === 'ok') {
      const stats = response.stats || {};
      if (stats.skipped === 'key-not-acknowledged') {
        setDropboxStatus('Confirm that you saved the encryption key before enabling uploads.');
      } else if (stats.skipped) {
        setDropboxStatus(`Upload skipped: ${stats.skipped}.`);
      } else {
        setDropboxStatus(
          `Upload done: ${formatUploadCounts(stats) || 'nothing new'}; ${
            stats.pending == null ? '?' : stats.pending
          } pending${stats.error ? ' — ' + stats.error : ''}`
        );
      }
    } else {
      setDropboxStatus('Upload failed: ' + (response && response.error ? response.error : 'unknown error'));
    }
  } catch (e) {
    setDropboxStatus('Upload error: ' + (e && e.message ? e.message : e));
  }
  await refreshLastUploadSummary();
  loadMessages();
});

runOffloadBtn.addEventListener('click', async () => {
  if (!(await persistCurrentSettings())) return;
  setSettingsStatus('Running offload cleanup...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RUN_OFFLOAD' });
    if (response && response.status === 'ok') {
      const stats = response.stats || {};
      setSettingsStatus(
        stats.cleared ? `Offloaded ${stats.cleared} message payload(s).` : `Offload skipped: ${stats.skipped || 'nothing eligible'}.`
      );
    } else {
      setSettingsStatus('Offload failed: ' + (response && response.error ? response.error : 'unknown error'), {
        error: true,
      });
    }
  } catch (e) {
    setSettingsStatus('Offload error: ' + (e && e.message ? e.message : e), { error: true });
  }
  loadMessages();
});

repairMediaBtn.addEventListener('click', async () => {
  if (!(await persistCurrentSettings())) return;
  setSettingsStatus('Repairing media...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'REPAIR_MEDIA' });
    if (response && response.status === 'ok') {
      const stats = response.stats || {};
      setSettingsStatus(
        stats.repaired ? `Repaired ${stats.repaired} message(s).` : `Repair skipped: ${stats.skipped || 'nothing pending'}.`
      );
    } else {
      setSettingsStatus('Repair failed: ' + (response && response.error ? response.error : 'unknown error'), {
        error: true,
      });
    }
  } catch (e) {
    setSettingsStatus('Repair error: ' + (e && e.message ? e.message : e), { error: true });
  }
  loadMessages();
});

async function init() {
  await loadSettings();
  await loadMessages();
}

init();
