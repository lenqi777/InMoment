'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { copyProductionDependencies, copySemanticModel, verifyRuntimeImport } = require('./runtime-packaging.cjs');
const { verifyPortable } = require('./verify-portable.cjs');
const { copyPackageDocuments } = require('./copy-package-docs.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This MVP package targets Windows x64.');
const args = process.argv.slice(2);
const allowed = new Set(['--minimal', '--with-asr', '--with-semantic']);
if (args.some(arg => !allowed.has(arg))) throw new Error('Unknown package option. Use the full default, or --minimal for development.');
const withAsr = !args.includes('--minimal') || args.includes('--with-asr');
const withSemantic = !args.includes('--minimal') || args.includes('--with-semantic');
// A public download contains every local component by default. Never silently
// turn a failed full build into a reduced package or download a model here.
if (withAsr && !fs.existsSync(path.join(root, '.local/asr/asr.json'))) throw new Error('Full package requires the explicitly installed local ASR components. No download was started.');
if (withSemantic && !fs.existsSync(path.join(root, '.local/semantic'))) throw new Error('Full package requires the explicitly installed local semantic model. No download was started.');
const build = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/build-native.ps1')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(1);
const executable = require('electron');
const runtime = path.dirname(executable);
const target = path.join(root, 'dist', `InMoment-${pkg.version}-win-x64-${Date.now()}`);
fs.mkdirSync(target, { recursive: true }); fs.cpSync(runtime, target, { recursive: true });
fs.copyFileSync(path.join(runtime, 'LICENSE'), path.join(target, 'ELECTRON-LICENSE.txt'));
const appDir = path.join(target, 'resources', 'app'); fs.mkdirSync(appDir, { recursive: true });
// Allowlist packaging: never copy the checkout root, .env, settings, user data or chat attachments.
fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
fs.mkdirSync(path.join(appDir, 'build/native'), { recursive: true });
fs.copyFileSync(path.join(root, 'build/native/InMoment.Native.exe'), path.join(appDir, 'build/native/InMoment.Native.exe'));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, license: pkg.license, description: pkg.description, dependencies: pkg.dependencies }, null, 2));
const production = copyProductionDependencies(root, appDir);
copyPackageDocuments(root, target);
fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts/setup-offline-asr.ps1'), path.join(target, 'scripts/setup-offline-asr.ps1'));
fs.copyFileSync(path.join(root, 'scripts/download-model.cjs'), path.join(target, 'scripts/download-model.cjs'));
fs.copyFileSync(path.join(root, 'scripts/setup-semantic.cjs'), path.join(target, 'scripts/setup-semantic.cjs'));
if (withAsr && withSemantic) {
  fs.copyFileSync(path.join(root, 'scripts/Install-InMoment.ps1'), path.join(target, 'Install-InMoment.ps1'));
  fs.writeFileSync(path.join(target, 'Install-InMoment.cmd'), '@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-InMoment.ps1"\r\nset "INMOMENT_SETUP_RESULT=%ERRORLEVEL%"\r\necho.\r\npause\r\nexit /b %INMOMENT_SETUP_RESULT%\r\n');
}
fs.writeFileSync(path.join(target, 'Install-Offline-ASR.cmd'), '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\setup-offline-asr.ps1" -RootDir "%~dp0offline-asr" -NodePath "%~dp0InMoment.exe"\r\npause\r\nendlocal\r\n');
if (withAsr) {
  const asrSource = path.join(root, '.local/asr');
  fs.mkdirSync(path.join(target, 'offline-asr'), { recursive: true });
  for (const name of ['asr.json', 'WHISPER-CPP-LICENSE.txt', 'WHISPER-MODEL-LICENSE.txt']) {
    const from = path.join(asrSource, name); if (!fs.existsSync(from)) throw new Error('Install the optional offline recognizer before packaging it.');
    fs.cpSync(from, path.join(target, 'offline-asr', name), { recursive: true });
  }
  fs.mkdirSync(path.join(target, 'offline-asr/bin'), { recursive: true });
  for (const name of fs.readdirSync(path.join(asrSource, 'bin')).filter(name => name === 'whisper-cli.exe' || /^(?:whisper|ggml(?:-[a-z0-9]+)*)\.dll$/iu.test(name))) fs.copyFileSync(path.join(asrSource, 'bin', name), path.join(target, 'offline-asr/bin', name));
  fs.mkdirSync(path.join(target, 'offline-asr/models'), { recursive: true });
  fs.copyFileSync(path.join(asrSource, 'models/ggml-base.bin'), path.join(target, 'offline-asr/models/ggml-base.bin'));
}
if (withSemantic) copySemanticModel(path.join(root, '.local/semantic'), path.join(target, 'offline-semantic'));
fs.renameSync(path.join(target, 'electron.exe'), path.join(target, 'InMoment.exe'));
const iconUpdate = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/set-executable-icon.ps1'), '-Executable', path.join(target, 'InMoment.exe'), '-Icon', path.join(root, 'src/assets/icon.ico')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (iconUpdate.status !== 0) throw new Error('Could not apply the InMoment executable icon.');
if (production.some(item => item.name === '@huggingface/transformers')) verifyRuntimeImport(path.join(target, 'InMoment.exe'), appDir);
fs.writeFileSync(path.join(target, 'START_HERE.txt'), `InMoment ${pkg.version} — Windows 11 x64\r\n\r\n1. Extract the entire ZIP to a writable local folder.\r\n2. ${withAsr && withSemantic ? 'Run Install-InMoment.cmd once for visible prerequisite checks, then open InMoment.exe.' : 'Development-only reduced package: local features may be unavailable.'} Node.js, pnpm and Python are not required.\r\n3. Hold the right mouse button to record; release to pause. Click Continue for hands-free recording.\r\n4. Cloud AI is optional: enter your own DeepSeek API key in Settings and approve the features you want.\r\n5. See docs/USER_GUIDE.md for privacy, permissions, backup and version changes.\r\n\r\nLocal ASR bundled: ${withAsr}\r\nLocal semantic model bundled: ${withSemantic}\r\nNo user records or credentials are included.\r\n`, 'utf8');
verifyPortable(target, { full: withAsr && withSemantic });
fs.writeFileSync(path.join(root, 'dist', 'latest.txt'), target);
console.log('Portable app created:', target);
