export const schema = {
  groups: {
    fields: ['name', 'allowed_group_ids'],
  },
  audience_members: {
    fields: ['group_id', 'email', 'name', 'subscribed', 'subscribed_at', 'unsubscribed_at', 'version', 'deleted_at'],
    foreignKeys: [{ table: 'groups', from: 'group_id' }],
  },
  audience_versions: {
    fields: ['group_id', 'version', 'member_count', 'checksum', 'snapshot'],
    foreignKeys: [{ table: 'groups', from: 'group_id' }],
  },
  campaigns: {
    fields: ['name', 'owner_group_id', 'current_publish_version_id'],
    foreignKeys: [{ table: 'groups', from: 'owner_group_id' }],
  },
  campaign_versions: {
    fields: [
      'campaign_id', 'version', 'subject', 'preview_text', 'body_html',
      'tracking_base', 'tracking_params', 'canonical_payload', 'validation_report'
    ],
    foreignKeys: [{ table: 'campaigns', from: 'campaign_id' }],
  },
  unsubscribe_records: {
    fields: ['email', 'audience_version_id', 'recipient_member_id', 'token_hash', 'confirmed_at', 'source'],
  },
  send_batches: {
    fields: [
      'campaign_id', 'campaign_version_id', 'audience_version_id', 'status',
      'snapshot_checksum', 'total', 'prepared_at', 'attempted_at', 'confirmed_at', 'last_error'
    ],
  },
  recipient_tasks: {
    fields: [
      'batch_id', 'recipient_member_id', 'email_override_at_snapshot', 'name_override_at_snapshot',
      'personalization_snapshot', 'subscribed_at_snapshot', 'status', 'attempts',
      'claimed_at', 'next_attempt_after', 'last_attempt_at', 'confirmed_at',
      'message_id', 'smtp_response', 'last_error_code', 'last_error_message', 'retry_token'
    ],
  },
  delivery_attempts: {
    fields: [
      'task_id', 'attempt_number', 'stage', 'result', 'message_id',
      'server_response', 'error_code', 'attempted_at', 'finished_at'
    ],
  },
};
