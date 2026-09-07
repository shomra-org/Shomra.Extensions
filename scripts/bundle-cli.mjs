// @shomra/agent (https://github.com/shomra-org/agent), pinned in this
// node_modules, so the bundled CLI is always a real published version.
// To ship a newer CLI: bump @shomra/agent in package.json (or
// `npm install @shomra/agent@latest`), then repackage/republish the extension.
// Run automatically by `vscode:prepublish` (see package.json).
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, rmSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, '..');
const cliDst = join(extRoot, 'cli');

// Resolve the installed @shomra/agent package directory via its package.json.
const require = createRequire(import.meta.url);
let cliSrc;
try {
  cliSrc = dirname(require.resolve('@shomra/agent/package.json'));
} catch {
  console.error('[bundle-cli] @shomra/agent is not installed. Run `npm install` first.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(cliSrc, 'package.json'), 'utf8'));
// need at runtime; shomra.mjs + its sibling .mjs modules are what actually run.
// runtime module - e.g. ai-usage.mjs, imported by discovery.mjs - ships
// package.json is REQUIRED at runtime, not just metadata: shomra.mjs reads its
const published = Array.isArray(pkg.files) ? pkg.files : [];
const FILES = [
  ...published.filter((f) => f.endsWith('.mjs') || f === 'LICENSE' || f === 'NOTICE'),
  'package.json',
];

if (!existsSync(join(cliSrc, 'shomra.mjs'))) {
  console.error(`[bundle-cli] shomra.mjs not found in ${cliSrc}.`);
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
console.log(`[bundle-cli] bundled @shomra/agent@${pkg.version} (${n} files) into cli/`);
