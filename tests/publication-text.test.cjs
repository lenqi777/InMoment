'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicationText } = require('../scripts/publication-text.cjs');
const begin = '<!-- BEGIN anti-defensive-writing global rule -->';
const end = '<!-- END anti-defensive-writing global rule -->';
test('publication removes user skill blocks while retaining all project rules', () => {
  const examplePath = ['C:', 'Users', 'local-owner', '.codex', 'skills', 'example', 'SKILL.md'].join('/');
  const content = `# Project\n\n${begin}\n${examplePath}\n${end}\n\nKeep capture local.\n\n${begin}\nPrivate user writing configuration\n${end}\n\nPreserve recording interaction.\n`;
  const result = publicationText('AGENTS.md', content);
  assert.match(result, /Keep capture local\./u);
  assert.match(result, /Preserve recording interaction\./u);
  assert.doesNotMatch(result, /local-owner|Private user writing|BEGIN anti-defensive/u);
  assert.equal(publicationText('AGENTS.md', result), result);
});
test('publication leaves ordinary project instructions and other documents unchanged', () => {
  const content = '# Project instructions\r\n\r\nKeep all records local.\r\n';
  assert.equal(publicationText('AGENTS.md', content), content);
  const reference = `${begin}\nDocumented example\n${end}`;
  assert.equal(publicationText('README.md', reference), reference);
});
test('publication refuses incomplete or reversed user skill markers', () => {
  assert.throws(() => publicationText('AGENTS.md', begin + '\nProject rules'), /Unbalanced/u);
  assert.throws(() => publicationText('AGENTS.md', end + '\nProject rules'), /Unbalanced/u);
  assert.throws(() => publicationText('AGENTS.md', end + '\n' + begin), /Misordered/u);
});
