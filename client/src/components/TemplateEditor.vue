<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../lib/api.js';

const campaigns = ref([]);
const campaignId = ref(1);
const versions = ref([]);
const selectedVersion = ref(null);

// 固定到同一发布版的四要素
const subject = ref('十月新品，{{name}} 专属推荐');
const preheader = ref('仅限本期：{{city}} 用户专享优惠');
const bodyHtml = ref(
`<h1 style="color:#111111;">你好 {{name}}</h1>
<p style="color:#222222;background-color:#ffffff;">本期为 {{city}} 的用户准备了新品。</p>
<img class="images" src="https://example.test/hero.png" alt="新品图" width="1" height="1" />
<span class="media-note">（当前客户端不显示远程图片）</span>
<p style="color:#222222;"><a href="https://example.test/products">查看活动详情</a></p>
<p style="color:#222222;"><a data-no-rewrite href="{{{unsubscribe_url}}}">退订此类邮件</a></p>
<style>
@media (prefers-color-scheme: dark) {
  body { background-color:#121214; color:#e8eaed; }
}
</style>`);
const tracking = reactive({ utm_source: 'campaign_oct', utm_medium: 'email' });

const modules = ref([
  { id: 'h', label: '标题模块', on: true },
  { id: 'p', label: '正文模块', on: true },
  { id: 'img', label: '图片模块（高能力客户端）', on: true },
  { id: 'cta', label: '行动按钮/链接模块', on: true },
  { id: 'unsub', label: '退订模块（必选，受保护）', on: true, locked: true },
]);
function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= modules.value.length) return;
  [modules.value[i], modules.value[j]] = [modules.value[j], modules.value[i]];
}

const theme = ref('light'); // light | dark
const capability = ref('high'); // high | low（禁用图片/媒体查询模拟客户端差异）
const rendered = ref(null);
const checkResult = ref(null);
const publishing = ref(false);
const busy = ref(false);
const errorMsg = ref('');

const previewClass = computed(() =>
  `content ${theme.value === 'dark' ? 'dark' : 'light'} ${capability.value === 'low' ? 'cap-low' : 'cap-high'}`);

async function render() {
  busy.value = true; errorMsg.value = '';
  try {
    rendered.value = await api.post('/api/render', {
      subject: subject.value, preheader: preheader.value, bodyHtml: bodyHtml.value, tracking,
    });
  } catch (e) { errorMsg.value = e.message; }
  busy.value = false;
}
async function check(crash = false) {
  busy.value = true; checkResult.value = null;
  try {
    checkResult.value = await api.post('/api/check', {
      subject: subject.value, preheader: preheader.value, bodyHtml: bodyHtml.value, crash,
    });
  } catch (e) { errorMsg.value = e.message; }
  busy.value = false;
}
async function publish() {
  publishing.value = true; errorMsg.value = '';
  try {
    const r = await api.post(`/api/campaigns/${campaignId.value}/publish`, {
      subject: subject.value, preheader: preheader.value, bodyHtml: bodyHtml.value, tracking,
    });
    alert(`已冻结为发布版 v${r.version}`);
    await loadVersions();
  } catch (e) {
    checkResult.value = e.data?.check || null;
    errorMsg.value = e.data?.error || e.message;
  }
  publishing.value = false;
}
async function loadVersions() {
  const c = await api.get(`/api/campaigns/${campaignId.value}`);
  versions.value = c.versions;
}
async function loadVersion(v) {
  const t = await api.get(`/api/template-versions/${v.id}`);
  selectedVersion.value = t;
  subject.value = t.subject; preheader.value = t.preheader; bodyHtml.value = t.body_html;
  Object.assign(tracking, JSON.parse(t.tracking_json));
  await render();
}
onMounted(async () => {
  campaigns.value = await api.get('/api/campaigns');
  await loadVersions();
  await render();
});
</script>

