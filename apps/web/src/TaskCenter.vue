<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { TaskPlanView, TaskPlanDetail, TaskPlanList, TaskCycleView } from '@apk/contracts';
import { api } from './api';
import { route, navigate, href } from './navigation';
import type { Section } from './navigation';
import { when } from './console-format';
import { reasonLabels } from './result-labels';
import TaskWizard from './TaskWizard.vue';
import TaskPlanActions from './TaskPlanActions.vue';
import MaintenanceManager from './MaintenanceManager.vue';
const items = ref<TaskPlanView[]>([]),
  detail = ref<TaskPlanDetail | null>(null),
  error = ref(''),
  notice = ref(''),
  next = ref<string | null>(null);
const editor = computed(
    () => route.value.query.get('edit') === 'true' || route.value.query.get('new') === 'true',
  ),
  archived = computed(() => route.value.query.get('archived') ?? 'ACTIVE');
const statuses: Record<string, string> = {
  QUEUED: '准备执行',
  CHECKING_PROXY: '检查代理',
  DOWNLOADING: '下载当天 APK',
  REGISTERING: '注册中',
  STOPPING: '等待停止与清理',
  STOPPED: '已停止',
  DONE: '本轮已完成',
  FAILED: '执行未完成',
  NEEDS_REVIEW: '等待核验',
  WAITING: '等待处理',
};
function status(task: TaskPlanView) {
  if (task.archivedAt) return '已归档';
  const c = task.latestCycle;
  return c
    ? c.executionKind === 'APP_OPEN' && c.status === 'REGISTERING'
      ? '启动停留中'
      : (statuses[c.status] ?? c.status)
    : '尚未开始';
}
function logId(c: TaskCycleView) {
  return c.activeRunId ?? c.registerRunIds.at(-1) ?? c.downloadRunId;
}
let timer: ReturnType<typeof setInterval> | undefined,
  generation = 0,
  refreshing = false,
  pendingRefresh = false,
  historyPage = false;
