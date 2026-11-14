'use strict';

function clampOverlayPosition(point, bounds, work) {
  const left=work.x+12,top=work.y+12;
  return { x:Math.round(Math.max(left,Math.min(point.x,work.x+work.width-bounds.width-12))), y:Math.round(Math.max(top,Math.min(point.y,work.y+work.height-bounds.height-12))) };
}

function surfaceInDip(rect, zoom, bounds) {
  const left = Math.floor(rect.x * zoom), top = Math.floor(rect.y * zoom);
  const right = Math.min(bounds.width, Math.ceil((rect.x + rect.width) * zoom));
  const bottom = Math.min(bounds.height, Math.ceil((rect.y + rect.height) * zoom));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function overlaps(point, size, rect) {
  return point.x < rect.x + rect.width && point.x + size.width > rect.x &&
    point.y < rect.y + rect.height && point.y + size.height > rect.y;
}

function regionPosition({ toolbar, selection }, surface, work) {
  const gap = 10;
  const x = toolbar.x + toolbar.width - surface.width;
  const y = toolbar.y + toolbar.height + gap;
  const candidates = [
    { x, y },
    { x, y: toolbar.y - surface.height - gap },
    { x, y: selection.y + selection.height + gap },
    { x, y: selection.y - surface.height - gap },
    { x: selection.x - surface.width - gap, y },
    { x: selection.x + selection.width + gap, y },
    { x, y: work.y },
    { x, y: work.y + work.height - surface.height },
  ].map(point => clampOverlayPosition(point, surface, work));
  const clearToolbar = candidates.filter(point => !overlaps(point, surface, toolbar));
  return clearToolbar.find(point => !overlaps(point, surface, selection)) ?? clearToolbar[0] ?? candidates[0];
}

class OverlayPlacement {
  constructor({ getWindow, screen, offsetY = 16 }) {
    Object.assign(this, { getWindow, screen, offsetY });
    this.draftId = null;
    this.pendingPreview = false;
    this.editorActive = null;
    this.surface = null;
  }
  place(point) {
    const window=this.getWindow();if(!window||window.isDestroyed())return;
    const cursor=point&&Number.isFinite(point.x)&&Number.isFinite(point.y)?this.screen.screenToDipPoint({x:point.x,y:point.y}):this.screen.getCursorScreenPoint();
    const position=clampOverlayPosition({x:cursor.x+24,y:cursor.y+this.offsetY},window.getBounds(),this.screen.getDisplayNearestPoint(cursor).workArea);
    window.setPosition(position.x,position.y);
  }
  preview(point) { this.draftId=null;this.pendingPreview=true;this.place(point); }
  show(draftId, display, anchor) {
    if(this.pendingPreview){this.pendingPreview=false;this.draftId=draftId;return;}
    if(draftId&&this.draftId===draftId)return;
    const window = this.getWindow();
    if (display?.bounds && window && !window.isDestroyed()) {
      const work = this.screen.getDisplayMatching(display.bounds).workArea;
      const bounds = window.getBounds();
      // Use the compact panel's initial CSS dimensions until the renderer measures it.
      const compact = anchor && surfaceInDip({ x: 9, y: 29, width: 234, height: 48 }, window.webContents.getZoomFactor(), bounds);
      if (compact) {
        this.surface = compact;
        const point = regionPosition(anchor, compact, work);
        window.setPosition(point.x - compact.x, point.y - compact.y);
      } else {
        const point = clampOverlayPosition({ x: work.x + work.width - 288, y: work.y }, bounds, work);
        window.setPosition(point.x, point.y);
      }
    } else this.place();
    this.draftId=draftId;
  }
  setEditorActive(active) {
    const window = this.getWindow();
    if (this.editorActive === active || !window || window.isDestroyed()) return;
    this.editorActive = active;
    // Electron's floating level follows the Windows taskbar's z-order. A
    // fullscreen app can make that band non-topmost. The panel fits the work area.
    const level = active || process.platform === 'win32' ? 'screen-saver' : 'floating';
    window.setAlwaysOnTop(true, level);
    window.setShape(active && this.surface ? [this.surface] : []);
  }
  setSurface(rect) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    const { x, y, width, height } = rect || {};
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0) return;
    const zoom = window.webContents.getZoomFactor();
    const bounds = window.getBounds();
    const surface = surfaceInDip(rect, zoom, bounds);
    if (!surface) return;
    if (this.surface && Object.keys(surface).every(key => this.surface[key] === surface[key])) return;
    this.surface = surface;
    if (this.editorActive) window.setShape([surface]);
    this.fitSurface();
  }
  fitSurface() {
    const window = this.getWindow();
    if (!window || window.isDestroyed() || !window.isVisible() || !this.surface) return;
    const { x, y } = window.getBounds();
    const { x: left, y: top, width, height } = this.surface;
    const point = { x: x + left, y: y + top };
    const work = this.screen.getDisplayNearestPoint({ x: point.x + width / 2, y: point.y + height / 2 }).workArea;
    const fit = clampOverlayPosition(point, this.surface, work);
    if (fit.x !== point.x || fit.y !== point.y) window.setPosition(fit.x - left, fit.y - top);
  }
  cancelPreview(draftId) { if(this.pendingPreview&&draftId)this.draftId=draftId;this.pendingPreview=false; }
}

module.exports={OverlayPlacement,clampOverlayPosition};
