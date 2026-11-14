'use strict';

const mainChrome = Object.freeze({
  titleBarStyle: 'hidden',
  // Match the height of the shared shell to the Windows caption button width.
  titleBarOverlay: Object.freeze({ color: '#EFF2F0', symbolColor: '#171A1D', height: 46 }),
});

// Only the paused text editor can activate the overlay. Presentation uses
// showInactive so transcription never takes focus away from another app.
const overlayBehavior = Object.freeze({ focusable: false, skipTaskbar: true });
const modalChrome = Object.freeze({ color:'#B8B8B8', symbolColor:'#111315', height:mainChrome.titleBarOverlay.height });
const imageViewerChrome = Object.freeze({ color:'#00000000', symbolColor:'#00000000', height:mainChrome.titleBarOverlay.height });
const modalWindows = new WeakMap();

function setWindowModalState(window, active, imageViewer = false) {
  if (typeof active !== 'boolean' || typeof imageViewer !== 'boolean') throw new Error('弹窗状态必须为布尔值。');
  if (!window || window.isDestroyed()) return { active:false };
  const previous = modalWindows.get(window);
  if (active) {
    const chrome = imageViewer ? imageViewerChrome : modalChrome;
    if (previous) {
      if (previous.chrome !== chrome) {
        window.setTitleBarOverlay(chrome);
        previous.chrome = chrome;
      }
      return { active:true };
    }
    const saved = { chrome, minimizable:window.isMinimizable(), maximizable:window.isMaximizable(), closable:window.isClosable() };
    modalWindows.set(window,saved);
    try {
      window.setTitleBarOverlay(chrome);
      window.setMinimizable(false); window.setMaximizable(false); window.setClosable(false);
    } catch (error) { setWindowModalState(window,false); throw error; }
  } else if (previous) {
    window.setTitleBarOverlay(mainChrome.titleBarOverlay);
    window.setMinimizable(previous.minimizable); window.setMaximizable(previous.maximizable); window.setClosable(previous.closable);
    modalWindows.delete(window);
  }
  return { active };
}

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

module.exports = { mainChrome, modalChrome, imageViewerChrome, overlayBehavior, windowState, controlWindow, setWindowModalState };
