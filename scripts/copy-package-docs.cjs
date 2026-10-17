'use strict';
const fs = require('node:fs'); const path = require('node:path');
function copyPackageDocuments(root, target) {
  for (const name of ['LICENSE', 'AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'README.en.md', 'CHANGELOG.md', 'PRIVACY.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_SOURCE_OFFER.md']) if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(target, name));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(target, 'INMOMENT-LICENSE.txt'));
  fs.cpSync(path.join(root, 'docs'), path.join(target, 'docs'), { recursive: true, filter: filename => path.basename(filename) !== 'inmoment-demo.mp4' });
  fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
  for (const name of ['ux-smoke.cjs', 'batch-results-layout-check.cjs', 'group-management-layout-check.cjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(target, 'scripts', name));
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (/\.md$/u.test(entry.name)) {
        const content = fs.readFileSync(filename, 'utf8').replace(/(\]\()([^\s)]+)(\))/gu, (match, open, url, close) => {
          if (/^[a-z][\w+.-]*:|^#/iu.test(url)) return match;
          const parts = url.split('#'); const resolved = path.resolve(path.dirname(filename), parts[0]);
          const relative = path.relative(path.join(target, 'src'), resolved);
          if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return match;
          const destination = path.join(target, 'resources/app/src', relative);
          return open + path.relative(path.dirname(filename), destination).split(path.sep).join('/') + (parts[1] ? '#' + parts[1] : '') + close;
        });
        fs.writeFileSync(filename, content);
      }
    }
  }
  visit(path.join(target, 'docs'));
}
if (require.main === module) copyPackageDocuments(path.resolve(__dirname, '..'), path.resolve(process.argv[2]));
module.exports = { copyPackageDocuments };
