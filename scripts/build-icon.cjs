'use strict';

// Original InMoment vector mark. No fonts, image libraries, network, or GUI needed.
// Rasterize the same cubic paths with supersampling, encode standard RGBA PNGs,
// and package PNG frames in a multi-resolution Windows ICO.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const outputDir = path.resolve(__dirname, '..', 'src', 'assets');
const palette = { green: [50, 76, 54], cream: [245, 237, 207], gold: [217, 181, 122] };
const blockPath = [
  ['M', 5, 1], ['L', 11, 1], ['C', 13.5, 1, 15, 2.5, 15, 5],
  ['L', 15, 11], ['C', 15, 13.5, 13.5, 15, 11, 15],
  ['L', 2.6, 15], ['C', 1.5, 15, 1, 14.5, 1, 13.4],
  ['L', 1, 5], ['C', 1, 2.5, 2.5, 1, 5, 1], ['Z'],
];
const stemPath = [
  ['M', 7.8, 7.15], ['C', 8.7, 6.8, 10.55, 6.8, 10, 8.45],
  ['L', 8.8, 11.85], ['C', 8.55, 12.55, 8.9, 12.7, 9.55, 12.3],
  ['L', 10.05, 11.95], ['L', 9.65, 13],
  ['C', 8.5, 13.8, 6.2, 13.6, 6.85, 11.55],
  ['L', 8.02, 8.35], ['C', 8.2, 7.8, 8, 7.6, 7.3, 7.85],
  ['L', 7.55, 7.25], ['Z'],
];

function flatten(commands) {
  const points = [];
  let current = [0, 0];
  for (const [command, ...values] of commands) {
    if (command === 'M' || command === 'L') { current = values; points.push(current); }
    if (command === 'C') {
      const [x0, y0] = current;
      const [x1, y1, x2, y2, x3, y3] = values;
      for (let step = 1; step <= 32; step++) {
        const t = step / 32; const s = 1 - t;
        points.push([s ** 3 * x0 + 3 * s ** 2 * t * x1 + 3 * s * t ** 2 * x2 + t ** 3 * x3,
          s ** 3 * y0 + 3 * s ** 2 * t * y1 + 3 * s * t ** 2 * y2 + t ** 3 * y3]);
      }
      current = [x3, y3];
    }
  }
  return points;
}

function inside(polygon, x, y) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}

const block = flatten(blockPath);
const stem = flatten(stemPath);
function raster(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size <= 64 ? 8 : 4;
  const total = samples * samples;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const vx = (x + (sx + 0.5) / samples) * 16 / size;
          const vy = (y + (sy + 0.5) / samples) * 16 / size;
          if (!inside(block, vx, vy)) continue;
          let color = palette.green;
          if (inside(stem, vx, vy)) color = palette.cream;
          if ((vx - 10.05) ** 2 + (vy - 4.5) ** 2 <= 1.22 ** 2) color = palette.gold;
          sum[0] += color[0]; sum[1] += color[1]; sum[2] += color[2]; covered++;
        }
      }
      const offset = (y * size + x) * 4;
      if (covered) {
        pixels[offset] = Math.round(sum[0] / covered);
        pixels[offset + 1] = Math.round(sum[1] / covered);
        pixels[offset + 2] = Math.round(sum[2] / covered);
        pixels[offset + 3] = Math.round(covered / total * 255);
      }
    }
  }
  return pixels;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([header, tag, data, checksum]);
}
function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA, standard PNG byte order.
  const pixels = raster(size);
  const stride = size * 4;
  const scanlines = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('sRGB', Buffer.from([0])), chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (let i = 0; i < frames.length; i++) {
    const [size, image] = frames[i]; const entry = 6 + i * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  }
  return Buffer.concat([header, ...frames.map(([, bytes]) => bytes)]);
}
function svgPath(commands) { return commands.map(([command, ...values]) => `${command}${values.join(' ')}`).join(' '); }

fs.mkdirSync(outputDir, { recursive: true });
const frames = new Map([16, 20, 24, 32, 48, 64, 96, 128, 256].map(size => [size, png(size)]));
for (const size of [16, 20, 24, 32]) fs.writeFileSync(path.join(outputDir, `tray-${size}.png`), frames.get(size));
fs.writeFileSync(path.join(outputDir, 'tray-icon.png'), frames.get(32));
fs.writeFileSync(path.join(outputDir, 'tray-icon@2x.png'), frames.get(64));
fs.writeFileSync(path.join(outputDir, 'tray-icon@3x.png'), frames.get(96));
fs.writeFileSync(path.join(outputDir, 'icon.png'), frames.get(256));
fs.writeFileSync(path.join(outputDir, 'icon.ico'), ico([...frames].filter(([size]) => size !== 96)));
fs.writeFileSync(path.join(outputDir, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="256" height="256"><title>InMoment</title><path fill="#324c36" d="${svgPath(blockPath)}"/><path fill="#f5edcf" d="${svgPath(stemPath)}"/><circle cx="10.05" cy="4.5" r="1.22" fill="#d9b57a"/></svg>\n`);
console.log('Generated InMoment SVG, RGBA tray PNGs, and 8-size Windows ICO in src/assets.');
