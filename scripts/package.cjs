'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { copyProductionDependencies, copySemanticModel, verifyRuntimeImport } = require('./runtime-packaging.cjs');
const { verifyPortable } = require('./verify-portable.cjs');
const { copyPackageDocuments } = require('./copy-package-docs.cjs');
const { copyOfflineASR, verifyOfflineASR } = require('./asr-packaging.cjs');
const { OCR_DIRECTORY, copyOfflineOCR, verifyOfflineOCR } = require('./ocr-packaging.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This MVP package targets Windows x64.');
const args = process.argv.slice(2);
const allowed = new Set(['--minimal', '--with-asr', '--with-semantic', '--with-ocr']);
if (args.some(arg => !allowed.has(arg))) throw new Error('Unknown package option. Use the full default, or --minimal for development.');
const withAsr = !args.includes('--minimal') || args.includes('--with-asr');
const withSemantic = !args.includes('--minimal') || args.includes('--with-semantic');
const withOcr = !args.includes('--minimal') || args.includes('--with-ocr');
const full = withAsr && withSemantic && withOcr;
const offlineOcr = path.join(root, '.local', OCR_DIRECTORY);
// A public download contains every local component by default. Never silently
// turn a failed full build into a reduced package or download a model here.
if (withAsr && !fs.existsSync(path.join(root, '.local/asr/asr.json'))) throw new Error('Full package requires the explicitly installed local ASR components. No download was started.');
if (withAsr) verifyOfflineASR(path.join(root, '.local/asr'), { strict: false });
if (withSemantic && !fs.existsSync(path.join(root, '.local/semantic'))) throw new Error('Full package requires the explicitly installed local semantic model. No download was started.');
if (withOcr && !fs.existsSync(offlineOcr)) throw new Error('Offline OCR is missing. Run pnpm ocr:setup before packaging.');
if (withOcr) verifyOfflineOCR(offlineOcr);
const target = path.join(root, 'dist', `InMoment-${pkg.version}-win-x64-${Date.now()}`);
const appDir = path.join(target, 'resources', 'app');
const build = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/build-native.ps1'),
  '-OutputDirectory', path.join(appDir, 'build', 'native'),
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(1);
const executable = require('electron');
const runtime = path.dirname(executable);
fs.cpSync(runtime, target, { recursive: true });
fs.copyFileSync(path.join(runtime, 'LICENSE'), path.join(target, 'ELECTRON-LICENSE.txt'));
// Allowlist packaging: never copy the checkout root, .env, settings, user data or chat attachments.
fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, license: pkg.license, description: pkg.description, dependencies: pkg.dependencies }, null, 2));
const production = copyProductionDependencies(root, appDir);
copyPackageDocuments(root, target);
if (withOcr) copyOfflineOCR(offlineOcr, path.join(appDir, OCR_DIRECTORY));
fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts/setup-offline-asr.ps1'), path.join(target, 'scripts/setup-offline-asr.ps1'));
fs.copyFileSync(path.join(root, 'scripts/asr-assets.json'), path.join(target, 'scripts/asr-assets.json'));
if (withOcr) fs.copyFileSync(path.join(root, 'scripts/ocr-assets.json'), path.join(target, 'scripts/ocr-assets.json'));
fs.copyFileSync(path.join(root, 'scripts/setup-semantic.cjs'), path.join(target, 'scripts/setup-semantic.cjs'));
if (full) {
  fs.copyFileSync(path.join(root, 'scripts/Install-InMoment.ps1'), path.join(target, 'Install-InMoment.ps1'));
  fs.writeFileSync(path.join(target, 'Install-InMoment.cmd'), '@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-InMoment.ps1"\r\nset "INMOMENT_SETUP_RESULT=%ERRORLEVEL%"\r\necho.\r\npause\r\nexit /b %INMOMENT_SETUP_RESULT%\r\n');
}
fs.writeFileSync(path.join(target, 'Install-Offline-ASR.cmd'), '@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\setup-offline-asr.ps1" -RootDir "%~dp0offline-asr"\r\npause\r\nendlocal\r\n');
if (withAsr) {
  copyOfflineASR(path.join(root, '.local/asr'), path.join(target, 'offline-asr'));
}
if (withSemantic) copySemanticModel(path.join(root, '.local/semantic'), path.join(target, 'offline-semantic'));
fs.renameSync(path.join(target, 'electron.exe'), path.join(target, 'InMoment.exe'));
const iconUpdate = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/set-executable-icon.ps1'), '-Executable', path.join(target, 'InMoment.exe'), '-Icon', path.join(root, 'src/assets/icon.ico')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (iconUpdate.status !== 0) throw new Error('Could not apply the InMoment executable icon.');
if (production.some(item => item.name === '@huggingface/transformers')) verifyRuntimeImport(path.join(target, 'InMoment.exe'), appDir);
fs.writeFileSync(path.join(target, 'START_HERE.txt'), `InMoment ${pkg.version} — Windows 11 x64\r\n\r\n1. Extract the entire ZIP to a writable local folder.\r\n2. ${full ? 'Run Install-InMoment.cmd once for visible prerequisite checks, then open InMoment.exe.' : 'Development-only reduced package: local features may be unavailable.'} Node.js, pnpm and Python are not required.\r\n3. Hold the right mouse button to record; release to pause. Click Continue for hands-free recording.\r\n4. Cloud AI is optional: choose DeepSeek, OpenAI (GPT), or Gemini in Settings, enter that service's API key and approve the features you want. Models are selected automatically; manual selection is in advanced settings.\r\n5. See docs/USER_GUIDE.md for privacy, permissions, backup and version changes.\r\n\r\nLocal ASR bundled: ${withAsr}\r\nLocal semantic model bundled: ${withSemantic}\r\nLocal image OCR bundled: ${withOcr}\r\nNo user records or credentials are included.\r\n`, 'utf8');
verifyPortable(target, { full });
fs.writeFileSync(path.join(root, 'dist', 'latest.txt'), target);
console.log('Portable app created:', target);
