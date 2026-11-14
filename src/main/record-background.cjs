'use strict';

function sourceWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//iu.test(value.trim())) return '';
  try {
    const url = new URL(value.trim());
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* The address bar may contain search text. */ }
  return '';
}

function preferredScreenshot(record) {
  return record.screenshots?.find(item => item.method === 'region') || record.screenshots?.[0];
}

function recordMediaURL(recordId, kind, attachmentId) {
  return `inmoment-media://record/${encodeURIComponent(recordId)}/${kind}/${encodeURIComponent(attachmentId)}`;
}

module.exports = { sourceWebUrl, preferredScreenshot, recordMediaURL };
