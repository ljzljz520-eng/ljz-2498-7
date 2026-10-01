<script setup>
import { ref, provide } from 'vue';
import TemplateEditor from './components/TemplateEditor.vue';
import Audiences from './components/Audiences.vue';
import Batches from './components/Batches.vue';
import Logs from './components/Logs.vue';

const tab = ref('editor');
const userId = ref(localStorage.getItem('userId') || '1');
userId.value && localStorage.setItem('userId', userId.value);
function setUser(e) {
  userId.value = e.target.value;
  localStorage.setItem('userId', userId.value);
  location.reload();
}
provide('userId', userId);
</script>

<template>
  <div class="app">
    <nav>
      <strong style="padding:4px 10px 12px">邮件活动编辑台</strong>
      <button :class="{ active: tab==='editor' }" @click="tab='editor'">模板编辑与预览</button>
      <button :class="{ active: tab==='audiences' }" @click="tab='audiences'">受众版本</button>
      <button :class="{ active: tab==='batches' }" @click="tab='batches'">候选发送批</button>
      <button :class="{ active: tab==='logs' }" @click="tab='logs'">投递日志</button>
      <div style="margin-top:auto">
        <label>当前用户（分组越权演示）</label>
        <select :value="userId" @change="setUser">
          <option value="1">1 Alice（growth 组）</option>
          <option value="2">2 Bob（billing 组）</option>
          <option value="3">3 Admin（全部组）</option>
        </select>
      </div>
    </nav>
    <main>
      <TemplateEditor v-if="tab==='editor'" />
      <Audiences v-else-if="tab==='audiences'" />
      <Batches v-else-if="tab==='batches'" />
      <Logs v-else-if="tab==='logs'" />
    </main>
  </div>
</template>
