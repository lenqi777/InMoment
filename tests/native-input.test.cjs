'use strict';

// Explicit integration test: opens one isolated test-owned window and drives tagged
// synthetic mouse input. Default test runs skip this window; no screen/audio/API access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const enabled = process.platform === 'win32' && process.env.INMOMENT_NATIVE_INPUT_TEST === '1';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

function compileHarness(t) {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-native-input-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const windows = process.env.WINDIR || 'C:\\Windows';
  const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const speechRoot = path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL', 'System.Speech');
  const speechVersion = fs.readdirSync(speechRoot).find(name => name.startsWith('v4.0_'));
  assert.ok(speechVersion, 'The .NET Framework System.Speech reference is unavailable');
  const binary = path.join(temp, 'InMoment.Native.InputTest.exe');
  const compile = spawnSync(compiler, [
    '/nologo', '/target:exe', '/platform:x64', '/define:INMOMENT_NATIVE_INPUT_TEST',
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    `/reference:${path.join(speechRoot, speechVersion, 'System.Speech.dll')}`,
    `/out:${binary}`, path.join(root, 'native', 'InMoment.Native.cs'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(compile.error);
  assert.equal(compile.status, 0, 'The test-only native helper did not compile');
  return { temp, binary };
}

test('native staged timing and shortcut repeat/modifier state run without GUI or input hooks', {
  skip: process.platform !== 'win32' ? 'Windows-only native build' : false,
  timeout: 20000,
}, t => {
  const { binary } = compileHarness(t);
  const run = spawnSync(binary, ['--state-test'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(run.error);
  const result = JSON.parse(run.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(run.status, 0, result.error || 'Native timing/shortcut state failed');
  assert.equal(result.ok, true);
  assert.equal(result.hooksInstalled, false);
  assert.equal(result.syntheticInputSent, false);
  assert.equal(result.screenshotTest, 'not-run');
  assert.equal(result.microphoneTest, 'not-run');
  assert.equal(result.cases.length, 8);
  assert.ok(result.cases.includes('64-bit-message-values-are-masked-without-overflow'));
});

test('native hook handles short press, long hold, drag and configuration on its isolated input window', {
  skip: enabled ? false : 'Set INMOMENT_NATIVE_INPUT_TEST=1 on an interactive Windows desktop to open the synthetic-only test window',
  timeout: 30000,
}, t => {
  const { temp, binary } = compileHarness(t);
  const output = path.join(temp, 'result.json');
  const errors = path.join(temp, 'stderr.txt');
  // Show the intentionally visible isolated window rather than inheriting a hidden
  // console's startup style. The harness verifies active desktop and window ownership
  // before every input and never targets another application's controls.
  const launch = `$testProcess = Start-Process -FilePath ${quote(binary)} -ArgumentList '--input-test' -WindowStyle Normal -PassThru -Wait -RedirectStandardOutput ${quote(output)} -RedirectStandardError ${quote(errors)}\nexit $testProcess.ExitCode`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', launch], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(run.error);
  const result = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '').trim());
  assert.equal(run.status, 0, result.error || 'The isolated native input integration failed');
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'own-window-synthetic-input-only');
  assert.equal(result.screenshotTest, 'not-run');
  assert.equal(result.microphoneTest, 'not-run');
  assert.deepEqual(result.cases, [
    'short-click-preview-cancel-and-replay',
    'held-button-triggers-without-async-key-state-and-ends-on-release',
    'drag-cancels-preview-and-restores-input',
    'repeated-configure-preserves-pending-hold',
    'excluded-process-cancels-and-passes-through',
    'disabled-trigger-passes-through',
    'f8-short-press-replays-once',
    'f8-repeat-hold-and-disabled-keyup',
    'f8-modifier-combination-passes-through',
    'f9-short-press-replays-once',
    'f9-repeat-hold-and-disabled-keyup',
    'f9-modifier-combination-passes-through',
    'f10-short-press-replays-once',
    'f10-repeat-hold-and-disabled-keyup',
    'f10-modifier-combination-passes-through',
  ]);
  assert.equal(fs.readFileSync(errors, 'utf8'), '');
});
