<template>
  <article class="card">
    <div class="heading-row">
      <h2>预览</h2>
      <div class="segmented">
        <button :class="{ active: theme === 'light' }" @click="theme = 'light'">浅色</button>
        <button :class="{ active: theme === 'dark' }" @click="theme = 'dark'">深色</button>
      </div>
    </div>
    <div class="cap-row">
      <select v-model="client">
        <option value="apple-mail">Apple Mail</option>
        <option value="gmail-web">Gmail Web</option>
        <option value="outlook-desktop">Outlook Desktop</option>
      </select>
      <span class="badge" :class="readableClass">{{ readableText }}</span>
    </div>
    <iframe title="邮件预览" :srcdoc="srcdoc" class="preview-frame" :class="theme" />
    <p class="hint">深色模式会检查显式背景和 4.5:1 对比度；不同客户端能力见右侧矩阵。</p>
  </article>
</template>
<script setup>
import { computed, ref } from 'vue';

const props = defineProps({ html: String, report: Object });
const theme = ref('light');
const client = ref('apple-mail');
const srcdoc = computed(() => `<!doctype html><html><head><style>body{margin:0;background:${theme.value === 'dark' ? '#101010' : '#f3f4f6'};}html{color-scheme:${theme.value};}</style></head><body>${props.html}</body></html>`);
const readableClass = computed(() => props.report?.darkMode?.safe ? 'ok' : 'bad');
const readableText = computed(() => props.report?.darkMode?.safe ? '深色可读' : '深色不可读风险');
</script>
