'use strict';

const fs = require('node:fs');
const path = require('node:path');
const candidates = [path.join(__dirname, '../src/main/semantic-installer.cjs'), path.join(__dirname, '../resources/app/src/main/semantic-installer.cjs')];
const source = candidates.find(file => fs.existsSync(file));
if (!source) throw new Error('Semantic installer module is missing.');
const { ModelInstaller, MODEL_MANIFEST } = require(source);

async function main(args = process.argv.slice(2)) {
  const directoryIndex = args.indexOf('--directory');
  if (directoryIndex >= 0 && (!args[directoryIndex + 1] || args[directoryIndex + 1].startsWith('--'))) throw new Error('--directory requires a path.');
  const defaultDirectory = source === candidates[1] ? path.resolve(__dirname, '..', 'offline-semantic') : path.resolve(__dirname, '..', '.local', 'semantic');
  const directory = directoryIndex >= 0 ? path.resolve(args[directoryIndex + 1]) : defaultDirectory;
  let reported = '';
  const installer = new ModelInstaller({ directory, networkDisabled: process.env.INMOMENT_DISABLE_NETWORK === '1', onProgress(status) {
    const percent = Math.floor(status.downloaded / status.totalBytes * 100); const value = status.phase + ':' + Math.floor(percent / 5) + ':' + (status.attempt || 0) + ':' + (status.file || '');
    if (value !== reported) { reported = value; console.log(status.phase, percent + '%', status.file || '', status.attempt ? `attempt ${status.attempt}/4` : ''); }
  } });
  if (!args.includes('--approve-download') || args.includes('--status')) {
    console.log(JSON.stringify({ model: MODEL_MANIFEST.id, revision: MODEL_MANIFEST.revision, downloadBytes: MODEL_MANIFEST.totalBytes, ...installer.status(), notice: 'No download or inference performed. Pass --approve-download to install only; this helper never loads or runs a model.' }, null, 2)); return;
  }
  const interrupt = () => installer.cancel(); process.on('SIGINT', interrupt);
  try { await installer.install({ approved: true }); console.log('Model installed and integrity verified. No model was loaded or executed.'); }
  finally { process.removeListener('SIGINT', interrupt); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = error.code === 'SEMANTIC_CANCELLED' ? 130 : 1; });
module.exports = { main };
