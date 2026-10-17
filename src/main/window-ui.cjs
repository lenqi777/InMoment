'use strict';

const mainChrome = Object.freeze({
  titleBarStyle: 'hidden',
  titleBarOverlay: Object.freeze({ color: '#f8f7f2', symbolColor: '#324c36', height: 40 }),
});

// showInactive avoids taking focus at presentation time. A non-focusable window
// also keeps pointer actions on the recording controls from activating it.
const overlayBehavior = Object.freeze({ focusable: false, skipTaskbar: true });

function windowState(window) {
  return { maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()) };
}

function controlWindow(window, action) {
  if (!window || window.isDestroyed()) throw new Error('主窗口已经关闭。');
  switch (action) {
    case 'minimize': window.minimize(); break;
    case 'toggleMaximize': if (window.isMaximized()) window.unmaximize(); else window.maximize(); break;
    case 'close': window.close(); break;
    case 'state': break;
    default: throw new Error('不支持的窗口操作。');
  }
  return windowState(window);
}

module.exports = { mainChrome, overlayBehavior, windowState, controlWindow };
