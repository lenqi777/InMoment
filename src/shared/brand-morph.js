/* InMoment's two ink contours morph within a stationary brand circle. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = { circle: '#324C36', gold: '#D9B57A', cream: '#F5EDCF' };
  const SHAPES = {
    logo: [
      { d: 'M38.2 16.2a4.4 4.4 0 1 1-8.8 0a4.4 4.4 0 1 1 8.8 0Z' },
      { scale: 2, d: 'M12.9 12.8c1.2-.6 2.8-.8 4.2-.5 1 .2 1.5.9 1.2 2l-1.9 7c-.2.8 0 1.3.7 1.3.8 0 1.6-.4 2.2-1l.8 1.5c-1.5 1.4-3.2 2-4.9 1.9-2.3-.1-3.4-1.4-2.7-3.8l1.7-6.4c.2-.7 0-.9-1.2-.5z' }
    ],
    pause: [
      { d: 'M24 18C28 18 29 20 28 24L24 42C23 46 21 47 18 46C15 45 15 43 16 40L20 22C20.5 19 21 18 24 18Z' },
      { d: 'M40 17C44 17 46 19 45 23L41 41C40.5 44 42 44 44 43L45 46C40 50 34 49 33 45C32.5 43 33 41 34 38L38 21C38.5 18 38.5 17 40 17Z' }
    ],
    play: [
      { d: 'M47.75528258 16.45491503A5 3 -18 1 1 38.24471742 19.54508497A5 3 -18 1 1 47.75528258 16.45491503Z' },
      { d: 'M24.5 18L45.8 30.9C47.9 32.2 47.9 32.9 45.8 34.2L24.7 46.7C21.4 48.6 20.2 47.7 21.2 43.8L24.7 29.4C24.9 28.5 25.4 28 26.3 28H28.6C29.8 28 30.2 28.6 29.9 29.8L27.8 38.1C27.5 39.4 27.9 39.7 29 39L37.7 33.1C38.8 32.4 38.8 31.9 37.7 31.2L24.4 23.9C23.5 23.4 23 22.7 23 21.7V19C23 17.8 23.4 17.4 24.5 18Z' }
    ]
  };
  const copy = contours => contours.map(points => points.map(point => [...point]));
  function interpolate(from, to, progress) {
    return from.map((points, index) => points.map((point, offset) => point.map((value, axis) => value + (to[index][offset][axis] - value) * progress)));
  }
  // Keep the currently painted geometry on reversal, rather than restarting a keyframe.
  function createController({ shapes, paint, requestFrame, cancelFrame, now, reducedMotion = () => false, duration = 320 }) {
    let current = copy(shapes.logo), target = 'logo', frame = 0, disposed = false;
    paint(current);
    function settle() { if (frame) cancelFrame(frame); frame = 0; current = copy(shapes[target]); paint(current); }
    function setState(state, options = {}) {
      if (disposed || !shapes[state]) return;
      if (state === target && !options.immediate) return;
      target = state;
      if (frame) cancelFrame(frame);
      frame = 0;
      if (options.immediate || reducedMotion()) { settle(); return; }
      const from = copy(current), destination = shapes[state], started = now();
      const step = timestamp => {
        frame = 0;
        if (disposed) return;
        if (reducedMotion()) { settle(); return; }
        const elapsed = Math.max(0, Math.min(1, (timestamp - started) / duration));
        const eased = elapsed < .5 ? 4 * elapsed ** 3 : 1 - (-2 * elapsed + 2) ** 3 / 2;
        current = interpolate(from, destination, eased); paint(current);
        if (elapsed < 1) frame = requestFrame(step);
        else { current = copy(destination); paint(current); }
      };
      frame = requestFrame(step);
    }
    return { setState, settle, destroy() { disposed = true; if (frame) cancelFrame(frame); frame = 0; } };
  }
  function pathData(points) { return points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(3)} ${point[1].toFixed(3)}`).join('') + 'Z'; }
  function align(points, reference) {
    let best = 0, minimum = Infinity;
    for (let offset = 0; offset < points.length; offset++) {
      const distance = reference.reduce((total, point, index) => {
        const candidate = points[(index + offset) % points.length];
        return total + (point[0] - candidate[0]) ** 2 + (point[1] - candidate[1]) ** 2;
      }, 0);
      if (distance < minimum) { minimum = distance; best = offset; }
    }
    return points.map((_, index) => points[(index + best) % points.length]);
  }
  function mount(container, options = {}) {
    const doc = container.ownerDocument, win = doc.defaultView;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    if (options.background !== false) {
      const circle = doc.createElementNS(NS, 'circle');
      for (const [name, value] of Object.entries({ cx: 32, cy: 32, r: 32, fill: COLORS.circle })) circle.setAttribute(name, value);
      svg.append(circle);
    }
    const colors=Array.isArray(options.colors)&&options.colors.length===2?options.colors:[COLORS.gold,COLORS.cream];
    const ink = colors.map(color => { const path = doc.createElementNS(NS, 'path'); path.setAttribute('fill', color); svg.append(path); return path; });
    container.replaceChildren(svg);
    // Equal arc-length samples preserve the selected silhouettes, including the play notch.
    const shapes = Object.fromEntries(Object.entries(SHAPES).map(([name, contours]) => [name, contours.map(contour => {
      const path = doc.createElementNS(NS, 'path'); path.setAttribute('d', contour.d);
      const length = path.getTotalLength(), scale = contour.scale || 1;
      return Array.from({ length: 128 }, (_, index) => { const point = path.getPointAtLength(length * index / 128); return [point.x * scale, point.y * scale]; });
    })]));
    for (let contour = 0; contour < 2; contour++) {
      shapes.logo[contour] = align(shapes.logo[contour], shapes.pause[contour]);
      shapes.play[contour] = align(shapes.play[contour], shapes.pause[contour]);
    }
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    const controller = createController({ shapes, paint: contours => contours.forEach((points, index) => ink[index].setAttribute('d', pathData(points))), requestFrame: fn => win.requestAnimationFrame(fn), cancelFrame: id => win.cancelAnimationFrame(id), now: () => win.performance.now(), reducedMotion: () => media.matches });
    const reduced = () => { if (media.matches) controller.settle(); };
    media.addEventListener('change', reduced);
    return { setState(state, options) { container.dataset.symbol = state; controller.setState(state, options); }, destroy() { media.removeEventListener('change', reduced); controller.destroy(); } };
  }
  const api = { mount, createController, interpolate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InMomentBrandMorph = api;
})(typeof window === 'undefined' ? globalThis : window);