async function refresh(append = false) {
  if (refreshing) {
    pendingRefresh = true;
    return;
  }
  refreshing = true;
  if (append) historyPage = true;
  const g = generation;
  try {
    const q = new URLSearchParams({
      limit: '30',
      archived: archived.value,
      ...(append && next.value ? { cursor: next.value } : {}),
    });
    const p = await api<TaskPlanList>('/task-plans?' + q);
    const d = route.value.id ? await api<TaskPlanDetail>('/task-plans/' + route.value.id) : null;
    if (d && route.value.query.get('version')) {
      const v = await api<{ body: TaskPlanDetail['configuration'] }>(
        '/configs/' + d.task.configId + '/versions/' + route.value.query.get('version'),
      );
      d.configuration = v.body;
    }
    if (g !== generation) return;
    items.value = append ? [...items.value, ...p.items] : p.items;
    next.value = p.nextCursor;
    detail.value = d;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取任务失败';
  } finally {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void refresh();
    }
  }
}
async function saved(id: string) {
  notice.value = '任务设置已保存；当前执行状态见下方任务卡。';
  navigate('tasks', id);
  await refresh();
}
function fix(task: TaskPlanView, section: string, code?: string) {
  if (section === 'tasks' && code === 'NODE_BUSY') navigate('tasks');
  else if (section === 'tasks' && code === 'ARCHIVED') navigate('tasks', task.id);
  else if (section === 'tasks')
    navigate('tasks', task.id, {
      edit: 'true',
      ...(code === 'NEEDS_ADAPTATION' ? { step: '3' } : {}),
    });
  else if (section === 'runs' && task.latestCycle && logId(task.latestCycle))
    navigate('runs', logId(task.latestCycle)!);
  else navigate(section as Section);
}
watch(
  () => route.value.key,
  () => {
    generation++;
    historyPage = false;
    detail.value = null;
    void refresh();
  },
);
onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (!document.hidden && !editor.value && !historyPage) void refresh();
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
      <a v-if="route.id" :href="href('tasks')">← 返回任务中心</a
      ><el-button v-if="!editor" type="primary" @click="navigate('tasks', '', { new: 'true' })"
        >新建任务</el-button
      ><el-button @click="refresh()">刷新</el-button
      ><a :href="href('tasks', '', { archived: archived === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' })">{{
        archived === 'ACTIVE' ? '查看已归档' : '查看使用中'
      }}</a>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <TaskWizard
      v-if="editor && (!route.id || detail)"
      :key="(route.id || 'new') + (route.query.get('version') ?? '')"
      :initial="detail ?? undefined"
      :initial-step="route.query.get('step') === '3' ? 3 : 1"
      @saved="saved"
      @cancel="navigate('tasks', route.id)"
    />
    <template v-else-if="!editor">
      <p class="muted">
        保存一次任务，以后直接开始、停止和查看结果。开始会立即执行；每日自动执行只有在开启任务后生效。
      </p>
      <section v-if="!items.length && !detail" class="surface empty-state">
        <h2>创建第一个任务</h2>
        <p>填写网站和 XPath，选择服务器、代理及成功目标。版本与下载批次由系统管理。</p>
        <el-button type="primary" @click="navigate('tasks', '', { new: 'true' })"
          >创建任务</el-button
        >
        <p><a :href="href('runs')">查看旧执行与每日计划 →</a></p>
      </section>
      <article
        v-for="task in detail ? [detail.task] : items"
        :key="task.id"
        class="surface managed-task-card"
        :aria-label="task.name"
      >
        <div class="section-heading">
          <div>
            <span class="phase-tag">{{ status(task) }}</span>
            <h2>
              <a :href="href('tasks', task.id)">{{ task.name }}</a>
            </h2>
            <p class="muted">
              {{ task.nodeName }} ·
              {{
                task.enabled && task.automatic
                  ? '每日自动已开启：' + task.time + '（北京时间）'
                  : '每日自动未运行'
              }}
            </p>
          </div>
          <a
            v-if="task.latestCycle && logId(task.latestCycle)"
            :href="href('runs', logId(task.latestCycle)!)"
            >查看执行日志与结果 →</a
          >
        </div>
        <p v-if="task.nextRunAt" class="muted">
          下次自动执行：{{ when(task.nextRunAt) }}（北京时间）
        </p>
        <div v-if="task.latestCycle" class="quota-strip">
          <strong v-if="task.latestCycle.successTarget > 0"
            >{{ task.latestCycle.executionKind === 'APP_OPEN' ? '完成轮数' : '成功账户' }}
            {{ task.latestCycle.successes }} / {{ task.latestCycle.successTarget }}</strong
          ><span v-if="task.latestCycle.attemptLimit > 0"
            >已尝试 {{ task.latestCycle.attemptsStarted }} /
            {{ task.latestCycle.attemptLimit }}</span
          ><span>当天 APK {{ task.latestCycle.apkCount }} 个</span
          ><span>{{ task.latestCycle.day }} · 第 {{ task.latestCycle.round }} 轮</span>
        </div>
        <p v-else class="muted">
          {{ task.executionKind === 'APP_OPEN' ? '完成轮数目标' : '成功目标' }}
          {{ task.successTarget }}，最多尝试 {{ task.attemptLimit }} 次，所有 APK 合计。
        </p>
        <p v-if="task.latestCycle?.errorCode" class="result-explanation">
          {{ reasonLabels[task.latestCycle.errorCode] ?? task.latestCycle.errorCode }}
        </p>
        <p v-if="task.latestCycle?.deferredDownloadRules" class="result-explanation">
          当天复用原来源 APK；已修改的下载规则次日生效。
        </p>
        <ul v-if="task.readiness.length" class="readiness-list">
          <li v-for="r in task.readiness" :key="r.code + r.message">
            {{ r.message }}
            <el-button text @click="fix(task, r.section, r.code)">去处理 →</el-button>
          </li>
        </ul>
        <div
          v-if="
            task.latestCycle?.errorCode &&
            /ADAPTATION|^AUTO_|FLOW_NOT_CONFIGURED/.test(task.latestCycle.errorCode)
          "
          class="form-actions"
        >
          <a
            v-if="logId(task.latestCycle)"
            :href="href('runs', logId(task.latestCycle)!, { view: 'targets' })"
            >查看失败详情与功能记录</a
          ><el-button @click="navigate('tasks', task.id, { edit: 'true', step: '3' })"
            >补充注册规则</el-button
          >
        </div>
        <TaskPlanActions
          :task="task"
          @changed="
            notice = '';
            refresh();
          "
          @edit="navigate('tasks', task.id, { edit: 'true' })"
        />
      </article>
      <el-button v-if="next && !detail" @click="refresh(true)">加载更多任务</el-button>
      <template v-if="detail"
        ><section class="surface">
          <h2>本任务执行历史</h2>
          <div class="table-scroll">
            <table class="console-table">
              <thead>
                <tr>
                  <th>日期 / 轮次</th>
                  <th>状态</th>
                  <th>完成或成功 / 尝试</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in detail.cycles" :key="c.id">
                  <td>{{ c.day }} · 第 {{ c.round }} 轮</td>
                  <td>
                    {{
                      c.executionKind === 'APP_OPEN' && c.status === 'REGISTERING'
                        ? '启动停留中'
                        : (statuses[c.status] ?? c.status)
                    }}
                  </td>
                  <td>
                    {{ c.executionKind === 'APP_OPEN' ? '完成轮数' : '成功账户' }}
                    {{ c.successes }} / {{ c.attemptsStarted }}
                  </td>
                  <td><a v-if="logId(c)" :href="href('runs', logId(c)!)">日志与证据</a></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="muted">显示最近 20 轮，完整批次仍可在执行历史查询。</p>
        </section>
        <MaintenanceManager
          :config-id="detail.task.configId"
          @choose-version="
            (id) => navigate('tasks', detail!.task.id, { edit: 'true', version: id })
          "
      /></template>
    </template>
  </div>
</template>
