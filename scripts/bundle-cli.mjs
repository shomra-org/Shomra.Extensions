// Copies the zero-dependency Shomra CLI (.mjs files) from the sibling
// Dragox.Backend/agent package into ./cli so the built .vsix ships the CLI and
// the extension works with nothing to install. Run automatically by
// `vscode:prepublish` (see package.json). Keep the file list in sync with the
// CLI package's `files` array.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, '..');
const cliSrc = join(extRoot, '..', 'Dragox.Backend', 'agent');
const cliDst = join(extRoot, 'cli');

// The runtime files shomra.mjs needs at its side (its relative imports).
const FILES = [
  'shomra.mjs',
  'discovery.mjs',
  'guard-signals.mjs',
  'code-sast.mjs',
  'model-refs.mjs',
  'LICENSE',
  'NOTICE',
];

if (!existsSync(join(cliSrc, 'shomra.mjs'))) {
  console.error(`[bundle-cli] CLI source not found at ${cliSrc}. Cannot bundle the CLI.`);
  process.exit(1);
}

rmSync(cliDst, { recursive: true, force: true });
mkdirSync(cliDst, { recursive: true });

let n = 0;
for (const f of FILES) {
  const from = join(cliSrc, f);
  if (!existsSync(from)) {
    console.error(`[bundle-cli] missing expected CLI file: ${f}`);
    process.exit(1);
  }
  copyFileSync(from, join(cliDst, f));
  n++;
}
console.log(`[bundle-cli] bundled ${n} CLI files into cli/`);
