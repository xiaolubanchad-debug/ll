<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import type { NodeCapacityView } from '@apk/contracts';
import { schemaIssues, MAX_DAILY_OPEN_LIMIT } from '@apk/contracts';
import { api, mutation } from './api';
const props = defineProps<{ nodeId: string; groupSize: number }>(),
  emit = defineEmits<{ updated: [value: NodeCapacityView] }>();
const data = ref<NodeCapacityView | null>(null),
  mode = ref<'AUTO' | 'MANUAL'>('AUTO'),
  manual = ref(2000),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  dirty = ref(false);
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  const g = ++generation;
  try {
    const r = await api<NodeCapacityView>(
      '/nodes/' +
        props.nodeId +
        '/execution-capacity?appsPerDeviceMin=' +
        Math.max(1, Math.min(1000, props.groupSize || 1)),
    );
    if (g !== generation) return;
    if (schemaIssues('NodeCapacityView', r).length) throw Error('每日额度数据格式暂时无法读取');
    data.value = r;
    if (!dirty.value) {
      mode.value = r.mode;
      manual.value = r.manualLimit ?? r.recommendedLimit;
    }
    error.value = '';
    emit('updated', r);
  } catch (e) {
    if (g === generation) error.value = e instanceof Error ? e.message : '无法读取每日额度';
  }
}
async function apply() {
  if (!data.value || busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    if (
      mode.value === 'MANUAL' &&
      (!Number.isInteger(manual.value) || manual.value < 1 || manual.value > MAX_DAILY_OPEN_LIMIT)
    )
      throw Error('请填写 1–' + MAX_DAILY_OPEN_LIMIT + ' 的整数额度');
    await mutation(
      '/nodes/' + props.nodeId + '/execution-capacity',
      { dailyLimit: mode.value === 'AUTO' ? null : manual.value },
      { 'If-Match': String(data.value.version) },
      'PUT',
    );
    dirty.value = false;
    await load();
    notice.value = '服务器额度设置已保存；当天已冻结额度只可提高，降低或恢复自动次日生效。';
  } catch (e) {
    const message = e instanceof Error ? e.message : '额度保存失败';
    await load();
    error.value = message;
  } finally {
    busy.value = false;
  }
}
watch(
  () => [props.nodeId, props.groupSize],
  (value, old) => {
    if (value[0] !== old?.[0]) {
      dirty.value = false;
      data.value = null;
    }
    clearTimeout(timer);
    if (props.nodeId) timer = setTimeout(() => void load(), 200);
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <div class="capacity-settings">
    <h3>服务器每日额度</h3>
    <p v-if="error" class="result-explanation" role="status">{{ error }}</p>
    <p v-else-if="!data" class="muted">正在读取服务器每日额度…</p>
    <template v-if="data">
      <p>
        自动建议 <strong>{{ data.recommendedLimit }}</strong> 次 / 天 · 今日额度 {{ data.limit }} ·
        已用 {{ data.used }} · 剩余 {{ data.remaining }}
      </p>
      <p class="muted">
        按每台最少 {{ data.appsPerDeviceMin }} 个 APP、设备准备约
        {{ Math.ceil(data.deviceSetupMs / 1000) }} 秒、每 APP 约
        {{ Math.ceil(data.appMs / 1000) }} 秒估算，保留 {{ data.reservePercent }}%
        余量。当前剩余时间预计可执行约 {{ data.remainingTimeEstimate }} 次。
      </p>
      <p class="muted">
        {{
          data.sampleScope === 'CONSERVATIVE_REFERENCE'
            ? '暂无足够样本，采用保守参考值。'
            : data.sampleScope === 'OWNED_TEST_ONLY'
              ? '参考自有测试 APK 的 ' + data.sampleApps + ' 次完成记录；实际产品可能更慢。'
              : '参考本服务器 ' + data.sampleApps + ' 次完成记录。'
        }}估算不是全天性能保证。
      </p>
      <p v-if="!data.supported" class="result-explanation">
        当前 Agent 需升级至 0.14.0 才能使用新额度及超过 10 个 APP 的设备会话；旧执行策略暂保持 800。
      </p>
      <div class="filter-grid">
        <label
          >每日额度方式<select v-model="mode" :disabled="busy" @change="dirty = true">
            <option value="AUTO">自动估算</option>
            <option value="MANUAL">手动调整</option>
          </select></label
        >
        <label v-if="mode === 'MANUAL'"
          >手动每日额度<input
            v-model.number="manual"
            type="number"
            min="1"
            :max="MAX_DAILY_OPEN_LIMIT"
            :disabled="busy"
            @input="dirty = true"
        /></label>
      </div>
      <div class="form-actions">
        <el-button :disabled="busy || !dirty" @click="apply">应用服务器额度</el-button
        ><el-button text :disabled="busy" @click="load">刷新额度</el-button>
      </div>
      <p v-if="notice" role="status" class="result-explanation">{{ notice }}</p>
    </template>
  </div>
</template>
