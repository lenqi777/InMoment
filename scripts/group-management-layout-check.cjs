'use strict';

const assert = require('node:assert/strict');

async function checkGroupManagementLayout(page, { expectedRows, label = 'group management' } = {}) {
  const read = () => page.locator('#group-management-dialog').evaluate(dialog => {
    const box = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }; };
    const list = dialog.querySelector('#topic-management-list');
    return {
      viewport: { width: innerWidth, height: innerHeight }, dialog: box(dialog), dialogScroll: dialog.scrollTop,
      list: box(list), clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
      controls: [...dialog.querySelectorAll('#group-management-title,.topic-create,.topic-management-toolbar,.topic-management-selection,#topic-management-status')].filter(element => element.getBoundingClientRect().height).map(element => ({ id: element.id || element.className, rect: box(element) })),
      rows: [...list.querySelectorAll('.topic-manager-row')].map(row => ({ rect: box(row), name: box(row.querySelector('.topic-manager-name')) })),
    };
  });
  const result = await read();
  if (expectedRows !== undefined) assert.equal(result.rows.length, expectedRows, label + ': every group must be present');
  assert.ok(result.dialog.top >= -1 && result.dialog.bottom <= result.viewport.height + 1, label + ': dialog must fit the viewport');
  assert.ok(result.dialog.left >= -1 && result.dialog.right <= result.viewport.width + 1, label + ': dialog must fit the viewport width');
  assert.ok(result.clientHeight >= 56, label + ': at least one readable row must remain visible');
  for (const control of result.controls) assert.ok(control.rect.top >= result.dialog.top && control.rect.bottom <= result.dialog.bottom, label + ': fixed control must stay visible: ' + control.id);
  for (const row of result.rows) {
    assert.ok(row.rect.height >= 56, label + ': group rows must retain their height');
    assert.ok(row.name.top >= row.rect.top && row.name.bottom <= row.rect.bottom, label + ': group name must fit the row');
  }
  await page.locator('#topic-management-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
  const after = await read();
  assert.equal(after.dialogScroll, 0, label + ': only the list may scroll');
  assert.deepEqual(after.controls, result.controls, label + ': headings and actions must remain fixed when the list scrolls');
  assert.ok(after.rows.at(-1).rect.bottom <= after.list.bottom + 1 && after.rows.at(-1).rect.bottom > after.list.top, label + ': final group can be reached');
  await page.locator('#topic-management-list').evaluate(list => { list.scrollTop = 0; });
  return result;
}

module.exports = { checkGroupManagementLayout };
