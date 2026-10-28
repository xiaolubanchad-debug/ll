<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import type { TimelinePage } from '@apk/contracts';
import { api } from './api';
import { when } from './console-format';
import { reasonLabels } from './result-labels';
const props = defineProps<{ runId: string; taskId?: string }>();
const items = ref<TimelinePage['items']>([]),
  earlier = ref(false),
  later = ref(false),
  follow = ref(true),
  busy = ref(false),
  error = ref('');
let generation = 0,
  timer: ReturnType<typeof setInterval> | undefined;
async function load(mode: 'latest' | 'before' | 'after' = 'latest') {
  if (busy.value) return;
  const current = generation;
  busy.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams({
      limit: '100',
      ...(props.taskId ? { taskId: props.taskId } : {}),
    });
    if (mode === 'before' && items.value.length)
      query.set('beforeSequence', String(items.value[0].sequence));
    if (mode === 'after' && items.value.length)
      query.set('afterSequence', String(items.value.at(-1)!.sequence));
    const page = await api<TimelinePage>('/runs/' + props.runId + '/timeline?' + query);
    if (current !== generation) return;
    const combined =
      mode === 'latest'
        ? page.items
        : mode === 'before'
          ? [...page.items, ...items.value]
          : [...items.value, ...page.items];
    items.value = [...new Map(combined.map((e) => [e.sequence, e])).values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    if (items.value.length > 1000) {
      items.value = mode === 'before' ? items.value.slice(0, 1000) : items.value.slice(-1000);
      if (mode === 'before') {
        follow.value = false;
        later.value = true;
      }
    }
    if (mode !== 'after' || page.items.length)
      earlier.value =
        mode === 'before'
          ? page.hasEarlier
          : mode === 'latest'
            ? page.hasEarlier
            : earlier.value || combined.length > 1000;
    if (mode !== 'before') later.value = page.hasLater;
  } catch (e) {
    if (current === generation) error.value = e instanceof Error ? e.message : '读取日志失败';
  } finally {
    busy.value = false;
  }
}
async function reset() {
  generation++;
  items.value = [];
  earlier.value = false;
  later.value = false;
  follow.value = true;
  if (!busy.value) await load();
}
watch(() => [props.runId, props.taskId], reset);
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (!busy.value && follow.value && !document.hidden)
      void load(items.value.length ? 'after' : 'latest');
  }, 2000);
});
onUnmounted(() => {
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <section class="surface timeline-panel" aria-label="中文执行日志">
    <div class="section-heading">
      <div>
        <h2>执行日志</h2>
        <p class="muted">时间为北京时间。仅展示已保存的业务事件；批次清理状态见上方确认回执。</p>
      </div>
      <div class="form-actions">
        <label class="inline-check"><input v-model="follow" type="checkbox" />实时跟随</label
        ><el-button :disabled="busy" @click="load('latest')">查看最新</el-button>
      </div>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-button
      v-if="earlier"
      :disabled="busy"
      @click="
        follow = false;
        load('before');
      "
      >加载更早日志</el-button
    >
    <p v-if="!items.length && !busy" class="empty-state">
      节点尚未上报执行日志。任务未开始时不会生成注册结果。
    </p>
    <ol class="timeline-list">
      <li v-for="event in items" :key="event.id" :class="{ 'event-unapplied': !event.applied }">
        <div class="timeline-meta">
          <time>{{ when(event.occurredAt) }}</time
          ><span>#{{ event.sequence }}</span
          ><span v-if="event.recordedForReview" class="result-badge tone-warning">迟到证据</span
          ><span v-else-if="!event.applied" class="result-badge tone-warning">等待按序应用</span>
        </div>
        <strong>{{ event.title }}</strong>
        <p v-if="event.errorCode" class="muted">
          {{ reasonLabels[event.errorCode] ?? event.errorCode }}
        </p>
        <small v-if="event.taskId" class="muted">轮次引用 {{ event.taskId.slice(0, 8) }}</small>
      </li>
    </ol>
    <el-button v-if="later" :disabled="busy" @click="load('after')">读取后续日志</el-button
    ><small class="muted"> 每页 100 条，当前最多显示 1000 条，可向前或向后翻阅完整历史。</small>
  </section>
</template>
