'use strict';
const fs = require('node:fs'); const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.local', 'release', 'release-preparation', 'dist', 'build', 'test-results', 'third-party', 'LICENSES.chromium.html'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename); else if (/\.(?:md|html)$/u.test(entry.name)) files.push(filename);
  }
}
walk(root);
const failures = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/gu, '');
  const links = [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:href|src|poster)="([^"]+)"/gu)].map(item => item[1] || item[2]);
  for (let link of links) {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/iu.test(link)) continue;
    link = decodeURIComponent(link.split(/[?#]/u)[0]);
    if (!link || !/\.[a-z0-9]+$/iu.test(link)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), link))) failures.push({ file: path.relative(root, file), link });
  }
}
console.log(JSON.stringify({ checkedDocuments: files.length, brokenLinks: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
