'use strict';
// Keep machine-wide, user-specific skill configuration in the working copy.
// Published AGENTS.md retains the project rules used by contributors.
const BEGIN = '<!-- BEGIN anti-defensive-writing global rule -->';
const END = '<!-- END anti-defensive-writing global rule -->';
function publicationText(name, content) {
  if (name !== 'AGENTS.md') return content;
  const beginCount = content.split(BEGIN).length - 1;
  const endCount = content.split(END).length - 1;
  if (beginCount !== endCount) throw new Error('Unbalanced user skill block in AGENTS.md');
  let result = content;
  for (let index = 0; index < beginCount; index++) {
    const begin = result.indexOf(BEGIN);
    const end = result.indexOf(END, begin);
    if (end < begin) throw new Error('Misordered user skill block in AGENTS.md');
    result = result.slice(0, begin) + result.slice(end + END.length);
  }
  return beginCount ? result.replace(/\n{3,}/gu, '\n\n').trimEnd() + '\n' : result;
}
module.exports = { publicationText };
