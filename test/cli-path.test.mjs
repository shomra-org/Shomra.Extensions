import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOnPath, shadowingCommand } from '../src/cli-path.ts';

const scratch = mkdtempSync(join(tmpdir(), 'shomra-cli-path-'));
const repo = join(scratch, 'cloned-repo');
const bin = join(scratch, 'bin');
mkdirSync(repo);
mkdirSync(bin);
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

const exe = (dir, name) => {
  const file = join(dir, name);
  if (process.platform === 'win32') copyFileSync(process.execPath, file);
  else {
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
  }
  return file;
};

const planted = exe(repo, process.platform === 'win32' ? 'shomra.exe' : 'shomra');

test('a binary planted in the workspace is never resolved, even with the workspace as cwd and "." on PATH', () => {
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    const sep = process.platform === 'win32' ? ';' : ':';
    assert.equal(resolveOnPath('shomra', { PATH: ['.', '', bin].join(sep) }), null);
  } finally {
    process.chdir(cwd);
  }
});

test('the CLI on an absolute PATH directory is resolved to its full path', () => {
  const real = exe(bin, process.platform === 'win32' ? 'shomra.exe' : 'shomra');
  const sep = process.platform === 'win32' ? ';' : ':';
  assert.equal(resolveOnPath('shomra', { PATH: ['.', bin].join(sep) }), real);
});

test('a relative command path is refused - it would resolve against the workspace', () => {
  assert.equal(resolveOnPath('./shomra'), null);
  assert.equal(resolveOnPath('tools\\shomra.exe', {}, 'win32'), null);
});

test('Windows looks only for what CreateProcess can start', () => {
  const winBin = join(scratch, 'winbin');
  mkdirSync(winBin);
  writeFileSync(join(winBin, 'shomra.cmd'), '@echo off\n');
  assert.equal(resolveOnPath('shomra', { PATH: winBin }, 'win32'), null);
});

test('a file that would shadow `shomra` in a terminal started in the workspace is reported', () => {
  assert.equal(shadowingCommand(repo), planted);
  const clean = join(scratch, 'clean-repo');
  mkdirSync(clean);
  assert.equal(shadowingCommand(clean), null);
  writeFileSync(join(clean, 'shomra.bat'), '@echo off\n');
  assert.ok(shadowingCommand(clean, { PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')?.toLowerCase().endsWith('shomra.bat'));
});
