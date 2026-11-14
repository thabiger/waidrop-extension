/**
 * Open-source licensing: Apache-2.0 license file, package metadata and docs.
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

const license = read('LICENSE');
check('Apache-2.0 license text included', /Apache License/.test(license) && /Version 2.0, January 2004/.test(license));
check('patent grant present', /3\. Grant of Patent License/.test(license));
check('warranty disclaimer present', /7\. Disclaimer of Warranty/.test(license));
const copyrightHolder = read('NOTICE').match(/Copyright \d{4} (.+)/)?.[1]?.trim() || '';
check('NOTICE identifies copyright holder', copyrightHolder.length > 0);

const pkg = JSON.parse(read('package.json'));
check('package.json declares Apache-2.0', pkg.license === 'Apache-2.0', String(pkg.license));
const lock = JSON.parse(read('package-lock.json'));
check('root lock metadata declares Apache-2.0', lock.packages[''].license === 'Apache-2.0');

const runtimeFiles = read('scripts/runtime-files.mjs');
for (const file of ['LICENSE', 'NOTICE']) {
  check(`${file} is included in the package`, runtimeFiles.includes(`'${file}'`));
}

const terms = read('TERMS.md');
check('terms identify Apache-2.0', /Apache License, Version 2.0/.test(terms));
check('terms preserve license rights', /do not replace or\s+restrict those rights/.test(terms));
check('terms no longer claim proprietary code', !/code is proprietary/i.test(terms));

const privacy = read('PRIVACY.md');
for (const [name, doc] of [['privacy', privacy], ['terms', terms]]) {
  check(`${name} includes contact email`, /waidrop@tnkrd\.com/.test(doc));
  check(`${name} identifies the controller`, copyrightHolder && doc.includes(copyrightHolder));
}
check(
  'privacy includes the Chrome Web Store Limited Use statement',
  /The use of information received from Google APIs will adhere to the Chrome Web\s+Store User Data Policy, including the Limited Use requirements\./.test(
    privacy
  )
);

const readme = read('README.md');
check('README mentions open source', /open source/i.test(readme));
check('README links the Apache license', /Apache License, Version 2.0/.test(readme));

console.log(failures === 0 ? '\nALL LICENSE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
