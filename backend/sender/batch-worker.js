import { sendMail } from '../mail/smtp-client.js';
import { buildMimeMessage } from '../mail/mime.js';
import { stableMessageId } from '../security/tokens.js';
import { audienceSnapshot } from './snapshot.js';
import { logger } from '../security/redact.js';

const RETRY_BASE_MS = 50;

export class BatchWorker {
  constructor(db, renderer, options = {}) {
    this.db = db;
    this.renderer = renderer;
    this.from = options.from ?? process.env.MAIL_FROM ?? 'editor@campaign.local';
    this.maxAttempts = options.maxAttempts ?? Number(process.env.SEND_MAX_ATTEMPTS ?? 5);
    this.beforeSend = options.beforeSend ?? null;
    this.afterClaim = options.afterClaim ?? null;
    this.clock = options.clock ?? (() => Date.now());
  }

  async processDueTasks({ limit = 10, taskId = null, now = new Date().toISOString() } = {}) {
    const batchReport = await this.reconcileOpenBatches();
    const task = await this.db.transaction(async (tx) => {
      let due = tx.all('recipient_tasks', (row) =>
        ['prepared', 'attempted_delivery', 'retryable'].includes(row.status) &&
        (!row.next_attempt_after || row.next_attempt_after <= now) &&
        row.attempts < this.maxAttempts,
      ).sort((a, b) => String(a.next_attempt_after ?? a.created_at).localeCompare(String(b.next_attempt_after ?? b.created_at)));
      if (taskId) due = due.filter((row) => row.id === taskId);
      const selected = due.slice(0, limit);
      return selected.map((row) => {
        const member = tx.get('audience_members', row.recipient_member_id);
        const liveSubscription = this.readLiveState(tx, row, member);
        if (!liveSubscription.subscribed) {
          return tx.update('recipient_tasks', row.id, {
            status: row.attempts > 0 ? 'skipped_after_attempt' : 'skipped_unsubscribed',
            last_error_code: 'UNSUBSCRIBED_AT_CLAIM',
            last_error_message: 'subscription recheck failed at task claim',
          });
        }
        const attempts = row.attempts + 1;
        return tx.update('recipient_tasks', row.id, {
          status: 'attempted_delivery',
          attempts,
          claimed_at: row.claimed_at ?? now,
          last_attempt_at: now,
          next_attempt_after: null,
        });
      });
    });
    if (this.afterClaim) await this.afterClaim(task);

    const results = [];
    for (const claimed of task) {
      results.push(await this.deliverOne(claimed.id));
    }
    await this.refreshBatchStatuses();
    return { batchReport, results };
  }

  readLiveState(tx, task, member) {
    if (!member || member.deleted_at) return { subscribed: false, reason: 'MEMBER_MISSING' };
    const record = tx.find('unsubscribe_records', (r) =>
      (r.recipient_member_id === member.id || r.email.toLowerCase() === member.email.toLowerCase()) && r.confirmed_at);
    return {
      subscribed: member.subscribed && !record,
      member,
      record,
      reason: record ? 'CONFIRMED_UNSUBSCRIBE' : member.subscribed ? 'OK' : 'NOT_SUBSCRIBED',
    };
  }

  async reconcileOpenBatches() {
    return await this.db.transaction((tx) => {
      const report = [];
      const batches = tx.all('send_batches', (b) => ['ready', 'sending', 'retrying'].includes(b.status));
      for (const batch of batches) {
        const version = tx.get('audience_versions', batch.audience_version_id);
        const members = tx.all('audience_members', (m) => m.group_id === version.group_id);
        const live = audienceSnapshot(members);
        const tasks = tx.all('recipient_tasks', (t) => t.batch_id === batch.id);
        const drift = live.checksum === batch.snapshot_checksum
          ? 0
          : Math.abs(live.rows.length - tasks.filter((t) => t.status !== 'skipped_unsubscribed' && t.status !== 'skipped_after_attempt').length);
        if (batch.status === 'ready' && tasks.some((t) => t.status !== 'prepared')) tx.update('send_batches', batch.id, { status: 'sending' });
        report.push({ batch_id: batch.id, snapshot_checksum_matches: live.checksum === version.checksum, live_eligible: live.rows.length, drift });
      }
      return report;
    });
  }

