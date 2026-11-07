/**
 * Open-source licensing: MIT license file, package metadata and docs.
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
check('MIT license text included', /MIT License/.test(license));
check('copyright holder named', /Copyright \(c\) 2026 PYXIS Tomasz Habiger/.test(license));
check('permission grant present', /Permission is hereby granted, free of charge/.test(license));
check('warranty disclaimer present', /THE SOFTWARE IS PROVIDED "AS IS"/.test(license));

const pkg = JSON.parse(read('package.json'));
check('package.json declares MIT', pkg.license === 'MIT', String(pkg.license));

const runtimeFiles = read('scripts/runtime-files.mjs');
check('LICENSE is included in the package', /'LICENSE'/.test(runtimeFiles));

const terms = read('TERMS.md');
check('terms mention MIT', /MIT License/.test(terms));
check('terms no longer claim proprietary code', !/code is proprietary/i.test(terms));

const readme = read('README.md');
check('README mentions open source', /open source/i.test(readme));
check('README links the MIT license', /MIT License/.test(readme));

console.log(failures === 0 ? '\nALL LICENSE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
