'use strict';
// Stage an independent, allowlisted source tree. This script never runs Git or
// accesses GitHub, app settings, databases, recordings or private backups.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, 'release-preparation/delivery/repository'));
if (destination === root || fs.existsSync(destination)) throw new Error('Choose a new, empty publication directory. Existing directories are never overwritten.');
const files = ['.env.example', '.gitignore', 'AGENTS.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'PRIVACY.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_SOURCE_OFFER.md', 'CONTRIBUTING.md'];
fs.mkdirSync(destination, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(destination, file));
for (const folder of ['.github', 'src', 'native', 'scripts', 'tests', 'docs']) {
  fs.cpSync(path.join(root, folder), path.join(destination, folder), { recursive: true, filter: filename => {
    const name = path.basename(filename);
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Source publication rejects links: ' + path.relative(root, filename));
    return !name.startsWith('.tmp-') && name !== 'inmoment-demo.mp4';
  } });
}
const manifest = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(filename);
    else {
      const bytes = fs.readFileSync(filename); const relative = path.relative(destination, filename).split(path.sep).join('/');
      if (/\.(?:md|json|html|js|cjs|ps1|cmd|yaml|yml|txt|cs)$/iu.test(relative)) {
        const content = bytes.toString('utf8');
        if (/\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) throw new Error('Potential credential in ' + relative);
        if (/\b[a-z]:[\\/]+(?:Users[\\/]+[^\\/\s"'<>]+|(?:Products|projects?|workspaces?)[\\/])/iu.test(content)) throw new Error('Personal absolute path in ' + relative);
      }
      manifest.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
visit(destination);
const manifestFile = path.join(path.dirname(destination), 'publishing/source-files.json');
fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify({ version: require('../package.json').version, files: manifest }, null, 2));
console.log(JSON.stringify({ files: manifest.length, bytes: manifest.reduce((sum, item) => sum + item.bytes, 0), models: 0, userData: 0, gitHistory: false }));
