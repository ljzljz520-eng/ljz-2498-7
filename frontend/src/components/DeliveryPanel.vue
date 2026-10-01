<template>
  <article class="card">
    <h2>发布与候选批</h2>
    <p>分组：{{ currentGroup?.name || groupId }}</p>
    <div class="buttons">
      <button @click="$emit('seed')">加入测试收件人</button>
      <button @click="$emit('new-audience')">固化受众版本</button>
      <button @click="$emit('new-campaign')">新建活动</button>
      <button class="primary" @click="$emit('publish')">发布固定版本</button>
      <button @click="$emit('create-batch')">生成候选发送批</button>
      <button class="primary" :disabled="!batch" @click="$emit('process')">领取并重投</button>
    </div>
    <dl class="meta">
      <dt>活动</dt><dd>{{ campaign?.id || '未创建' }}</dd>
      <dt>受众版本</dt><dd>{{ audienceVersion?.version || '未固化' }} / {{ audienceVersion?.member_count ?? 0 }} 人</dd>
      <dt>批次</dt><dd>{{ batch?.id || '未生成' }} / {{ batch?.status }}</dd>
    </dl>
    <p v-if="error" class="errors">{{ error.error || error }}</p>
  </article>
</template>
<script setup>
import { computed } from 'vue';
const props = defineProps({
  groups: Array, groupId: String, campaign: Object, audienceVersion: Object, batch: Object, error: [String, Object],
});
defineEmits(['seed', 'new-audience', 'new-campaign', 'publish', 'create-batch', 'process']);
const currentGroup = computed(() => props.groups.find((g) => g.id === props.groupId));
</script>
