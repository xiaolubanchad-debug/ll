<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TaskPlanView, TaskControlInput } from '@apk/contracts';
import { mutation } from './api';
const props = defineProps<{ task: TaskPlanView }>(),
  emit = defineEmits<{ changed: []; edit: [] }>();
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  confirmNew = ref(false);
const active = computed(
  () =>
    props.task.latestCycle &&
    !['DONE', 'FAILED', 'STOPPED'].includes(props.task.latestCycle.status),
);
const finished = computed(() => {
  const c = props.task.latestCycle;
  return (
    c &&
    ['DONE', 'FAILED', 'STOPPED'].includes(c.status) &&
    (c.successes >= c.successTarget || c.attemptsStarted >= c.attemptLimit)
  );
});
async function control(action: TaskControlInput['action']) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await mutation(
      '/task-plans/' + props.task.id + '/control',
      { action },
      { 'If-Match': String(props.task.version) },
    );
    confirmNew.value = false;
    notice.value =
      action === 'STOP'
        ? '停止意图已保存：后续自动执行已关闭，正在等待节点停止与清理确认。'
        : action === 'START' || action === 'NEW_ROUND'
          ? '任务已开启，后台将检查代理、准备当天 APK 并执行。'
          : '任务设置已更新。';
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
    emit('changed');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="task-actions">
    <div class="form-actions">
      <el-button
        v-if="!task.archivedAt"
        type="primary"
        :disabled="
          busy ||
          task.readiness.length > 0 ||
          !!finished ||
          (!!active && task.latestCycle?.status !== 'NEEDS_REVIEW')
        "
        @click="control('START')"
        >{{
          finished
            ? '本轮已完成'
            : task.enabled && active && task.latestCycle?.status !== 'NEEDS_REVIEW'
              ? '正在执行'
              : '开始任务'
        }}</el-button
      >
      <el-button
        v-if="!task.archivedAt"
        class="stop-task-button"
        :disabled="busy || (!task.enabled && !active) || task.latestCycle?.status === 'STOPPING'"
        @click="control('STOP')"
        >{{ task.latestCycle?.status === 'STOPPING' ? '等待停止确认' : '停止任务' }}</el-button
      >
      <el-button v-if="!task.archivedAt" :disabled="busy" @click="emit('edit')">编辑任务</el-button>
      <el-button v-else :disabled="busy" @click="control('RESTORE')">恢复任务</el-button>
    </div>
    <details v-if="!task.archivedAt" class="task-more">
      <summary>更多操作</summary>
      <div class="form-actions">
        <el-button
          v-if="task.latestCycle && task.latestCycle.successTarget > 0"
          :disabled="busy || !!active || task.readiness.length > 0"
          @click="confirmNew = true"
          >新增一轮</el-button
        ><el-button :disabled="busy || !task.automatic" @click="control('DISABLE_DAILY')"
          >只关闭每日自动（当前继续）</el-button
        ><el-button :disabled="busy || task.enabled || !!active" @click="control('ARCHIVE')"
          >归档任务</el-button
        >
      </div>
    </details>
    <div v-if="confirmNew" class="confirmation-box" role="alert">
      <p>
        新增独立一轮：将再注册 {{ task.successTarget }} 个成功账户，最多尝试
        {{ task.attemptLimit }} 次。复用当天 APK，前一轮计数仍保留。
      </p>
      <el-button :disabled="busy" type="primary" @click="control('NEW_ROUND')"
        >确认新增一轮</el-button
      ><el-button :disabled="busy" @click="confirmNew = false">取消</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="notice" role="status" class="result-explanation">{{ notice }}</p>
  </div>
</template>
