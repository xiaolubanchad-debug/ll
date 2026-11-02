<script setup lang="ts">
import { ref, watch } from 'vue';
import type { SourceElementCheck } from '@apk/contracts';
import { sourceCheckXPath } from '@apk/contracts';
const props = defineProps<{ modelValue?: SourceElementCheck[] }>(),
  emit = defineEmits<{ 'update:modelValue': [SourceElementCheck[]] }>();
interface Draft {
  id: string;
  label: string;
  kind: 'ATTRIBUTE' | 'TAG' | 'XPATH';
  attribute: string;
  value: string;
  tag: string;
  xpath: string;
}
const rows = ref<Draft[]>([]);
watch(
  () => props.modelValue,
  (value) => {
    rows.value = (value ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      attribute: r.kind === 'ATTRIBUTE' ? r.attribute : 'pid',
      value: r.kind === 'ATTRIBUTE' ? r.value : '',
      tag: r.kind === 'TAG' ? r.tag : 'i',
      xpath: r.kind === 'XPATH' ? r.xpath : '',
    }));
  },
  { immediate: true },
);
function rule(r: Draft): SourceElementCheck {
  const label = r.label.trim();
  const base = { id: r.id, label: label.slice(0, 100) };
  return r.kind === 'ATTRIBUTE'
    ? { ...base, kind: 'ATTRIBUTE', attribute: r.attribute.trim(), value: r.value }
    : r.kind === 'TAG'
      ? { ...base, kind: 'TAG', tag: r.tag.trim() }
      : { ...base, kind: 'XPATH', xpath: r.xpath.trim() };
}
function publish() {
  emit('update:modelValue', rows.value.map(rule));
}
function add() {
  rows.value.push({
    id: crypto.randomUUID(),
    label: '',
    kind: 'ATTRIBUTE',
    attribute: 'pid',
    value: '',
    tag: 'i',
    xpath: '',
  });
  publish();
}
function remove(index: number) {
  rows.value.splice(index, 1);
  publish();
}
</script>
<template>
  <section class="source-check-editor" aria-label="每日元素检查配置">
    <h3>每日元素检查（人工填写，可选）</h3>
    <p class="muted">
      每天下载前，检查来源页面是否存在你填写的元素。缺失会记录并提醒；这些检查不会额外点击，也不会改变下载范围。
    </p>
    <p v-if="!rows.length" class="muted">
      尚未配置检查项。可填写属性 pid/name、自定义属性、标签 i，或完整 XPath。
    </p>
    <article v-for="(row, index) in rows" :key="row.id" class="source-check-row">
      <div class="form-grid">
        <label
          >检查名称<input
            v-model="row.label"
            maxlength="100"
            placeholder="例如：下载图标（可留空）"
            @input="publish"
        /></label>
        <label
          >定位方式<select v-model="row.kind" @change="publish">
            <option value="ATTRIBUTE">按属性</option>
            <option value="TAG">按标签</option>
            <option value="XPATH">完整 XPath</option>
          </select></label
        >
        <template v-if="row.kind === 'ATTRIBUTE'"
          ><label
            >属性名<input
              v-model="row.attribute"
              maxlength="64"
              placeholder="pid 或 name 或自定义属性"
              @input="publish" /></label
          ><label
            >属性值<input
              v-model="row.value"
              maxlength="1000"
              placeholder="例如：1230"
              @input="publish" /></label
        ></template>
        <label v-else-if="row.kind === 'TAG'"
          >标签名<input v-model="row.tag" maxlength="64" placeholder="例如：i" @input="publish"
        /></label>
        <label v-else
          >检查 XPath<textarea
            v-model="row.xpath"
            rows="2"
            maxlength="12000"
            placeholder="例如：//i[@name='download']"
            @input="publish"
          />
        </label>
      </div>
      <small>实际检查：{{ sourceCheckXPath(rule(row)) }}</small>
      <button type="button" @click="remove(index)">删除此检查</button>
    </article>
    <button type="button" :disabled="rows.length >= 1000" @click="add">添加检查项</button>
  </section>
</template>
