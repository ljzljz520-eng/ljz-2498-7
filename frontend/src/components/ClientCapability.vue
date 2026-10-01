<template>
  <article class="card">
    <h2>客户端能力差异</h2>
    <table>
      <thead><tr><th>客户端</th><th>媒体查询</th><th>CSS 变量</th><th>强制深色</th></tr></thead>
      <tbody>
        <tr v-for="item in items" :key="item.client">
          <td>{{ item.client }}</td>
          <td>{{ bool(item.mediaQueries) }}</td>
          <td>{{ bool(item.cssVariables) }}</td>
          <td>{{ item.forcedDark }}</td>
        </tr>
      </tbody>
    </table>
  </article>
</template>
<script setup>
const props = defineProps({ report: Object });
import { computed } from 'vue';
const items = computed(() => props.report?.clientCapabilities?.length ? props.report.clientCapabilities : [
  { client: 'gmail-web', mediaQueries: false, cssVariables: false, forcedDark: 'partial' },
  { client: 'apple-mail', mediaQueries: true, cssVariables: true, forcedDark: 'supported' },
  { client: 'outlook-desktop', mediaQueries: 'partial', cssVariables: false, forcedDark: 'unsupported' },
]);
const bool = (v) => v === true ? '支持' : v === 'partial' ? '部分' : '不支持';
</script>
