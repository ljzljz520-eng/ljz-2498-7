<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../lib/api.js';
const audiences = ref([]);
const name = ref('十月名单');
const csv = ref(`zhang@example.test,张伟,city=上海
li@example.test,李娜,city=北京
wang@example.test,王芳 <script>,city=深圳
zhao@example.test,赵强,city=杭州`);
const members = ref([]);
const msg = ref('');
const unsubEmail = ref('li@example.test');
const unsubMsg = ref('');

async function load() { audiences.value = await api.get('/api/audiences'); }
async function importAud() {
  const r = await api.post('/api/audiences', { name: name.value, csv: csv.value });
  msg.value = `已生成 ${name.value} v${r.version}，导入 ${r.imported} 人（不可变快照）`;
  await load();
}
async function view(a) {
  members.value = await api.get(`/api/audiences/${a.id}/members`);
}
async function unsubscribe() {
  await api.post('/api/unsubscribe', { email: unsubEmail.value, reason: 'manual-demo' });
  unsubMsg.value = `已登记退订：${unsubEmail.value}（发送中将立即抑制；确认后投递保留并记录）`;
}
onMounted(load);
</script>
<template>
  <div class="panel">
    <strong>受众版本</strong>
    <div class="grid2">
      <div>
        <label>名单名称（同名导入生成新版本，旧版本保留）</label>
        <input v-model="name" />
        <label>导入文本（每行：邮箱,姓名,key=值;key2=值2）</label>
        <textarea v-model="csv" style="min-height:150px;font-family:ui-monospace,monospace"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn" @click="importAud">导入为新版本</button></div>
        <p v-if="msg" class="ok-c small">{{ msg }}</p>
      </div>
      <div>
        <table>
          <tr><th>ID</th><th>名称</th><th>版本</th><th>人数</th><th></th></tr>
          <tr v-for="a in audiences" :key="a.id">
            <td>{{ a.id }}</td><td>{{ a.name }}</td><td>v{{ a.version }}</td><td>{{ a.size }}</td>
            <td><button class="btn secondary" @click="view(a)">查看成员</button></td>
          </tr>
        </table>
        <div v-if="members.length" style="margin-top:10px">
          <strong class="small">成员（变量值原样存储，渲染时转义）</strong>
          <table>
            <tr v-for="(m,i) in members" :key="i"><td>{{ m.email }}</td><td>{{ m.name }}</td><td>{{ m.vars_json }}</td></tr>
          </table>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <strong>退订登记（全局邮箱生效，竞态演示用）</strong>
    <div class="row" style="margin-top:8px">
      <input v-model="unsubEmail" style="max-width:260px" />
      <button class="btn" @click="unsubscribe">立即退订</button>
    </div>
    <p v-if="unsubMsg" class="small ok-c">{{ unsubMsg }}</p>
  </div>
</template>
