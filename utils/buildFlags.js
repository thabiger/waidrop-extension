(function (root) {
  'use strict';

  // Build-time feature flags. The public store build replaces this file with
  // tools/release/buildFlags.public.js (see scripts/build.mjs --public).
  const allowViewOnceCapture = true;
  const allowActiveMediaDownloads = true;
  const developerMode = true;

  root.WABuildFlags = { allowViewOnceCapture, allowActiveMediaDownloads, developerMode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
