<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../lib/api.js';

const campaigns = ref([]);
const audiences = ref([]);
const versions = ref([]);
const batches = ref([]);
const detail = ref(null);
const diff = ref(null);
const form = ref({ campaignId: 1, templateVersionId: null, audienceId: null, groupId: null });
const errorMsg = ref('');
let timer = null;

const badgeClass = (s) => ({
  pending: 'pending', prepared: 'prepared', attempted: 'attempted',
  confirmed: 'confirmed', suppressed: 'suppressed', failed: 'failed',
}[s] || 'pending');
const statusLabel = {
  pending: '待处理', prepared: '已准备', attempted: '已尝试投递',
  confirmed: '已确认回执', suppressed: '已抑制（退订）', failed: '失败',
};

async function loadBase() {
  campaigns.value = await api.get('/api/campaigns');
  audiences.value = await api.get('/api/audiences');
  await loadVersions();
}
async function loadVersions() {
  const c = await api.get(`/api/campaigns/${form.value.campaignId}`);
  versions.value = c.versions;
  form.value.templateVersionId = versions.value[0]?.id || null;
  if (!form.value.audienceId) form.value.audienceId = audiences.value[0]?.id || null;
}
async function loadBatches() {
  const list = await api.get('/api/batches');
  batches.value = list;
  if (detail.value) await openBatch(detail.value.batch.id);
}
async function createBatch() {
  errorMsg.value = '';
  try {
    await api.post('/api/batches', { ...form.value });
    await loadBatches();
  } catch (e) {
    errorMsg.value = `${e.data?.message || e.message}（HTTP ${e.status}）`;
  }
}
async function makeReady(b) {
  await api.post(`/api/batches/${b.id}/ready`);
  diff.value = null;
  await loadBatches();
}
async function checkDiff(b) {
  try { diff.value = await api.get(`/api/batches/${b.id}/diff`); }
  catch (e) { diff.value = { error: e.message }; }
}
async function send(b) {
  await api.post(`/api/batches/${b.id}/send`);
  await openBatch(b);
  if (!timer) timer = setInterval(loadBatches, 500);
}
async function openBatch(b) {
  detail.value = await api.get(`/api/batches/${b.id}`);
}
function stopTimerIfDone() {
  const s = detail.value?.batch.status;
  if (s && s.startsWith('done')) { clearInterval(timer); timer = null; }
}
onMounted(async () => {
  await loadBase();
  await loadBatches();
  setInterval(stopTimerIfDone, 600);
});
</script>

<template>
  <div class="panel">
    <strong>创建候选发送批（固定模板发布版 + 受众版本 + 分组授权）</strong>
    <div v-if="errorMsg" class="err" style="margin:6px 0">⛔ {{ errorMsg }}</div>
    <div class="row" style="margin-top:8px">
      <div style="flex:1"><label>活动</label>
        <select v-model.number="form.campaignId" @change="loadVersions">
          <option v-for="c in campaigns" :key="c.id" :value="c.id">#{{ c.id }} {{ c.name }}</option>
        </select>
      </div>
      <div style="flex:1"><label>模板发布版（冻结）</label>
        <select v-model.number="form.templateVersionId">
          <option v-for="v in versions" :key="v.id" :value="v.id">v{{ v.version }}</option>
        </select>
      </div>
      <div style="flex:1"><label>受众版本（不可变）</label>
        <select v-model.number="form.audienceId">
          <option v-for="a in audiences" :key="a.id" :value="a.id">{{ a.name }} v{{ a.version }}</option>
        </select>
      </div>
      <div style="flex:1"><label>分组（不选=无分组）</label>
        <select v-model.number="form.groupId">
          <option :value="null">（无）</option>
          <option :value="1">growth（组 id 1）</option>
          <option :value="2">billing（组 id 2，Alice 越权测试）</option>
        </select>
      </div>
      <div style="align-self:flex-end"><button class="btn" @click="createBatch">建候选批</button></div>
    </div>
  </div>

  <div class="panel">
    <table>
      <tr><th>ID</th><th>活动</th><th>状态</th><th>操作</th></tr>
      <tr v-for="b in batches" :key="b.id">
        <td>{{ b.id }} <span class="small">{{ b.token }}</span></td>
        <td>{{ b.campaign_name }}</td>
        <td><span class="badge" :class="b.status">{{ b.status }}</span></td>
        <td class="row">
          <button class="btn secondary" @click="openBatch(b)">详情</button>
          <button class="btn secondary" :disabled="b.status!=='candidate'" @click="makeReady(b)">生成整批快照并就绪</button>
          <button class="btn secondary" :disabled="b.status==='candidate'" @click="checkDiff(b)">对比快照</button>
          <button class="btn" :disabled="!['ready','sending'].includes(b.status)" @click="send(b)">开始发送/重试</button>
        </td>
      </tr>
    </table>
    <div v-if="diff" class="small" style="margin-top:8px">
      <template v-if="diff.error">快照对比失败：{{ diff.error }}</template>
      <template v-else>
        快照{{ diff.same ? '一致' : '已变化' }}；
        <span v-if="!diff.changed.length">无订阅状态漂移</span>
        <span v-for="(c,i) in diff.changed" :key="i" class="warn-c">
          {{ c.email }}: {{ c.from }}→{{ c.to }}；
        </span>
      </template>
    </div>
  </div>

  <div v-if="detail" class="panel">
    <strong>批次 #{{ detail.batch.id }} 收件人状态（领取任务时逐人复查订阅状态）</strong>
    <div class="row" style="margin:8px 0;gap:16px">
      <span class="small">三态可观察：<span class="badge prepared">已准备</span> <span class="badge attempted">已尝试投递</span> <span class="badge confirmed">已确认回执</span></span>
      <span class="small">汇总：{{ detail.counts }}</span>
    </div>
    <table>
      <tr><th>#</th><th>邮箱</th><th>状态</th><th>尝试</th><th>message-id（幂等）</th><th>回执/错误</th></tr>
      <tr v-for="r in detail.recipients" :key="r.id">
        <td>{{ r.id }}</td><td>{{ r.email }}</td>
        <td><span class="badge" :class="badgeClass(r.status)">{{ statusLabel[r.status] }}</span></td>
        <td>{{ r.attempts }}</td>
        <td class="small">{{ r.message_id }}</td>
        <td class="small">{{ r.smtp_response || r.error || '' }}</td>
      </tr>
    </table>
  </div>
</template>
