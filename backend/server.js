import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { getDatabase } from './db/create.js';
import { RendererPool } from './renderer/render-pool.js';
import { authorizeGroup, confirmUnsubscribe, createAudienceVersion, createBatch, publishCampaignVersion } from './routes/services.js';
import { BatchWorker } from './sender/batch-worker.js';
import { audienceSnapshot } from './sender/snapshot.js';
import { logger } from './security/redact.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function publicBatch(tx, batch) {
  const tasks = tx.all('recipient_tasks', (t) => t.batch_id === batch.id).map((task) => ({
    id: task.id,
    status: task.status,
    attempts: task.attempts,
    recipient_member_id: task.recipient_member_id,
    email_override_at_snapshot: task.email_override_at_snapshot,
    next_attempt_after: task.next_attempt_after,
    confirmed_at: task.confirmed_at,
    message_id: task.message_id,
    last_error_code: task.last_error_code,
  }));
  const counts = tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  return { ...batch, campaign_version_id: batch.campaign_version_id, tasks, counts };
}

function safePathForLog(parts) {
  if (parts[0] === 'unsubscribe') return '/unsubscribe/[redacted-token]';
  return `/${parts.slice(0, 3).join('/')}`;
}

export async function createServer({ db = getDatabase(), renderer = new RendererPool(), worker } = {}) {
  await db.load();
  const batchWorker = worker ?? new BatchWorker(db, renderer);

  await db.transaction((tx) => {
    if (!tx.find('groups', (g) => g.name === 'designers')) {
      const designers = tx.insert('groups', { name: 'designers', allowed_group_ids: JSON.stringify([]) });
      const readers = tx.insert('groups', { name: 'analytics-readers', allowed_group_ids: JSON.stringify([]) });
      tx.update('groups', designers.id, { allowed_group_ids: JSON.stringify([readers.id]) });
    }
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      res.setHeader('access-control-allow-headers', 'content-type,x-group-id');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-origin', '*');
      if (req.method === 'OPTIONS') return json(res, 204, {});
      const actorGroupId = req.headers['x-group-id'];

      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

      if (req.method === 'GET' && url.pathname === '/api/groups') {
        return await db.read((tx) => json(res, 200, tx.all('groups')));
      }

      if (req.method === 'POST' && url.pathname === '/api/seed') {
        const body = await readJson(req);
        const seeded = await db.transaction((tx) => {
          const owner = body.ownerGroupId ? tx.get('groups', body.ownerGroupId) : tx.find('groups', (g) => g.name === 'designers');
          if (!owner) throw Object.assign(new Error('owner group missing'), { status: 400 });
          const member = tx.insert('audience_members', {
            group_id: owner.id,
            email: body.email ?? `member-${randomUUID().slice(0, 8)}@example.test`,
            name: body.name ?? 'Test Member',
            subscribed: true,
            subscribed_at: new Date().toISOString(),
            unsubscribed_at: null,
            version: 1,
          });
          return { member, version: createAudienceVersion(tx, owner.id) };
        });
        return json(res, 201, seeded);
      }

      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'groups' && parts[3] === 'members') {
        const body = await readJson(req);
        const result = await db.transaction((tx) => {
          authorizeGroup(tx, actorGroupId, parts[2], 'write');
          return tx.insert('audience_members', {
            group_id: parts[2],
            email: body.email,
            name: body.name ?? '',
            subscribed: body.subscribed !== false,
            subscribed_at: new Date().toISOString(),
            unsubscribed_at: null,
            version: body.version ?? 1,
          });
        });
        return json(res, 201, result);
      }

      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'groups' && parts[3] === 'audience-versions') {
        const body = await readJson(req);
        const result = await db.transaction((tx) => {
          authorizeGroup(tx, actorGroupId ?? body.actorGroupId, parts[2], 'write');
          return createAudienceVersion(tx, parts[2]);
        });
        return json(res, 201, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/campaigns') {
        const body = await readJson(req);
        const result = await db.transaction((tx) => {
          authorizeGroup(tx, actorGroupId, body.ownerGroupId, 'write');
          return tx.insert('campaigns', { name: body.name, owner_group_id: body.ownerGroupId, current_publish_version_id: null });
        });
        return json(res, 201, result);
      }

      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'campaigns' && parts[3] === 'versions') {
        const result = await db.read((tx) => {
          const campaign = tx.get('campaigns', parts[2]);
          if (!campaign) throw Object.assign(new Error('not found'), { status: 404 });
          if (actorGroupId) authorizeGroup(tx, actorGroupId, campaign.owner_group_id, 'read');
          return tx.all('campaign_versions', (v) => v.campaign_id === campaign.id);
        });
        return json(res, 200, result);
      }

      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'campaigns' && parts[3] === 'publish') {
        const body = await readJson(req);
        const result = await db.transaction(async (tx) => {
          const campaign = tx.get('campaigns', parts[2]);
          if (!campaign) throw Object.assign(new Error('not found'), { status: 404 });
          authorizeGroup(tx, actorGroupId, campaign.owner_group_id, 'write');
          return await publishCampaignVersion(tx, renderer, campaign.id, body);
        });
        return json(res, 201, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/templates/validate') {
        const body = await readJson(req);
        const result = await renderer.validate(body.template ?? body);
        return json(res, result.ok ? 200 : 422, result);
      }

      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'batches' && parts[2] === 'process') {
        const result = await batchWorker.processDueTasks({
          limit: Number(url.searchParams.get('limit') ?? 20),
          taskId: url.searchParams.get('taskId'),
        });
        return json(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/batches') {
        const body = await readJson(req);
        const batch = await db.transaction(async (tx) => {
          const campaign = tx.get('campaigns', body.campaignId);
          if (!campaign) throw Object.assign(new Error('campaign not found'), { status: 404 });
          if (actorGroupId) authorizeGroup(tx, actorGroupId, campaign.owner_group_id, 'write');
          return await createBatch(tx, renderer, body);
        });
        return json(res, 201, await db.read((tx) => publicBatch(tx, batch)));
      }

      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'batches') {
        const result = await db.read((tx) => {
          let rows = tx.all('send_batches');
          if (parts[2]) rows = rows.filter((b) => b.id === parts[2]);
          return rows.map((batch) => {
            if (actorGroupId) {
              const campaign = tx.get('campaigns', batch.campaign_id);
              if (campaign) authorizeGroup(tx, actorGroupId, campaign.owner_group_id, 'read');
            }
            return publicBatch(tx, batch);
          });
        });
        if (parts[2] && !result.length) return json(res, 404, { error: 'not found' });
        return json(res, 200, parts[2] ? result[0] : result);
      }

      if (req.method === 'POST' && parts[0] === 'unsubscribe') {
        const result = await db.transaction((tx) => confirmUnsubscribe(tx, decodeURIComponent(parts[1] ?? '')));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<h1>${result.ok ? 'Unsubscribed' : 'Error'}</h1><p>Confirmation recorded.</p>`);
      }

      if (req.method === 'GET' && parts[0] === 'unsubscribe') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<form method="post" action="/unsubscribe/${encodeURIComponent(parts[1] ?? '')}"><button>Confirm unsubscribe</button></form>`);
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      logger.error('request failed', { path: safePathForLog(parts), error_code: error.code || error.status || 'ERROR' });
      json(res, error.status || (error.code === 'TEMPLATE_INVALID' ? 422 : 500), {
        error: error.message,
        code: error.code,
        details: error.details,
        batchId: error.batchId,
      });
    }
  });

  await new Promise((resolve) => server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', resolve));
  return { server, db, renderer, worker: batchWorker };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const instance = await createServer();
  logger.info('api listening', { port: instance.server.address().port });
  if (process.env.SEND_LOOP === '1') {
    setInterval(() => instance.worker.processDueTasks().catch((error) => logger.error('worker loop failed', { error_code: error.code })), 250);
  }
}
