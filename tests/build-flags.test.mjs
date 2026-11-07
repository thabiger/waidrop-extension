/**
 * Build variant flags: the source tree ships view-once capture enabled, the
 * public release variant disables it, and the popup.html strip markers exist.
 *
 *   node tests/build-flags.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

function evalFlags(file) {
  const sandbox = {};
  new Function('globalThis', read(file))(sandbox);
  return sandbox.WABuildFlags;
}

const sourceFlags = evalFlags('utils/buildFlags.js');
check('source build flags allow view-once capture', sourceFlags && sourceFlags.allowViewOnceCapture === true);
check('source build flags allow active media downloads', sourceFlags && sourceFlags.allowActiveMediaDownloads === true);
check('source build flags enable developer mode', sourceFlags && sourceFlags.developerMode === true);

const publicFlags = evalFlags('tools/release/buildFlags.public.js');
check('public build flags disable view-once capture', publicFlags && publicFlags.allowViewOnceCapture === false);
check('public build flags disable active media downloads', publicFlags && publicFlags.allowActiveMediaDownloads === false);
check('public build flags disable developer mode', publicFlags && publicFlags.developerMode === false);

const html = read('popup/popup.html');
const beginCount = (html.match(/<!-- VIEW_ONCE_BEGIN -->/g) || []).length;
const endCount = (html.match(/<!-- VIEW_ONCE_END -->/g) || []).length;
check('popup.html has exactly one VIEW_ONCE_BEGIN marker', beginCount === 1, String(beginCount));
check('popup.html has exactly one VIEW_ONCE_END marker', endCount === 1, String(endCount));
const block = html.match(/<!-- VIEW_ONCE_BEGIN -->[\s\S]*?<!-- VIEW_ONCE_END -->/);
check('view-once checkbox is inside the marker block', !!block && /setMediaViewOnce/.test(block[0]));

const activeBeginCount = (html.match(/<!-- ACTIVE_MEDIA_BEGIN -->/g) || []).length;
const activeEndCount = (html.match(/<!-- ACTIVE_MEDIA_END -->/g) || []).length;
check('popup.html has exactly one ACTIVE_MEDIA_BEGIN marker', activeBeginCount === 1, String(activeBeginCount));
check('popup.html has exactly one ACTIVE_MEDIA_END marker', activeEndCount === 1, String(activeEndCount));
const activeBlock = html.match(/<!-- ACTIVE_MEDIA_BEGIN -->[\s\S]*?<!-- ACTIVE_MEDIA_END -->/);
check(
  'active media option is inside the marker block',
  !!activeBlock && /name="mediaMode" value="active"/.test(activeBlock[0])
);

const devBeginCount = (html.match(/<!-- DEVELOPER_BEGIN -->/g) || []).length;
const devEndCount = (html.match(/<!-- DEVELOPER_END -->/g) || []).length;
check('popup.html has exactly one DEVELOPER_BEGIN marker', devBeginCount === 1, String(devBeginCount));
check('popup.html has exactly one DEVELOPER_END marker', devEndCount === 1, String(devEndCount));
const devBlock = html.match(/<!-- DEVELOPER_BEGIN -->[\s\S]*?<!-- DEVELOPER_END -->/);
check(
  'developer block contains the Dropbox scopes',
  !!devBlock && /account_info\.read/.test(devBlock[0]) && /files\.metadata\.read/.test(devBlock[0]) && /files\.content\.write/.test(devBlock[0]) && /files\.content\.read/.test(devBlock[0]),
  devBlock ? devBlock[0].slice(0, 80) : 'missing'
);
check(
  'developer block renders the redirect URI dynamically',
  !!devBlock &&
    /class="redirect-uri"/.test(devBlock[0]) &&
    /chrome\.identity\.getRedirectURL\(\)/.test(read('popup/popup.js')),
  devBlock ? devBlock[0].slice(0, 80) : 'missing'
);

const manifest = JSON.parse(read('manifest.json'));
const contentJs = (manifest.content_scripts || [])[0]?.js || [];
check(
  'manifest loads buildFlags.js before content.js',
  contentJs.includes('utils/buildFlags.js') && contentJs.indexOf('utils/buildFlags.js') < contentJs.indexOf('content/content.js'),
  JSON.stringify(contentJs)
);

const runtimeFiles = read('scripts/runtime-files.mjs');
check('runtime allowlist includes buildFlags.js', /'utils\/buildFlags\.js'/.test(runtimeFiles));

const contentSrc = read('content/content.js');
check(
  'content.js gates captureViewOnce on the build flag',
  /allowViewOnceCapture\(\)\s*&&\s*value\.mediaCaptureViewOnce === true/.test(contentSrc)
);
check(
  'content.js gates active media downloads on the build flag',
  /activeFetch:\s*mode === 'active' && allowActiveMediaDownloads\(\)/.test(contentSrc)
);
check('content.js no longer reads entitlements', !/entitlement/i.test(contentSrc));
check(
  'popup.js disables the active mode text when the build flag is off',
  /allowActiveMediaDownloads === false\) delete MEDIA_MODE_TEXT\.active/.test(read('popup/popup.js'))
);

console.log(failures === 0 ? '\nALL BUILD FLAGS CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
