(function (root) {
  'use strict';

  const MODES = ['off', 'passive', 'active'];
  const VALID = new Set(MODES);

  function activeMediaAllowed() {
    // Fail closed: a missing or malformed flags object never enables active
    // downloads.
    const flags = root.WABuildFlags;
    return !!flags && flags.allowActiveMediaDownloads === true;
  }

  function resolveMediaMode(settings) {
    const value = settings || {};
    if (VALID.has(value.mediaMode)) return value.mediaMode;
    if (value.mediaCaptureEnabled === false) return 'off';
    if (value.mediaActiveFetchEnabled === true) return 'active';
    return 'passive';
  }

  function effectiveMediaMode(settings) {
    let mode = resolveMediaMode(settings);
    if (mode === 'active' && !activeMediaAllowed()) mode = 'passive';
    return mode;
  }

  function legacyFromMode(mode) {
    let value = VALID.has(mode) ? mode : 'passive';
    if (value === 'active' && !activeMediaAllowed()) value = 'passive';
    return {
      mediaMode: value,
      mediaCaptureEnabled: value !== 'off',
      mediaActiveFetchEnabled: value === 'active',
    };
  }

  root.WAMediaSettings = { MODES, resolveMediaMode, effectiveMediaMode, legacyFromMode, activeMediaAllowed };
})(typeof globalThis !== 'undefined' ? globalThis : this);
