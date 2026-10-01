<template>
  <article class="card">
    <h2>模块编辑器</h2>
    <label>主题
      <input :value="modelValue.subject" @input="update('subject', $event.target.value)" />
    </label>
    <label>预览文案
      <input :value="modelValue.previewText" @input="update('previewText', $event.target.value)" />
    </label>
    <label>正文 HTML
      <textarea rows="14" :value="modelValue.bodyHtml" @input="update('bodyHtml', $event.target.value)"></textarea>
    </label>
    <div class="row">
      <label class="grow">Campaign<input :value="modelValue.trackingParams.campaign" @input="setParam('campaign', $event.target.value)" /></label>
      <label class="grow">Source<input :value="modelValue.trackingParams.source" @input="setParam('source', $event.target.value)" /></label>
    </div>
    <button class="primary" @click="$emit('validate')">服务端复查模板</button>
  </article>
</template>
<script setup>
const props = defineProps({ modelValue: { type: Object, required: true }, report: Object });
const emit = defineEmits(['update:modelValue', 'validate']);
function update(field, value) {
  emit('update:modelValue', { ...props.modelValue, [field]: value });
}
function setParam(key, value) {
  emit('update:modelValue', { ...props.modelValue, trackingParams: { ...props.modelValue.trackingParams, [key]: value } });
}
</script>
