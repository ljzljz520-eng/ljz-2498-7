import crypto from 'node:crypto';

export function buildMimeMessage({ from, to, subject, html, text, messageId, headers = {} }) {
  const boundaryValue = `campaign-${crypto.randomUUID()}`;
  const boundary = `Content-Type: multipart/alternative; boundary="${boundaryValue}"\r\n\r\n--${boundaryValue}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Date: ' + new Date().toUTCString(),
    'List-Unsubscribe: <' + (extractFirstUnsubscribe(html) ?? '') + '>',
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalize(text),
    `--${boundaryValue}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalize(html),
    `--${boundaryValue}--`,
  ];
  return lines.join('\r\n');
}

function normalize(value) {
  return String(value).replace(/\r?\n/g, '\r\n');
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

function extractFirstUnsubscribe(html) {
  const anchors = [...html.matchAll(/<a\b[^>]*>/gis)].map((m) => m[0]);
  for (const tag of anchors) {
    const href = /\shref\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    if (href && /rel\s*=\s*["'][^"']*unsubscribe/i.test(tag)) return href;
  }
  return null;
}
