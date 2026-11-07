#!/usr/bin/env node
/**
 * Build a Chrome Web Store ZIP containing only runtime files.
 *
 * Default: personal build (view-once media capture and active media downloads enabled).
 * --public: store build with view-once media capture and active media downloads removed.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from './runtime-files.mjs';

const publicBuild = process.argv.includes('--public');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const outRoot = path.join(root, 'dist');
const stageSuffix = publicBuild ? '-public' : '';
const stage = path.join(outRoot, `waidrop-${manifest.version}${stageSuffix}`);
const zipPath = path.join(outRoot, `waidrop-${manifest.version}${stageSuffix}.zip`);

await rm(stage, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(stage, { recursive: true });

for (const entry of runtimeFiles) {
  const destination = path.join(stage, entry);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, entry), destination);
}

function stripMarkerBlock(html, name) {
  const pattern = new RegExp(`\\n?[ \\t]*<!-- ${name}_BEGIN -->[\\s\\S]*?<!-- ${name}_END -->`);
  const stripped = html.replace(pattern, '');
  if (stripped === html) {
    throw new Error(
      `popup.html is missing the ${name}_BEGIN/${name}_END markers; refusing to build a public package.`
    );
  }
  return stripped;
}

if (publicBuild) {
  await copyFile(
    path.join(root, 'tools/release/buildFlags.public.js'),
    path.join(stage, 'utils/buildFlags.js')
  );
  const htmlPath = path.join(stage, 'popup/popup.html');
  let html = await readFile(htmlPath, 'utf8');
  html = stripMarkerBlock(html, 'VIEW_ONCE');
  html = stripMarkerBlock(html, 'ACTIVE_MEDIA');
  html = stripMarkerBlock(html, 'DEVELOPER');
  await writeFile(htmlPath, html);
  console.log(
    'Public build: view-once media capture, active media downloads and developer info removed from the staged package.'
  );
} else {
  console.warn(
    'PERSONAL BUILD: this ZIP contains view-once media capture and active media downloads. ' +
      'It is for private use only and must never be submitted to the Chrome Web Store.'
  );
}

execFileSync('zip', ['-qr', zipPath, '.'], { cwd: stage });
console.log(`Built ${path.relative(root, zipPath)}`);
