/**
 * Archive retention and installment policy helpers.
 *
 * Messages dated before the extension was installed are kept locally but are
 * only eligible for Dropbox sync when the full-history option is enabled.
 */
export const PRE_INSTALL_GRACE_MS = 10 * 60 * 1000;
export const PRE_INSTALL_REASON = 'pre-install-history';

export function isPreInstallMessage(record, installedAt) {
  if (!record || typeof installedAt !== 'number') return false;
  const ts = typeof record.ts === 'number' ? record.ts : null;
  if (ts == null) return false;
  return ts < installedAt - PRE_INSTALL_GRACE_MS;
}
