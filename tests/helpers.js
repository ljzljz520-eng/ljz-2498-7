import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../backend/server.js';
import { RendererPool } from '../backend/renderer/render-pool.js';
import { BatchWorker } from '../backend/sender/batch-worker.js';
import { startSmtpSimulator } from '../backend/mail/smtp-simulator.js';
import { RelationalDatabase } from '../backend/db/relational.js';
import { schema } from '../backend/db/schema.js';

export function validTemplate(overrides = {}) {
  return {
    subject: 'Hello {{name}}',
    previewText: '{{name}} has a secure update',
    bodyHtml: `<html><body style="background:#ffffff;color:#111827;">
      <div style="background:#ffffff;color:#111827;padding:16px;">
        <h1 style="background:#ffffff;color:#111827;">Hello {{name}}</h1>
        <p style="background:#ffffff;color:#111827;">Weekly news.</p>
        <p style="background:#ffffff;color:#111827;"><a href="https://example.com/news">Read news</a></p>
        <p style="background:#ffffff;color:#111827;"><a rel="unsubscribe" data-no-shortlink="true" data-unsubscribe="true" href="https://example.com/unsubscribe?unsubscribe_token={{unsubscribe_token}}">Unsubscribe</a></p>
      </div></body></html>`,
    trackingParams: { campaign: 'weekly-2026', source: 'email' },
    ...overrides,
  };
}

export async function startTestHarness({ worker } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'campaign-'));
  const dbFile = path.join(dir, 'db.json');
  const mail = await startSmtpSimulator({ port: 0 });
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(mail.port);
  const db = new RelationalDatabase(dbFile, schema);
  const renderer = new RendererPool({ timeoutMs: 3000 });
  const instance = await createServer({
    db,
    renderer,
    worker: worker ?? new BatchWorker(db, renderer, { maxAttempts: 4 }),
  });
  const port = instance.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    dir,
    db,
    dbFile,
    mail,
    renderer,
    worker: instance.worker,
    server: instance.server,
    base,
    async stop() {
      await new Promise((resolve) => instance.server.close(resolve));
      await renderer.stop();
      await mail.stop();
    },
  };
}

export async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  return { response, body };
}

export async function bootstrapCampaign(harness, template = validTemplate(), actorHeader = true) {
  const { body: groups } = await jsonFetch(`${harness.base}/api/groups`);
  const group = groups.find((g) => g.name === 'designers');
  const headers = actorHeader ? { 'x-group-id': group.id } : {};
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const seeded = await jsonFetch(`${harness.base}/api/seed`, {
    method: 'POST',
    headers,
    body: { email, name: 'Ada' },
  }).then((r) => r.body);
  const campaign = await jsonFetch(`${harness.base}/api/campaigns`, {
    method: 'POST',
    headers,
    body: { name: 'Weekly', ownerGroupId: group.id },
  }).then((r) => r.body);
  const published = await jsonFetch(`${harness.base}/api/campaigns/${campaign.id}/publish`, {
    method: 'POST',
    headers,
    body: template,
  }).then((r) => r.body);
  const batch = await jsonFetch(`${harness.base}/api/batches`, {
    method: 'POST',
    headers,
    body: { campaignId: campaign.id, audienceVersionId: seeded.version.id },
  }).then((r) => r.body);
  const recipientTask = batch.tasks.find((task) => task.recipient_member_id === seeded.member.id);
  return {
    group,
    audienceVersion: seeded.version,
    member: seeded.member,
    campaign,
    published: published.version,
    checksum: published.checksum,
    batch,
    recipientTask,
    headers,
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
