(function (root) {
  'use strict';

  // Public store build variant of utils/buildFlags.js.
  const allowViewOnceCapture = false;
  const allowActiveMediaDownloads = false;
  const developerMode = false;

  root.WABuildFlags = { allowViewOnceCapture, allowActiveMediaDownloads, developerMode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
