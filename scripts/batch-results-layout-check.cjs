'use strict';

const assert = require('node:assert/strict');

// Run against the real renderer, rather than a DOM stub: flex shrink can hide
// otherwise correctly rendered content when a batch has many proposed groups.
async function checkBatchResultsLayout(page, { expectedGroups, expectedRows, label = 'batch results' } = {}) {
  const measure = () => page.locator('#batch-results-dialog').evaluate(dialog => {
    const box = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }; };
    const list = dialog.querySelector('#batch-results-list');
    const groups = [...list.querySelectorAll('.batch-result-group')];
    const rows = [...list.querySelectorAll('.batch-result-item')];
    return {
      dialog: box(dialog), footer: box(dialog.querySelector('.dialog-form-actions')), viewport: { width: innerWidth, height: innerHeight },
      scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
      groups: groups.map(group => ({ name: group.getAttribute('data-batch-group-name'), rect: box(group), heading: box(group.querySelector('.batch-group-heading')), records: box(group.querySelector('.batch-group-records')), shrink: getComputedStyle(group).flexShrink })),
      rows: rows.map(row => ({ rect: box(row), text: [...row.querySelectorAll('.batch-result-heading,.batch-summary')].map(element => ({ rect: box(element), lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight), whiteSpace: getComputedStyle(element).whiteSpace, value: element.textContent })) })),
    };
  });
  const result = await measure();
  if (expectedGroups !== undefined) assert.equal(result.groups.length, expectedGroups, label + ': every proposed group is rendered');
  if (expectedRows !== undefined) assert.equal(result.rows.length, expectedRows, label + ': every record is rendered');
  assert.ok(result.groups.length && result.rows.length, label + ': batch must contain real content');
  for (const group of result.groups) {
    assert.equal(group.shrink, '0', label + ': groups must scroll instead of shrinking: ' + group.name);
    assert.ok(group.rect.height + 1 >= group.heading.height + group.records.height, label + ': group must retain heading and records: ' + JSON.stringify(group));
    assert.ok(group.heading.top >= group.rect.top && group.records.bottom <= group.rect.bottom + 1, label + ': no inner group content is clipped: ' + group.name);
  }
  for (const row of result.rows) {
    assert.ok(row.rect.height >= 58, label + ': records must retain a readable height');
    for (const text of row.text) {
      assert.ok(text.value.length > 0, label + ': title and brief must be present');
      assert.equal(text.whiteSpace, 'nowrap', label + ': title and brief must stay on one line');
      assert.ok(text.rect.height <= text.lineHeight + 1, label + ': title and brief must not wrap');
      assert.ok(text.rect.top >= row.rect.top && text.rect.bottom <= row.rect.bottom + 1, label + ': row text must not be cut off');
    }
  }
  assert.ok(result.dialog.top >= -1 && result.dialog.bottom <= result.viewport.height + 1, label + ': dialog must fit the viewport');
  assert.ok(result.dialog.left >= -1 && result.dialog.right <= result.viewport.width + 1, label + ': dialog must fit the viewport width');
  assert.ok(result.footer.bottom <= result.dialog.bottom && result.footer.top >= result.dialog.top, label + ': apply action must remain visible');
  if (result.groups.length >= 10) assert.ok(result.scrollHeight > result.clientHeight + 1, label + ': long results must have their own scroll area');
  // A group can itself be taller than a short window; reaching its bottom is
  // what matters, not forcing the entire group into the viewport at once.
  await page.locator('#batch-results-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
  const last = await page.locator('.batch-result-group').last().evaluate(group => { const list = group.parentElement.getBoundingClientRect(); const rect = group.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, listTop: list.top, listBottom: list.bottom }; });
  assert.ok(last.bottom <= last.listBottom + 1 && last.bottom > last.listTop, label + ': final group can be reached by scrolling');
  await page.locator('#batch-results-list').evaluate(list => { list.scrollTop = 0; });
  return result;
}

module.exports = { checkBatchResultsLayout };
