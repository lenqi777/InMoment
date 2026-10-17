'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Windows setup handles consent, verification, exit codes and cleanup using inert replacements only', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'support/installer-tests.ps1'), '-InstallerScript', path.resolve(__dirname, '../scripts/Install-InMoment.ps1')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, INMOMENT_DISABLE_NETWORK: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.failed, 0);
  assert.ok(report.passed >= 12);
  assert.equal(report.realDownloads, 0);
  assert.equal(report.realInstallations, 0);
  assert.equal(report.realShortcuts, 0);
});
