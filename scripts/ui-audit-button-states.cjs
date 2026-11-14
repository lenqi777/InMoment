'use strict';

const assert = require('node:assert/strict');
const buttonBackgrounds = {
  idle: 'rgba(0, 0, 0, 0)',
  hover: 'rgba(25, 25, 25, 0.04)',
  pressed: 'rgba(25, 25, 25, 0.04)',
};
const buttonTints = {
  neutral: buttonBackgrounds,
  green: { hover: 'rgba(37, 109, 73, 0.04)', pressed: 'rgba(37, 109, 73, 0.04)' },
  red: { hover: 'rgba(180, 35, 24, 0.04)', pressed: 'rgba(180, 35, 24, 0.04)' },
};
const regularIcon = ['inset(0px)', 'inset(100% 0px 0px)'];
const filledIcon = ['inset(0px 0px 100%)', 'inset(0px)'];

function normalizeButtonBackground(value) {
  // Chromium reports a color-mix in its interpolation color space.
  const match = value.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/u);
  if (!match) return value;
  const rgb = match.slice(1, 4).map(channel => Math.round(Number(channel) * 255));
  return match[4] ? `rgba(${rgb.join(', ')}, ${Number(match[4])})` : `rgb(${rgb.join(', ')})`;
}

async function checkButtonStates(page, selector, { current = false, disabled = false, icon = false, filledAtRest = current, tone = 'neutral', foreground, backgrounds } = {}) {
  const button = page.locator(selector);
  await button.waitFor();
  await page.mouse.move(1, 1);
  const radius = await button.evaluate(element => {
    if (element.matches('.chat-submit')) return '50%';
    return element.matches('.rail-button') ? '16px' : '12px';
  });
  const session = await page.context().newCDPSession(page);
  let nodeId;
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    ({ nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector }));
    assert.ok(nodeId, selector);
    const results = [];
    const read = async (state, pseudo, expected, expectedScale = 1) => {
      await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo });
      const actual = await button.evaluate(async element => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const animations = element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect.getTiming().iterations));
        await Promise.allSettled(animations.map(animation => animation.finished));
        const style = getComputedStyle(element);
        const iconStyles = [...element.querySelectorAll(':scope > .ui-action-icon > span')].map(layer => getComputedStyle(layer));
        return { background: style.backgroundColor, color: style.color, outline: style.outlineStyle, focusMarker: style.backgroundImage.startsWith('linear-gradient'), radius: style.borderRadius, shortestSide: Math.min(element.offsetWidth, element.offsetHeight), scale: Number(style.scale) || 1,
          iconMasks: iconStyles.map(style => style.clipPath), iconColors: iconStyles.map(style => style.backgroundColor) };
      });
      assert.equal(normalizeButtonBackground(actual.background), expected, selector + ' ' + state);
      assert.ok(Math.abs(actual.scale - expectedScale) < .001, selector + ' ' + state + ' scale');
      assert.equal(actual.outline, 'none', selector + ' ' + state + ' outline');
      assert.equal(actual.radius, radius, selector + ' ' + state + ' button radius');
      if (radius.endsWith('px') && actual.shortestSide >= 26) assert.ok(actual.shortestSide > parseInt(radius, 10) * 2, selector + ' ' + state + ' has a straight edge');
      if (icon) {
        const filled = filledAtRest || !disabled && (pseudo.includes('hover') || pseudo.includes('focus-visible'));
        assert.deepEqual(actual.iconMasks, filled ? filledIcon : regularIcon, selector + ' ' + state + ' icon');
        if (foreground) assert.deepEqual(actual.iconColors, [foreground, foreground], selector + ' ' + state + ' icon colors');
      }
      results.push({ state, ...actual });
      return actual;
    };
    const tint = backgrounds || buttonTints[tone];
    assert.ok(tint, `Unknown button tone: ${tone}`);
    const idle = current ? tint.pressed : tint.idle ?? buttonBackgrounds.idle;
    const hover = current || disabled ? idle : tint.hover;
    await read('idle', [], idle);
    await read('hover', ['hover'], hover);
    await read('press', ['hover', 'active'], disabled ? idle : tint.pressed, disabled ? 1 : .97);
    await read('release-over', ['hover'], hover);
    await read('release', [], idle);
    if (icon && !disabled) {
      const focus = await read('keyboard-focus', ['focus', 'focus-visible'], idle);
      assert.equal(focus.focusMarker, true, selector + ' keyboard focus marker');
      await read('blur', [], idle);
    }
    assert.ok(results.every(result => result.color === (foreground || results[0].color)), selector + ' foreground changed');
    return { selector, results };
  } finally {
    if (nodeId) await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    await session.detach();
  }
}