  async deliverOne(taskId) {
    const data = await this.db.read((tx) => {
      const task = tx.get('recipient_tasks', taskId);
      const batch = tx.get('send_batches', task.batch_id);
      const version = tx.get('campaign_versions', batch.campaign_version_id);
      const member = tx.get('audience_members', task.recipient_member_id);
      return { task, batch, version, member };
    });

    const preSend = await this.db.transaction((tx) => {
      const task = tx.get('recipient_tasks', taskId);
      const member = tx.get('audience_members', task.recipient_member_id);
      const live = this.readLiveState(tx, task, member);
      if (!live.subscribed) {
        return {
          skipped: tx.update('recipient_tasks', taskId, {
            status: 'skipped_after_claim',
            last_error_code: live.reason,
            last_error_message: 'subscription recheck failed immediately before send',
          }),
        };
      }
      return { ok: tx.update('send_batches', task.batch_id, { status: 'sending' }) };
    });
    if (preSend.skipped) {
      logger.warn('recipient skipped after live subscription recheck', { task_id: taskId, batch_id: data.task.batch_id });
      return { taskId, status: 'skipped_after_claim' };
    }

    if (this.beforeSend) await this.beforeSend(data);

    let rendered;
    try {
      rendered = await this.renderer.render({
        subject: data.version.subject,
        previewText: data.version.preview_text,
        bodyHtml: data.version.body_html,
        trackingParams: JSON.parse(data.version.tracking_params || '{}'),
      }, data.task.personalization_snapshot);
    } catch (error) {
      return await this.recordFailure(taskId, error, { rendererCrashed: error.code === 'RENDERER_CRASH' });
    }

    const messageId = data.task.message_id || stableMessageId(data.task.batch_id, taskId);
    const raw = buildMimeMessage({
      from: this.from,
      to: data.task.email_override_at_snapshot,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      messageId,
      headers: {
        'X-Campaign-Version': data.batch.campaign_version_id,
        'X-Audience-Version': data.batch.audience_version_id,
        ...(process.env.SMTP_SIMULATE_RESPONSE_LOST === 'first' && data.task.attempts === 1
          ? { 'X-Sim-Fail': 'response-lost' }
          : {}),
      },
    });

    try {
      const receipt = await sendMail({ from: this.from, to: data.task.email_override_at_snapshot, raw });
      return await this.db.transaction(async (tx) => {
        tx.update('recipient_tasks', taskId, {
          status: 'confirmed_receipt',
          message_id: messageId,
          smtp_response: receipt.response,
          confirmed_at: new Date(this.clock()).toISOString(),
          next_attempt_after: null,
          last_error_code: null,
          last_error_message: null,
        });
        tx.insert('delivery_attempts', {
          task_id: taskId,
          attempt_number: data.task.attempts,
          stage: 'final-response',
          result: 'confirmed',
          message_id: messageId,
          server_response: receipt.response,
          finished_at: new Date(this.clock()).toISOString(),
        });
        return { taskId, status: 'confirmed_receipt' };
      });
    } catch (error) {
      return await this.recordFailure(taskId, error, { messageId });
    }
  }

  async recordFailure(taskId, error, context = {}) {
    const retryable = ['SMTP_TRANSIENT', 'TRANSPORT_ERROR', 'TRANSPORT_TIMEOUT', 'RESPONSE_LOST', 'RENDERER_CRASH', 'RENDERER_TIMEOUT'].includes(error.code);
    const now = this.clock();
    return await this.db.transaction(async (tx) => {
      const task = tx.get('recipient_tasks', taskId);
      const attempts = task.attempts;
      const hasRetry = retryable && attempts < this.maxAttempts;
      tx.update('recipient_tasks', taskId, {
        status: hasRetry ? 'attempted_delivery' : retryable ? 'failed_retry_exhausted' : 'failed_permanent',
        message_id: context.messageId ?? task.message_id,
        last_error_code: error.code,
        last_error_message: retryable ? 'temporary delivery or render failure' : error.message,
        next_attempt_after: hasRetry ? new Date(now + RETRY_BASE_MS * 2 ** (attempts - 1)).toISOString() : null,
      });
      if (hasRetry) tx.update('send_batches', task.batch_id, { status: 'retrying', last_error: error.code });
      tx.insert('delivery_attempts', {
        task_id: taskId,
        attempt_number: attempts,
        stage: context.rendererCrashed ? 'renderer' : 'smtp',
        result: retryable ? 'retryable_error' : 'permanent_error',
        message_id: context.messageId ?? task.message_id,
        error_code: error.code,
        server_response: null,
        finished_at: new Date(now).toISOString(),
      });
      logger.warn('delivery attempt finished without receipt', {
        task_id: taskId,
        batch_id: task.batch_id,
        attempt: attempts,
        error_code: error.code,
      });
      return { taskId, status: retryable ? 'attempted_delivery' : 'failed_permanent', retryable };
    });
  }

  async refreshBatchStatuses() {
    await this.db.transaction((tx) => {
      const batches = tx.all('send_batches', (b) => ['ready', 'sending', 'retrying'].includes(b.status));
      for (const batch of batches) {
        const tasks = tx.all('recipient_tasks', (t) => t.batch_id === batch.id);
        const terminal = tasks.every((t) => ['confirmed_receipt', 'skipped_unsubscribed', 'skipped_after_claim', 'skipped_after_attempt', 'failed_permanent', 'failed_retry_exhausted'].includes(t.status));
        if (!terminal) continue;
        const status = tasks.some((t) => t.status === 'confirmed_receipt')
          ? tasks.every((t) => t.status === 'confirmed_receipt') ? 'completed' : 'completed_with_skips_or_failures'
          : tasks.some((t) => String(t.status).startsWith('failed')) ? 'failed' : 'cancelled_unsubscribed';
        const now = new Date(this.clock()).toISOString();
        tx.update('send_batches', batch.id, {
          status,
          confirmed_at: tasks.every((t) => t.status === 'confirmed_receipt') ? now : batch.confirmed_at,
        });
      }
    });
  }
}
