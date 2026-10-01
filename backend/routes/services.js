import crypto from 'node:crypto';
import { audienceSnapshot, canonical, publishPayload } from '../sender/snapshot.js';
import { signToken, hashToken, verifyToken } from '../security/tokens.js';

export function authorizeGroup(tx, actorGroupId, resourceGroupId, relation = 'same') {
  const actor = tx.get('groups', actorGroupId);
  if (!actor) throw Object.assign(new Error('unknown acting group'), { status: 401 });
  if (actorGroupId === resourceGroupId) return actor;
  const allowed = JSON.parse(actor.allowed_group_ids || '[]');
  if (relation === 'read' || relation === 'write') {
    if (!allowed.includes(resourceGroupId)) throw Object.assign(new Error('group is not authorized for this resource'), { status: 403 });
    return actor;
  }
  throw Object.assign(new Error('group is not authorized for this resource'), { status: 403 });
}

export async function publishCampaignVersion(tx, renderer, campaignId, patch) {
  const required = ['subject', 'previewText', 'bodyHtml'];
  for (const field of required) {
    if (!String(patch[field] ?? '').trim()) throw Object.assign(new Error(`${field} required`), { status: 400 });
  }
  const trackingParams = patch.trackingParams ?? {};
  const validation = await renderer.validate({
    subject: patch.subject,
    previewText: patch.previewText,
    bodyHtml: patch.bodyHtml,
    trackingParams,
  });
  if (!validation.ok) throw Object.assign(new Error('template validation failed'), { status: 422, details: validation });
  const previous = tx.all('campaign_versions', (v) => v.campaign_id === campaignId).length;
  const { payload, checksum } = publishPayload({
    subject: patch.subject,
    previewText: patch.previewText,
    bodyHtml: patch.bodyHtml,
    trackingBase: patch.trackingBase ?? process.env.PUBLIC_BASE_URL ?? 'https://example.com',
    trackingParams,
  });
  const version = tx.insert('campaign_versions', {
    campaign_id: campaignId,
    version: previous + 1,
    subject: payload.subject,
    preview_text: payload.previewText,
    body_html: payload.bodyHtml,
    tracking_base: payload.trackingBase,
    tracking_params: JSON.stringify(payload.trackingParams),
    canonical_payload: canonical(payload),
    validation_report: JSON.stringify(validation),
  });
  version.checksum = checksum;
  tx.update('campaigns', campaignId, { current_publish_version_id: version.id });
  return { version, validation, checksum };
}

export async function createBatch(tx, renderer, { campaignId, audienceVersionId }) {
  const campaign = tx.get('campaigns', campaignId);
  if (!campaign) throw Object.assign(new Error('campaign not found'), { status: 404 });
  const audienceVersion = tx.get('audience_versions', audienceVersionId);
  if (!audienceVersion) throw Object.assign(new Error('audience version not found'), { status: 404 });
  const actor = tx.get('groups', campaign.owner_group_id);
  authorizeGroup(tx, actor.id, audienceVersion.group_id, 'write');
  const versionId = campaign.current_publish_version_id;
  const version = tx.get('campaign_versions', versionId);
  if (!version) throw Object.assign(new Error('campaign has no published version'), { status: 422 });
  const validation = await renderer.validate({
    subject: version.subject,
    previewText: version.preview_text,
    bodyHtml: version.body_html,
    trackingParams: JSON.parse(version.tracking_params),
  });
  if (!validation.ok) {
    throw Object.assign(new Error('batch candidate failed template validation'), { status: 422, details: validation });
  }

  const snapshot = JSON.parse(audienceVersion.snapshot);
  const batch = tx.insert('send_batches', {
    campaign_id: campaignId,
    campaign_version_id: version.id,
    audience_version_id: audienceVersionId,
    status: 'candidate',
    snapshot_checksum: audienceVersion.checksum,
    total: snapshot.length,
  });
  for (const row of snapshot) {
    const token = signToken({
      task_batch: batch.id,
      member: row.member_id,
      email: row.email,
      nonce: crypto.randomUUID(),
    });
    tx.insert('unsubscribe_records', {
      email: row.email,
      audience_version_id: audienceVersionId,
      recipient_member_id: row.member_id,
      token_hash: hashToken(token),
      confirmed_at: null,
      source: 'batch-candidate',
    });
    tx.insert('recipient_tasks', {
      batch_id: batch.id,
      recipient_member_id: row.member_id,
      email_override_at_snapshot: row.email,
      name_override_at_snapshot: row.name,
      personalization_snapshot: {
        name: row.name,
        email: row.email,
        unsubscribe_token: token,
      },
      subscribed_at_snapshot: true,
      status: 'prepared',
      attempts: 0,
      next_attempt_after: null,
      message_id: null,
    });
  }
  tx.update('send_batches', batch.id, { status: 'ready', prepared_at: new Date().toISOString() });
  return tx.get('send_batches', batch.id);
}

export function createAudienceVersion(tx, groupId) {
  const members = tx.all('audience_members', (m) => m.group_id === groupId);
  const { rows, checksum } = audienceSnapshot(members);
  const count = tx.all('audience_versions', (v) => v.group_id === groupId).length;
  return tx.insert('audience_versions', {
    group_id: groupId,
    version: count + 1,
    member_count: rows.length,
    checksum,
    snapshot: JSON.stringify(rows),
  });
}

export function confirmUnsubscribe(tx, token) {
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw Object.assign(new Error('invalid unsubscribe token'), { status: 400 });
  }
  const record = tx.find('unsubscribe_records', (r) =>
    r.recipient_member_id === payload.member && r.email.toLowerCase() === payload.email.toLowerCase() && r.token_hash === hashToken(token));
  if (!record) throw Object.assign(new Error('unsubscribe record not found'), { status: 404 });
  if (!record.confirmed_at) tx.update('unsubscribe_records', record.id, { confirmed_at: new Date().toISOString(), source: 'recipient-confirm' });
  const member = tx.get('audience_members', payload.member);
  if (member) tx.update('audience_members', member.id, { subscribed: false, unsubscribed_at: new Date().toISOString() });
  return { ok: true, email: payload.email };
}

