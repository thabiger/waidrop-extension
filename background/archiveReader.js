import { downloadFile } from './dropbox.js';
import { decodeObject } from './archiveCodec.js';

export async function downloadPartRecords(settings, keys, path, mode = 'encrypted') {
  const bytes = await downloadFile(settings, path);
  const plaintext = await decodeObject(mode, keys, bytes);
  return plaintext
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function findRecord(records, msgId) {
  return (records || []).find((record) => record && record.msgId === msgId) || null;
}

export async function readRecordFromPart(settings, keys, path, msgId, mode = 'encrypted') {
  const records = await downloadPartRecords(settings, keys, path, mode);
  return findRecord(records, msgId);
}
