'use strict';
const fs = require('node:fs');

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
function selectedScreenshot(store, record) {
  if (record?.status !== 'saved' || !record.screenshots?.length) throw new Error('这条已保存记录没有可发送的截图。');
  const file = store.safePath(record.screenshots[0].path);
  const size = fs.statSync(file).size;
  if (size < 24 || size > MAX_IMAGE_BYTES) throw new Error('截图文件无效或超过 32 MiB，本次没有发送。');
  const data = fs.readFileSync(file);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('截图不是有效的 PNG，本次没有发送。');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192) throw new Error('截图边长超过图像接口限制，本次没有发送。');
  return { mimeType: 'image/png', base64: data.toString('base64') };
}
module.exports = { selectedScreenshot, MAX_IMAGE_BYTES };
