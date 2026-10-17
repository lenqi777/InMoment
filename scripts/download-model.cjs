'use strict';
// Explicit installer only. No user content, credentials or inference APIs are involved.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../.local/asr'));
const totalSize = 147951465;
const expectedSHA1 = '465707469ff3a37a2b9b8d8f89f2f99de7299dac';
const modelDir = path.join(root, 'models'); const partsDir = path.join(root, 'downloads', 'base-parts');
const target = path.join(modelDir, 'ggml-base.bin');
fs.mkdirSync(modelDir, { recursive: true }); fs.mkdirSync(partsDir, { recursive: true });
function hash(filename) { return new Promise((resolve, reject) => { const digest = crypto.createHash('sha1'); const stream = fs.createReadStream(filename); stream.on('error', reject); stream.on('data', bytes => digest.update(bytes)); stream.on('end', () => resolve(digest.digest('hex'))); }); }
async function part(index, start, end) {
  const filename = path.join(partsDir, `${index}.bin`); const header = path.join(partsDir, `${index}.headers`); const size = end - start + 1;
  if (fs.existsSync(filename) && fs.statSync(filename).size === size) return filename;
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true&inmoment_part=${index}&attempt=${attempt}`;
    const code = await new Promise((resolve, reject) => {
      const child = spawn('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '90', '--speed-time', '20', '--speed-limit', '1024', '--range', `${start}-${end}`, '--dump-header', header, '--output', filename, url], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.resume(); child.once('error', reject); child.once('close', resolve);
    });
    const headers = fs.existsSync(header) ? fs.readFileSync(header, 'utf8') : '';
    const ranges = [...headers.matchAll(/content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/giu)]; const range = ranges.at(-1);
    if (code === 0 && fs.existsSync(filename) && fs.statSync(filename).size === size && range && Number(range[1]) === start && Number(range[2]) === end && Number(range[3]) === totalSize) return filename;
  }
  throw new Error(`Public model download part ${index + 1} failed; rerun the installer to resume.`);
}
(async () => {
  if (fs.existsSync(target) && await hash(target) === expectedSHA1) { console.log('Offline model already verified.'); return; }
  const block = 4 * 1024 * 1024; const count = Math.ceil(totalSize / block); const parts = new Array(count); let next = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < count) { const index = next++; parts[index] = await part(index, index * block, Math.min(totalSize - 1, (index + 1) * block - 1)); done++; if (done % 4 === 0 || done === count) console.log(`Offline model: ${done}/${count} verified ranges downloaded.`); }
  }));
  const pending = target + '.part'; const fd = fs.openSync(pending, 'w');
  try { for (const filename of parts) fs.writeSync(fd, fs.readFileSync(filename)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.statSync(pending).size !== totalSize || await hash(pending) !== expectedSHA1) throw new Error('The complete model does not match its published hash. It was not installed.');
  fs.renameSync(pending, target);
  // This is the one explicit installer staging directory, validated before recursive deletion.
  const resolvedRoot = fs.realpathSync(root); const resolvedParts = fs.realpathSync(partsDir); const relative = path.relative(resolvedRoot, resolvedParts);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative === path.join('downloads', 'base-parts')) fs.rmSync(resolvedParts, { recursive: true, force: true });
  console.log('Complete offline model verified against the original published SHA-1.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