async function checkButtonCorners(page, label) {
  const result = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button, [role=button]:not(svg *), summary, a:is(.button, .icon-button, .text-button)')];
    const regular = controls.filter(element => !element.matches('[role=switch], [role=checkbox], [role=radio]') &&
      element.getClientRects().length && getComputedStyle(element).visibility === 'visible');
    const retainedCorners = [];
    const invalid = [];
    for (const element of regular) {
      const radius = getComputedStyle(element).borderRadius;
      if (element.matches('.chat-submit') && radius === '50%' && element.offsetWidth === element.offsetHeight) continue;
      const expectedRadius = element.matches('.rail-button') ? 16 : 12;
      const shortestSide = Math.min(element.offsetWidth, element.offsetHeight);
      if (radius === `${expectedRadius}px` && (shortestSide < 26 || shortestSide > expectedRadius * 2)) continue;
      const name = element.getAttribute('aria-label') || element.id || element.className || element.tagName;
      if (element.matches('.record-card > .record-open, .screenshot-thumbnail-button, .chat-image-open')) retainedCorners.push({ name, radius });
      else invalid.push({ name, radius, shortestSide, expectedRadius });
    }
    return { controls: regular.length, retainedCorners, invalid };
  });
  assert.ok(result.controls > 0, label + ' had no visible buttons');
  assert.deepEqual(result.invalid, [], label + ' has buttons outside the shared radius');
  return { label, ...result };
}

async function checkButtonRow(page, rowSelector, selectors, { minGap = 8, minInlinePadding = 0, radius } = {}) {
  const { row, buttons } = await page.locator(rowSelector).evaluate((element, selectors) => {
    const buttons = selectors.map(selector => {
      const button = element.querySelector(selector);
      const style = getComputedStyle(button);
      const range = document.createRange();
      range.selectNodeContents(button);
      return {
        selector,
        rect: button.getBoundingClientRect().toJSON(),
        content: range.getBoundingClientRect().toJSON(),
        radius: style.borderRadius,
        round: button.matches('.chat-submit'),
        padding: [parseFloat(style.paddingInlineStart), parseFloat(style.paddingInlineEnd)],
      };
    });
    return { row: element.getBoundingClientRect().toJSON(), buttons };
  }, selectors);
  const gaps = [];
  for (const [index, button] of buttons.entries()) {
    const { selector, rect, padding, content } = button;
    assert.ok(rect.width > 0 && rect.height > 0, `${selector} must be visible`);
    assert.ok(rect.left >= row.left - .5 && rect.right <= row.right + .5, `${selector} must fit inside its row`);
    assert.ok(Math.abs(rect.top + rect.bottom - buttons[0].rect.top - buttons[0].rect.bottom) <= 1, `${selector} must share the row center`);
    if (button.round) {
      assert.equal(button.radius, '50%', `${selector} must have a circular surface`);
      assert.equal(rect.width, rect.height, `${selector} must be square`);
    } else if (radius !== undefined) {
      assert.equal(button.radius, `${radius}px`, `${selector} must share the row radius`);
    }
    assert.ok(padding.every(value => value >= minInlinePadding), `${selector} must have ${minInlinePadding}px inline padding`);
    if (minInlinePadding) {
      assert.ok(content.width > 0 && content.left - rect.left >= minInlinePadding - .5 && rect.right - content.right >= minInlinePadding - .5,
        `${selector} content must fit inside its inline padding`);
    }
    if (index) {
      const gap = rect.left - buttons[index - 1].rect.right;
      assert.ok(gap >= minGap - .1, `${selector} must leave ${minGap}px to the previous button; measured ${gap}px`);
      gaps.push(gap);
    }
  }
  return { rowSelector, row, buttons, gaps };
}

module.exports = { checkButtonStates, checkButtonCorners, checkButtonRow, buttonBackgrounds, buttonTints, normalizeButtonBackground };
