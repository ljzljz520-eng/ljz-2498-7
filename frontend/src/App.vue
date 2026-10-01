<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Campaign workbench</p>
        <h1>邮件活动编辑台</h1>
      </div>
      <label>
        当前分组
        <select v-model="groupId">
          <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
        </select>
      </label>
    </header>

    <section class="grid two">
      <TemplateEditor v-model="template" :report="report" @validate="validateTemplate" />
      <PreviewPane :html="previewHtml" :report="report" />
    </section>

    <section class="grid three">
      <ClientCapability :report="report" />
      <ValidationPanel :report="report" />
      <DeliveryPanel
        :groups="groups"
        :group-id="groupId"
        :campaign="campaign"
        :publish="publishVersion"
        :audience-version="audienceVersion"
        :batch="batch"
        :error="error"
        @seed="seed"
        @new-audience="newAudience"
        @new-campaign="newCampaign"
        @create-batch="createBatch"
        @process="processBatch"
      />
    </section>

    <BatchStatus :batch="batch" />
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import TemplateEditor from './components/TemplateEditor.vue';
import PreviewPane from './components/PreviewPane.vue';
import ClientCapability from './components/ClientCapability.vue';
import ValidationPanel from './components/ValidationPanel.vue';
import DeliveryPanel from './components/DeliveryPanel.vue';
import BatchStatus from './components/BatchStatus.vue';
import { api } from './lib/api.js';

const groups = ref([]);
const groupId = ref('');
const campaign = ref(null);
const audienceVersion = ref(null);
const batch = ref(null);
const report = ref({ ok: false, errors: [], warnings: [], darkMode: {}, clientCapabilities: [] });
const error = ref('');
const template = reactive({
  subject: 'Hi {{name}}, your weekly update',
  previewText: '{{name}}, three account items deserve attention',
  bodyHtml: `<html><head><style>@media (prefers-color-scheme: dark){.card{background:#111827!important;color:#f9fafb!important;}}</style></head><body style="background:#ffffff;color:#111827;"><div class="card" style="background:#ffffff;color:#111827;padding:24px;"><h1 style="color:#111827;background:#ffffff;">Hello {{name}}</h1><p style="color:#111827;background:#ffffff;">Your dashboard is ready.</p><p style="color:#111827;background:#ffffff;"><a href="https://example.com/dashboard">Open dashboard</a></p><p style="color:#111827;background:#ffffff;"><a rel="unsubscribe" data-no-shortlink="true" data-unsubscribe="true" href="https://example.com/unsubscribe?unsubscribe_token={{unsubscribe_token}}">Unsubscribe</a></p></div></body></html>`,
  trackingParams: { campaign: 'weekly', source: 'email' },
});

const previewHtml = computed(() => template.bodyHtml
  .replaceAll('{{name}}', 'Ada')
  .replaceAll('{{unsubscribe_token}}', 'preview-token'));
onMounted(async () => {
  groups.value = await api('/api/groups');
  groupId.value = groups.value[0]?.id;
  await validateTemplate();
});

async function validateTemplate() {
  error.value = '';
  try {
    report.value = await api('/api/templates/validate', { method: 'POST', body: { template: template } });
  } catch (result) {
    report.value = result.details ? result.details : { ok: false, errors: [{ message: result.error || 'validation failed' }], warnings: [] };
  }
}

async function seed() {
  const result = await api('/api/seed', { method: 'POST', groupId: groupId.value, body: { name: 'Ada', email: 'ada@example.test' } });
  audienceVersion.value = result.version;
  error.value = '';
}

async function newAudience() {
  audienceVersion.value = await api(`/api/groups/${groupId.value}/audience-versions`, { method: 'POST', groupId: groupId.value, body: {} });
}

async function newCampaign() {
  campaign.value = await api('/api/campaigns', { method: 'POST', groupId: groupId.value, body: { name: 'Weekly update', ownerGroupId: groupId.value } });
}

async function publishVersion() {
  await newCampaign();
  await api(`/api/campaigns/${campaign.value.id}/publish`, { method: 'POST', groupId: groupId.value, body: template });
  error.value = '';
}

async function createBatch() {
  await publishVersion();
  if (!audienceVersion.value) await seed();
  batch.value = await api('/api/batches', { method: 'POST', groupId: groupId.value, body: { campaignId: campaign.value.id, audienceVersionId: audienceVersion.value.id } });
}

async function processBatch() {
  await api('/api/batches/process?limit=20', { method: 'POST', groupId: groupId.value });
  batch.value = await api(`/api/batches/${batch.value.id}`, { groupId: groupId.value });
}
</script>
