/**
 * Media capture mode settings: canonical mediaMode, legacy migration and
 * legacy boolean fan-out.
 *
 *   node tests/media-settings.test.mjs
 */
await import('../utils/mediaSettings.js');

const { resolveMediaMode, effectiveMediaMode, legacyFromMode, activeMediaAllowed } = globalThis.WAMediaSettings;
// Personal/dev build flags for the baseline mode checks; the public and
// missing-flag cases are exercised below.
globalThis.WABuildFlags = { allowActiveMediaDownloads: true };
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

check('default is passive', resolveMediaMode({}) === 'passive');
check('explicit off', resolveMediaMode({ mediaMode: 'off' }) === 'off');
check('explicit passive', resolveMediaMode({ mediaMode: 'passive' }) === 'passive');
check('explicit active', resolveMediaMode({ mediaMode: 'active' }) === 'active');
check('explicit mode wins over legacy', resolveMediaMode({ mediaMode: 'passive', mediaActiveFetchEnabled: true }) === 'passive');
check('legacy disabled', resolveMediaMode({ mediaCaptureEnabled: false }) === 'off');
check('legacy passive', resolveMediaMode({ mediaCaptureEnabled: true }) === 'passive');
check('legacy active', resolveMediaMode({ mediaCaptureEnabled: true, mediaActiveFetchEnabled: true }) === 'active');
check(
  'inconsistent legacy state resolves to off',
  resolveMediaMode({ mediaCaptureEnabled: false, mediaActiveFetchEnabled: true }) === 'off'
);
check('invalid mode falls back to legacy', resolveMediaMode({ mediaMode: 'bogus', mediaCaptureEnabled: false }) === 'off');

const off = legacyFromMode('off');
check('off fan-out', off.mediaMode === 'off' && off.mediaCaptureEnabled === false && off.mediaActiveFetchEnabled === false);
const passive = legacyFromMode('passive');
check('passive fan-out', passive.mediaMode === 'passive' && passive.mediaCaptureEnabled === true && passive.mediaActiveFetchEnabled === false);
const active = legacyFromMode('active');
check('active fan-out', active.mediaMode === 'active' && active.mediaCaptureEnabled === true && active.mediaActiveFetchEnabled === true);
check('invalid mode fan-out defaults to passive', legacyFromMode('bogus').mediaMode === 'passive');
check('effective mode keeps active', effectiveMediaMode({ mediaMode: 'active' }) === 'active');
check('effective mode keeps passive', effectiveMediaMode({ mediaMode: 'passive' }) === 'passive');

check('personal build allows active media', activeMediaAllowed() === true);
check('personal effective mode keeps active', effectiveMediaMode({ mediaMode: 'active' }) === 'active');

globalThis.WABuildFlags = { allowActiveMediaDownloads: false };
check('public build disables active media', activeMediaAllowed() === false);
check(
  'public effective mode falls back to passive',
  effectiveMediaMode({ mediaMode: 'active' }) === 'passive'
);
const publicActive = legacyFromMode('active');
check(
  'public legacy fan-out never re-enables active',
  publicActive.mediaMode === 'passive' &&
    publicActive.mediaCaptureEnabled === true &&
    publicActive.mediaActiveFetchEnabled === false
);

delete globalThis.WABuildFlags;
check('missing build flags fail closed', activeMediaAllowed() === false);
check(
  'missing flags force effective passive',
  effectiveMediaMode({ mediaMode: 'active' }) === 'passive'
);

console.log(failures === 0 ? '\nALL MEDIA SETTINGS CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
