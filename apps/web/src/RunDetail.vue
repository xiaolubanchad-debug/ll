<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import type { RunSummaryView, RegistrationDetailView } from '@apk/contracts';
import { api, mutation } from './api';
import { route, href, navigate } from './navigation';
import { categoryLabels, stateLabels, when } from './console-format';
import { purposeLabels, reasonLabels } from './result-labels';
import TimelineViewer from './TimelineViewer.vue';
import TaskEvidence from './TaskEvidence.vue';
const props = defineProps<{ runId: string }>();
interface TaskRow {
  id: string;
  position: number;
  label: string;
  status: string;
  errorCode: string | null;
  apk: { packageName: string } | null;
  registrationStartedAt: string | null;
}
const summary = ref<RunSummaryView | null>(null),
  tasks = ref<TaskRow[]>([]),
  next = ref<string | null>(null),
  detail = ref<RegistrationDetailView | null>(null),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  taskOnly = ref(!!route.value.query.get('task')),
  pendingStop = ref(false);
const taskCursor = ref(route.value.query.get('targetCursor') ?? '');
const panel = computed(() =>
  ['logs', 'targets', 'evidence'].includes(route.value.query.get('view') ?? '')
    ? route.value.query.get('view')!
    : 'logs',
);
function showPanel(value: string) {
  navigate('runs', props.runId, {
    view: value,
    ...(taskCursor.value ? { targetCursor: taskCursor.value } : {}),
    ...(route.value.query.get('task') ? { task: route.value.query.get('task')! } : {}),
  });
}
let timer: ReturnType<typeof setInterval> | undefined,
  refreshing = false,
  generation = 0;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const current = generation;
  try {
    const [s, p] = await Promise.all([
      api<RunSummaryView>('/runs/' + props.runId + '/summary'),
      api<{ items: TaskRow[]; nextCursor: string | null }>(
        '/runs/' +
          props.runId +
          '/tasks?limit=30' +
          (taskCursor.value ? '&cursor=' + taskCursor.value : ''),
      ),
    ]);
    if (current !== generation) return;
    summary.value = s;
    tasks.value = p.items;
    next.value = p.nextCursor;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取任务失败';
  } finally {
    refreshing = false;
  }
}
async function selectTask(id: string) {
  navigate('runs', props.runId, {
    task: id,
    view: 'evidence',
    ...(taskCursor.value ? { targetCursor: taskCursor.value } : {}),
  });
}
function changeTargetPage(cursor: string) {
  navigate('runs', props.runId, {
    view: 'targets',
    ...(cursor ? { targetCursor: cursor } : {}),
    ...(route.value.query.get('task') ? { task: route.value.query.get('task')! } : {}),
  });
}
async function loadDetail() {
  detail.value = null;
  const id = route.value.query.get('task');
  if (!id) return;
  try {
    const value = await api<RegistrationDetailView>('/registrations/' + encodeURIComponent(id));
    if (value.record.runId !== props.runId) throw Error('此轮记录不属于当前批次');
    if (route.value.query.get('task') === id) detail.value = value;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '记录读取失败';
  }
}
async function stop() {
  if (busy.value || pendingStop.value) return;
  busy.value = true;
  try {
    await mutation('/runs/' + props.runId + '/stop', {
      reason: '管理员在执行详情请求停止本次批次',
    });
    pendingStop.value = true;
    notice.value = '停止意图已保存，正在等待节点核验并清理；这不会关闭每日计划。';
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '停止请求失败';
  } finally {
    busy.value = false;
  }
}
async function reconcile() {
  busy.value = true;
  try {
    await mutation('/runs/' + props.runId + '/reconciliations', {
      reason: '管理员已逐项核验未知注册结果并核对清理与新的空闲心跳',
    });
    notice.value = '已记录清理核验，原始结果保持；系统不会自动重跑。';
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '清理核验失败';
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.runId,
  () => {
    generation++;
    taskCursor.value = '';
    pendingStop.value = false;
    void refresh();
    void loadDetail();
  },
);
watch(
  () => route.value.query.get('task'),
  () => {
    taskOnly.value = !!route.value.query.get('task');
    void loadDetail();
  },
);
watch(
  () => route.value.query.get('targetCursor'),
  (value) => {
    taskCursor.value = value ?? '';
    void refresh();
  },
);
onMounted(() => {
  void refresh();
  void loadDetail();
  timer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 3000);
});
onUnmounted(() => {
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <div class="console-stack">
    <div class="toolbar">
      <a :href="href('runs')">← 返回执行任务</a><span class="fingerprint">批次 {{ runId }}</span
      ><el-button :disabled="refreshing" @click="refresh">刷新详情</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <section v-if="summary" class="surface">
      <div class="section-heading">
        <div>
          <span class="phase-tag">{{ purposeLabels[summary.run.purpose] ?? '执行批次' }}</span>
          <h2>
            {{ summary.run.configName }} ·
            {{ stateLabels[summary.run.status] ?? summary.run.status }}
          </h2>
          <p class="muted">
            {{ summary.run.nodeName }} · 配置版本 {{ summary.configVersion }} · 开始
            {{ when(summary.run.createdAt)
            }}<span v-if="summary.finishedAt"> · 结束 {{ when(summary.finishedAt) }}</span>
          </p>
        </div>
        <el-button
          v-if="['QUEUED', 'ASSIGNED', 'RUNNING', 'STOP_REQUESTED'].includes(summary.run.status)"
          :disabled="busy || pendingStop || summary.run.status === 'STOP_REQUESTED'"
          @click="stop"
          >{{
            pendingStop || summary.run.status === 'STOP_REQUESTED'
              ? '等待节点停止确认'
              : '停止本次执行'
          }}</el-button
        >
      </div>
      <p class="muted">内容隔离已开启。真实操作与结果判定保留，原始 APP 画面不回传、不展示。</p>
      <p v-if="summary.run.errorCode" class="result-explanation">
        {{ reasonLabels[summary.run.errorCode] ?? summary.run.errorCode }}
      </p>
      <div v-if="summary.run.purpose === 'REGISTER'" class="quota-strip">
        <strong>成功 {{ summary.run.successes }} / {{ summary.run.successTarget }}</strong
        ><span>已尝试 {{ summary.run.attemptsStarted }} / {{ summary.run.attemptLimit }}</span
        ><small>所有 APK 合计；未执行配额不计尝试。</small>
      </div>
      <div class="status-strip">
        <span v-if="summary.run.purpose === 'REGISTER'"
          >自动身份观察 {{ summary.automaticIdentityCount }} 次（不计入成功）</span
        >
        <span v-for="(count, key) in summary.counts" :key="key"
          >{{
            summary.run.purpose === 'DOWNLOAD' && key === 'SUCCESS'
              ? '下载成功'
              : categoryLabels[key]
          }}
          {{ count }}</span
        >
      </div>
      <p>
        清理回执：{{
          {
            CONFIRMED: '批次已确认结束',
            PENDING: '等待批次结束回执',
            NEEDS_REVIEW: '需要核验，服务器保持隔离',
          }[summary.cleanup]
        }}
      </p>
      <div v-if="summary.activeTask" class="active-task">
        <strong
          >当前第 {{ summary.activeTask.position }} 项 ·
          {{ stateLabels[summary.activeTask.stage] ?? summary.activeTask.stage }}</strong
        >
        <p>{{ summary.activeTask.packageName ?? summary.activeTask.label }}</p>
        <el-button
          v-if="summary.run.purpose === 'REGISTER'"
          text
          @click="selectTask(summary.activeTask!.id)"
          >查看当前轮次</el-button
        >
      </div>
      <p v-if="summary.cleanup === 'NEEDS_REVIEW'" class="muted">
        先逐项记录未知结果的人工决议，再确认执行环境清理。原记录保留，不自动提交。
      </p>
      <el-button v-if="summary.cleanup === 'NEEDS_REVIEW'" :disabled="busy" @click="reconcile"
        >核验清理后解除占用</el-button
      >
    </section>
    <div class="section-tabs" role="tablist" aria-label="任务详情分区">
      <button
        role="tab"
        :aria-selected="panel === 'logs'"
        :class="{ active: panel === 'logs' }"
        @click="showPanel('logs')"
      >
        执行日志</button
      ><button
        role="tab"
        :aria-selected="panel === 'targets'"
        :class="{ active: panel === 'targets' }"
        @click="showPanel('targets')"
      >
        轮次与目标</button
      ><button
        v-if="detail"
        role="tab"
        :aria-selected="panel === 'evidence'"
        :class="{ active: panel === 'evidence' }"
        @click="showPanel('evidence')"
      >
        证据与账户
      </button>
    </div>
    <section v-if="panel === 'targets'" class="surface">
      <h2>执行轮次与目标</h2>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>序号</th>
              <th>入口 / APK</th>
              <th>当前结果或阶段</th>
              <th>原因</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id">
              <td>{{ t.position + 1 }}</td>
              <td>
                {{ t.label }}<small>{{ t.apk?.packageName ?? '尚无包信息' }}</small>
              </td>
              <td>{{ stateLabels[t.status] ?? t.status }}</td>
              <td>{{ t.errorCode ? (reasonLabels[t.errorCode] ?? t.errorCode) : '—' }}</td>
              <td>
                <el-button v-if="t.registrationStartedAt" text @click="selectTask(t.id)"
                  >查看证据与账户</el-button
                ><span v-else class="muted">尚未进入注册</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!tasks.length" class="empty-state">节点尚未登记执行目标。</p>
      <div class="form-actions">
        <el-button v-if="taskCursor" @click="changeTargetPage('')">返回首批目标</el-button
        ><el-button v-if="next" @click="changeTargetPage(next!)">下一批目标</el-button
        ><span class="muted">当前页每 3 秒更新，不跳回最早页面。</span>
      </div>
    </section>
    <template v-if="detail && panel === 'evidence'"
      ><section class="surface">
        <div class="section-heading">
          <h2>第 {{ detail.record.position }} 轮 · {{ categoryLabels[detail.record.category] }}</h2>
          <el-button @click="navigate('runs', runId)">收起轮次</el-button>
        </div>
        <label class="inline-check"
          ><input v-model="taskOnly" type="checkbox" />日志仅显示这一轮</label
        >
      </section>
      <TaskEvidence
        :key="detail.record.id"
        :task="{
          id: detail.record.id,
          status: detail.record.status,
          accountAvailable: detail.record.hasAccount,
          recognition: detail.recognition ?? undefined,
          observation: detail.observation ?? undefined,
          reviews: detail.reviews,
        }"
        @updated="
          loadDetail();
          refresh();
        "
    /></template>
    <section v-if="detail && panel === 'logs'" class="surface">
      <div class="section-heading">
        <div>
          <h3>
            第 {{ detail.record.position }} 轮 ·
            {{ detail.record.apk?.packageName ?? detail.record.label }}
          </h3>
          <label class="inline-check"
            ><input v-model="taskOnly" type="checkbox" />日志仅显示这一轮</label
          >
        </div>
        <el-button @click="showPanel('evidence')">查看此轮证据与账户</el-button>
      </div>
    </section>
    <TimelineViewer
      v-if="panel === 'logs'"
      :key="runId + (taskOnly ? (route.query.get('task') ?? '') : '')"
      :run-id="runId"
      :task-id="taskOnly ? (route.query.get('task') ?? undefined) : undefined"
    />
  </div>
</template>
