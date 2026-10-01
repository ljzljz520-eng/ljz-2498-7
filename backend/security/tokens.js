import crypto from 'node:crypto';

const secret = () => process.env.CAMPAIGN_SECRET || 'dev-only-change-me';

export function hashToken(token) {
  return crypto.createHmac('sha256', secret()).update(token).digest('hex');
}

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  const [body, sig] = String(token).split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (!body || sig !== expected) throw Object.assign(new Error('invalid token'), { status: 400 });
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

export function stableMessageId(batchId, taskId) {
  return crypto.createHash('sha256').update(`${batchId}:${taskId}:${secret()}`).digest('hex').slice(0, 24) + '@campaign.local';
}