<template>
  <div class="panel">
    <div class="row" style="justify-content:space-between">
      <strong>模块编辑器</strong>
      <div class="row">
        <label style="margin:0">活动</label>
        <select v-model.number="campaignId" @change="loadVersions()" style="width:auto">
          <option v-for="c in campaigns" :key="c.id" :value="c.id">#{{ c.id }} {{ c.name }}</option>
        </select>
        <button class="btn secondary" :disabled="busy" @click="render()">渲染预览</button>
        <button class="btn secondary" :disabled="busy" @click="check(false)">校验模板</button>
        <button class="btn secondary" :disabled="busy" @click="check(true)">校验（模拟渲染进程退出）</button>
        <button class="btn" :disabled="publishing" @click="publish()">发布冻结版本</button>
      </div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <div>
        <label>主题（与正文/预览/跟踪参数一起冻结）</label>
        <input v-model="subject" />
        <label>预览文案 preheader</label>
        <input v-model="preheader" />
        <label>正文 HTML（<span v-pre>{{name}}、{{city}} 自动上下文转义；{{{unsubscribe_url}}} 为系统可信变量</span>）</label>
        <textarea v-model="bodyHtml" style="min-height:240px;font-family:ui-monospace,monospace;font-size:12px"></textarea>
        <div class="row">
          <div style="flex:1"><label>utm_source</label><input v-model="tracking.utm_source" /></div>
          <div style="flex:1"><label>utm_medium</label><input v-model="tracking.utm_medium" /></div>
        </div>

        <label style="margin-top:12px">模块（退订模块锁定不可移除，链接受短链保护）</label>
        <div class="modules">
          <div v-for="(mod,i) in modules" :key="mod.id" class="module-card row">
            <span class="handle">⋮⋮</span>
            <input type="checkbox" :disabled="mod.locked" v-model="mod.on" style="width:auto" />
            <span style="flex:1">{{ mod.label }}</span>
            <button class="btn secondary" style="padding:2px 8px" @click="move(i,-1)">↑</button>
            <button class="btn secondary" style="padding:2px 8px" @click="move(i,1)">↓</button>
          </div>
        </div>

        <div v-if="checkResult" style="margin-top:12px">
          <strong :class="checkResult.ok ? 'ok-c' : 'err'">
            {{ checkResult.ok ? '校验通过' : '校验未通过（阻止发布）' }}
          </strong>
          <div v-for="(e,i) in checkResult.errors" :key="'e'+i" class="err">✗ {{ e.code }} — {{ e.message }}</div>
          <div v-for="(w,i) in checkResult.warnings" :key="'w'+i" class="warn-c">⚠ {{ w.code }} — {{ w.message }}</div>
          <div v-if="checkResult.pool" class="small" style="margin-top:6px">
            渲染池：启动 {{ checkResult.pool.started }}，崩溃 {{ checkResult.pool.crashes }}，自动重启 {{ checkResult.pool.restarts }}
          </div>
        </div>
        <div v-if="errorMsg" class="err" style="margin-top:8px">{{ errorMsg }}</div>
      </div>

      <div>
        <div class="row" style="justify-content:space-between">
          <strong>客户端预览</strong>
          <div class="row">
            <label style="margin:0">主题</label>
            <select v-model="theme" style="width:auto"><option value="light">浅色</option><option value="dark">深色</option></select>
            <label style="margin:0">能力</label>
            <select v-model="capability" style="width:auto">
              <option value="high">高能力（图片/媒体查询）</option>
              <option value="low">低能力（无图片/忽略 @media）</option>
            </select>
          </div>
        </div>
        <div class="preview-frame" :class="theme" style="margin-top:10px">
          <div class="chrome">
            <span>主题：{{ rendered?.subject }}</span>
          </div>
          <div class="chrome"><em>{{ rendered?.preheader }}</em></div>
          <div :class="previewClass" v-html="rendered?.html"></div>
        </div>
        <p class="small" style="margin-top:8px">
          深色模式下前景过深会被判为「深色不可读」；低能力模式隐藏图片并提示。退订链接带 data-no-rewrite，短链流程不会改写或删除它。
        </p>

        <label style="margin-top:10px">已发布版本（点击加载，内容不可变）</label>
        <table>
          <tr v-for="v in versions" :key="v.id">
            <td>v{{ v.version }}</td>
            <td>{{ v.subject }}</td>
            <td>{{ new Date(v.published_at).toLocaleString() }}</td>
            <td><button class="btn secondary" @click="loadVersion(v)">加载</button></td>
          </tr>
        </table>
      </div>
    </div>
  </div>
</template>
