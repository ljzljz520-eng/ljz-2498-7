import crypto from 'node:crypto';

export function audienceSnapshot(members) {
  const rows = members
    .filter((m) => m.subscribed && !m.deleted_at)
    .map((m) => ({
      member_id: m.id,
      email: m.email,
      name: m.name,
      subscribed: m.subscribed,
      version: m.version,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
  const checksum = crypto.createHash('sha256').update(canonical(rows)).digest('hex');
  return { rows, checksum };
}

export function canonical(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

export function publishPayload({ subject, previewText, bodyHtml, trackingBase, trackingParams }) {
  const payload = { subject, previewText, bodyHtml, trackingBase, trackingParams: sortedParams(trackingParams) };
  return { payload, checksum: crypto.createHash('sha256').update(canonical(payload)).digest('hex') };
}

function sortedParams(params) {
  return Object.fromEntries(Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}
