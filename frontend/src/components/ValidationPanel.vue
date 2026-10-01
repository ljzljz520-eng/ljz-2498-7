<template>
  <article class="card">
    <h2>发布前校验</h2>
    <h3>错误</h3>
    <ul class="errors"><li v-for="(error, i) in report?.errors || []" :key="'e'+i">{{ error.code }}：{{ error.message }}</li></ul>
    <h3>警告</h3>
    <ul class="warnings"><li v-for="(warning, i) in report?.warnings || []" :key="'w'+i">{{ warning.code }}：{{ warning.message }}</li></ul>
    <h3>链接</h3>
    <ul class="links">
      <li v-for="(link, i) in report?.links || []" :key="'l'+i">
        <span :class="['badge', link.unsubscribe ? 'ok' : 'neutral']">{{ link.unsubscribe ? '退订保护' : '跟踪重写' }}</span>
      </li>
    </ul>
  </article>
</template>
<script setup>
defineProps({ report: Object });
</script>
