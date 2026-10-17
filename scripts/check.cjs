'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const roots = ['src', 'native', 'scripts', 'tests', 'docs', '.github'];
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.tmp-')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename); else files.push(filename);
  }
}
for (const folder of roots) walk(path.join(root, folder));
for (const name of ['README.md', 'PRIVACY.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'package.json', '.env.example', '.gitignore', 'AGENTS.md', 'LICENSE']) if (fs.existsSync(path.join(root, name))) files.push(path.join(root, name));
let failed = false;
for (const filename of files) {
  const relative = path.relative(root, filename);
  if (/\.(?:js|cjs)$/u.test(filename)) {
    const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) { failed = true; console.error('Syntax check failed:', relative); console.error(result.stderr); }
  }
  if (!/\.(?:exe|png|wav|ico|zip)$/u.test(filename)) {
    const content = fs.readFileSync(filename, 'utf8');
    if (/\bsk-[A-Za-z0-9]{20,}\b/u.test(content) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) { failed = true; console.error('Potential credential found in:', relative); }
  }
}
if (failed) process.exit(1);
console.log(`Checked ${files.length} source files: syntax and credential patterns passed.`);
