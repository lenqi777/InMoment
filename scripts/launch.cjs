'use strict';
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
if (process.platform !== 'win32') {
  console.error('InMoment MVP currently targets Windows.');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'build/native/InMoment.Native.exe'))) {
  const build = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/build-native.ps1')], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) process.exit(build.status || 1);
}
let executable;
try { executable = require('electron'); } catch { console.error('Please install dependencies first: pnpm install'); process.exit(1); }
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(executable, [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env, windowsHide: false });
child.on('exit', code => process.exit(code || 0));
child.on('error', error => { console.error(error.message); process.exit(1); });
