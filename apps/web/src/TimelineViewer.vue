<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import type { TimelinePage } from '@apk/contracts';
import { api } from './api';
import { when } from './console-format';
import { reasonLabels } from './result-labels';
const props = defineProps<{ runId: string; taskId?: string }>();
const timingLabels: Record<string, string> = {
  STARTUP_ADS: '处理开屏广告与公告',
  APPIUM_PREPARE: '准备 APP 控制服务',
  IDENTITY_IMAGE_CHECK: '校验设备系统镜像',
  PROXY_CHECK: '代理检查',
  AVD_CREATE: '创建独立模拟器',
  EMULATOR_BOOT: '安卓冷启动',
  DEVICE_CHECK: '设备信息检查',
  APK_VERIFY: '安装文件复核',
  APK_INSTALL: '安装 APK',
  APP_LAUNCH: '启动 APP',
  FOREGROUND_CHECK: '首次前台确认',
  FOREGROUND_DWELL: '前台停留',
  CLEANUP: '关闭并清理',
};
const seconds = (ms: number) => (ms / 1000).toFixed(2) + ' 秒';
const focusLabels = {
  SEEN: '已观察到目标 APP 获得焦点',
  NOT_SEEN: '采样期间未观察到目标 APP 获得焦点',
  UNOBSERVED: '目标 APP 焦点无法确认',
};
const windowLabels = {
  TARGET: '目标 APP',
  SPLASH: '开屏窗口',
  SYSTEM: '系统窗口',
  BROWSER: '浏览器',
  STORE: '应用商店',
  LAUNCHER: '桌面',
  OTHER: '其他应用',
  UNKNOWN: '无法确认',
  CRASH: '崩溃窗口',
};
const processLabels = { STARTED: '启动', EXITED: '退出', CRASH: 'Android 确认崩溃' };
const receiptLabels = {
  ACCEPTED: 'Android 已接受启动请求',
  TIMEOUT: '启动回执超时，按前台观察判定',
  UNCONFIRMED: '启动回执无法确认，按前台观察判定',
  REJECTED: 'Android 明确拒绝启动',
  NOT_ISSUED: '启动命令未发出',
};
const triggerLabels = {
  ACTIVITY: '界面',
  SERVICE: '服务',
  BROADCAST: '广播',
  PROVIDER: '内容提供程序',
  OTHER: '其他组件',
  UNKNOWN: '触发类别未确认',
};
const exitLabels = {
  EXIT_SELF: '进程自行退出',
  SIGNALED: '收到系统信号',
  LOW_MEMORY: '内存不足',
  CRASH: '应用崩溃',
  NATIVE_CRASH: '原生代码崩溃',
  ANR: '应用无响应',
  INITIALIZATION_FAILURE: '初始化失败',
  SYSTEM_STOP: '系统记录停止',
  DEPENDENCY_DIED: '依赖进程退出',
  OTHER: '其他系统原因',
  UNKNOWN: '退出原因未确认',
};
const selectedSession = ref('');
const sessions = computed(() => [
  ...new Set(items.value.map((e) => e.deviceSessionId).filter((id): id is string => !!id)),
]);
const shown = computed(() =>
  selectedSession.value
    ? items.value.filter((e) => e.deviceSessionId === selectedSession.value || !e.deviceSessionId)
    : items.value,
);
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
      节点尚未上报执行日志。任务未开始时不会生成执行结果。
    </p>
    <label v-if="sessions.length"
      >设备会话
      <select v-model="selectedSession" aria-label="筛选设备会话">
        <option value="">全部设备</option>
        <option v-for="id in sessions" :key="id" :value="id">设备 {{ id.slice(0, 8) }}</option>
      </select></label
    >
    <ol class="timeline-list">
      <li v-for="event in shown" :key="event.id" :class="{ 'event-unapplied': !event.applied }">
        <div class="timeline-meta">
          <time>{{ when(event.occurredAt) }}</time
          ><span>#{{ event.sequence }}</span
          ><span v-if="event.recordedForReview" class="result-badge tone-warning">迟到证据</span
          ><span v-else-if="!event.applied" class="result-badge tone-warning">等待按序应用</span>
        </div>
        <p v-if="event.deviceSessionId" class="muted">
          设备 {{ event.deviceSessionId.slice(0, 8)
          }}<template v-if="event.appIndex !== undefined">
            · APP {{ event.appIndex + 1 }} · {{ event.packageName }}</template
          >
        </p>
        <strong>{{ event.title }}</strong>
        <template v-if="event.appForeground">
          <p class="muted">
            {{ focusLabels[event.appForeground.targetFocus] }} · 最后窗口
            {{
              event.appForeground.last ? windowLabels[event.appForeground.last.kind] : '无可用采样'
            }}
            <code v-if="event.appForeground.last?.packageName">{{
              event.appForeground.last.packageName
            }}</code>
          </p>
          <p v-if="event.appForeground.scope === 'AFTER_LAUNCH_ERROR'" class="muted">
            启动回执失败后的快照
          </p>
          <p v-if="event.appForeground.launchReceipt" class="muted">
            {{ receiptLabels[event.appForeground.launchReceipt] }}
          </p>
          <details v-if="event.appForeground.samples.length">
            <summary>查看窗口切换时间（{{ event.appForeground.switchCount }} 次）</summary>
            <p v-for="(sample, i) in event.appForeground.samples" :key="i">
              启动后 {{ seconds(sample.offsetMs) }} · {{ windowLabels[sample.kind] }}
              <code v-if="sample.packageName">{{ sample.packageName }}</code>
            </p>
            <p
              v-if="event.appForeground.switchCount >= event.appForeground.samples.length"
              class="muted"
            >
              此处保留最早的 8 条变化记录和末次采样。
            </p>
            <p v-if="event.appForeground.last" class="muted">
              最后采样于启动后 {{ seconds(event.appForeground.last.offsetMs) }}
            </p>
          </details>
          <details v-if="event.appForeground.process">
            <summary>
              查看目标进程事件（{{ event.appForeground.process.events.length }} 条）
            </summary>
            <p v-if="event.appForeground.process.availability === 'UNAVAILABLE'" class="muted">
              本次无法读取 Android 进程事件。
            </p>
            <p v-else-if="!event.appForeground.process.events.length" class="muted">
              本次采集未记录目标进程的启动、退出或崩溃事件。
            </p>
            <p v-for="(process, i) in event.appForeground.process.events" :key="i">
              启动后 {{ seconds(process.offsetMs) }} ·
              {{ process.process === 'MAIN' ? '主进程' : '子进程' }}
              {{ processLabels[process.kind] }} · PID {{ process.pid }}
              <span v-if="process.trigger"> · {{ triggerLabels[process.trigger] }}</span>
              <span v-if="process.exitReason"> · {{ exitLabels[process.exitReason] }}</span>
            </p>
            <p v-if="event.appForeground.process.truncated" class="muted">部分进程事件已截断。</p>
          </details>
        </template>
        <details v-if="event.locator">
          <summary>查看本条定位 XPath</summary>
          <pre class="source-check-xpath">{{ event.locator }}</pre>
        </details>
        <p v-if="event.errorCode" class="muted">
          {{ reasonLabels[event.errorCode] ?? event.errorCode }}
        </p>
        <details v-if="event.openTimings" class="step-timings">
          <summary>查看步骤耗时 · 本轮 {{ seconds(event.openTimings.totalMs) }}</summary>
          <p class="muted">
            从准备模拟器到清理完成；缓存读取另计。准备步骤可能重叠，耗时不能直接相加。
          </p>
          <table>
            <thead>
              <tr>
                <th>步骤</th>
                <th>耗时</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="step in [...event.openTimings.steps].sort(
                  (a, b) => a.startedMs - b.startedMs,
                )"
                :key="step.name"
              >
                <td>{{ timingLabels[step.name] }}</td>
                <td>{{ seconds(step.elapsedMs) }}</td>
                <td>
                  {{
                    step.outcome === 'SUCCEEDED'
                      ? '完成'
                      : step.outcome === 'CANCELLED'
                        ? '已取消'
                        : '未完成'
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </details>
        <small v-if="event.taskId" class="muted">轮次引用 {{ event.taskId.slice(0, 8) }}</small>
      </li>
    </ol>
    <el-button v-if="later" :disabled="busy" @click="load('after')">读取后续日志</el-button
    ><small class="muted"> 每页 100 条，当前最多显示 1000 条，可向前或向后翻阅完整历史。</small>
  </section>
</template>
