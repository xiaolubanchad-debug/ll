<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { ApkWorkbenchView, RunInput, TaskPlanList, TaskPlanView } from '@apk/contracts';
import { api, mutation } from './api';
import { when } from './console-format';
import { href, route } from './navigation';
import { reasonLabels } from './result-labels';

const tasks = ref<TaskPlanView[]>([]);
const nodeId = ref('');
const taskId = ref('');
const resources = ref<ApkWorkbenchView | null>(null);
const drafts = reactive<Record<string, string>>({});
const error = ref('');
const submitting = ref(false);
const loading = ref(false);
const nodes = computed(() => [...new Map(tasks.value.map((task) => [task.nodeId, task.nodeName]))]);
const choices = computed(() => tasks.value.filter((task) => task.nodeId === nodeId.value));
const selected = computed(() => choices.value.find((task) => task.id === taskId.value));
const active = (status?: string) =>
  ['QUEUED', 'ASSIGNED', 'RUNNING', 'STOP_REQUESTED'].includes(status ?? '');
const pending = computed(
  () =>
    active(resources.value?.scan?.status) ||
    resources.value?.items.some((row) => active(row.download?.status)),
);
const key = (target: string) =>
  [selected.value?.nodeId, selected.value?.configId, target].join(':');
const bytes = (size: number) => (size / 1024 / 1024).toFixed(1) + ' MiB';
const reason = (code?: string | null) => (code ? (reasonLabels[code] ?? code) : '');
const downloadStatus = (row: ApkWorkbenchView['items'][number]) => {
  switch (row.download?.status) {
    case 'QUEUED':
    case 'ASSIGNED':
      return '排队中';
    case 'RUNNING':
      return '下载中';
    case 'STOP_REQUESTED':
      return '停止中';
    case 'SUCCEEDED':
      return '可用';
    case 'CANCELLED':
      return '已取消';
    case 'NEEDS_REVIEW':
      return '待核验';
    case 'FAILED':
      return row.fileName ? '更新失败' : '下载失败';
    default:
      return row.url ? '待下载' : '待填写';
  }
};

let request = 0;
async function refresh() {
  const chosen = selected.value;
  if (!chosen) return;
  const serial = ++request;
  loading.value = true;
  try {
    const data = await api<ApkWorkbenchView>(
      '/apk-assets/workbench?' +
        new URLSearchParams({
          nodeId: chosen.nodeId,
          configVersionId: chosen.currentVersionId,
        }),
    );
    if (serial === request) resources.value = data;
  } catch (failure) {
    if (serial === request)
      error.value = failure instanceof Error ? failure.message : '资源读取失败';
  } finally {
    if (serial === request) loading.value = false;
  }
}
watch(nodeId, () => {
  if (!choices.value.some((task) => task.id === taskId.value))
    taskId.value = choices.value[0]?.id ?? '';
});
watch(selected, () => {
  request++;
  resources.value = null;
  error.value = '';
  loading.value = false;
  void refresh();
});
async function submit(resourceAction: NonNullable<RunInput['resourceAction']>) {
  const chosen = selected.value;
  const releaseId = resources.value?.releaseId;
  if (!chosen || !releaseId || !resources.value?.supported || pending.value || submitting.value)
    return;
  const draftKey = resourceAction.kind === 'FETCH' ? key(resourceAction.targetKey) : null;
  submitting.value = true;
  error.value = '';
  try {
    await mutation('/runs', {
      nodeId: chosen.nodeId,
      configVersionId: chosen.currentVersionId,
      releaseId,
      purpose: 'DOWNLOAD',
      resourceAction,
    });
    if (draftKey) delete drafts[draftKey];
    await refresh();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '操作失败';
  } finally {
    submitting.value = false;
  }
}
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  timer = setInterval(() => {
    if (pending.value && !loading.value && !submitting.value) void refresh();
  }, 2000);
  try {
    let cursor: string | null = null;
    const list: TaskPlanView[] = [];
    do {
      const page: TaskPlanList = await api(
        '/task-plans?' +
          new URLSearchParams({
            archived: 'ACTIVE',
            limit: '100',
            ...(cursor ? { cursor } : {}),
          }),
      );
      list.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    tasks.value = list;
    const preferred = list.find((task) => task.id === route.value.query.get('task'));
    nodeId.value = preferred?.nodeId ?? nodes.value[0]?.[0] ?? '';
    taskId.value = preferred?.id ?? choices.value[0]?.id ?? '';
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '任务配置读取失败';
  }
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section class="surface">
    <h2>APK 下载工作台</h2>
    <p class="muted">
      选服务器和配置，扫描入口，再逐行填写完整 APK 地址并下载。网页扫描和文件下载均由服务器直连。
    </p>
    <div class="toolbar">
      <label
        >服务器<select v-model="nodeId">
          <option v-for="[id, name] in nodes" :key="id" :value="id">{{ name }}</option>
        </select></label
      >
      <label
        >任务配置<select v-model="taskId">
          <option v-for="task in choices" :key="task.id" :value="task.id">{{ task.name }}</option>
        </select></label
      >
      <el-button
        type="primary"
        :disabled="!resources?.supported || submitting || pending"
        @click="submit({ kind: 'SCAN' })"
        >扫描 XPath</el-button
      >
      <el-button :disabled="!selected || loading" @click="refresh()">刷新</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="resources && !resources.supported" class="muted">APK 下载工作台需要 Agent 0.17.9。</p>
    <p v-if="resources?.scan" role="status" class="muted">
      {{
        active(resources.scan.status)
          ? '正在扫描 XPath'
          : resources.scan.status === 'SUCCEEDED'
            ? '扫描完成'
            : '扫描未完成'
      }}
      · {{ when(resources.scan.createdAt) }}
      {{ reason(resources.scan.errorCode) }}
    </p>
    <div v-if="resources?.items.length" class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>应用 / 元素</th>
            <th>APK 直链</th>
            <th>下载状态</th>
            <th>当前文件</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in resources.items" :key="row.targetKey">
            <td>
              <strong>{{ row.label }}</strong
              ><small>{{ row.sourceLocator }}</small
              ><small v-if="!row.present">入口未找到</small>
            </td>
            <td>
              <input
                :aria-label="row.label + ' APK 直链'"
                :value="drafts[key(row.targetKey)] ?? row.url ?? ''"
                :disabled="!row.present || active(row.download?.status)"
                type="url"
                maxlength="4096"
                placeholder="https://…"
                autocomplete="off"
                spellcheck="false"
                @input="drafts[key(row.targetKey)] = ($event.target as HTMLInputElement).value"
              />
            </td>
            <td>
              {{ downloadStatus(row) }}
              <template v-if="row.download?.status === 'RUNNING' && row.receivedBytes">
                <progress v-if="row.totalBytes" :value="row.receivedBytes" :max="row.totalBytes" />
                <small
                  >{{ bytes(row.receivedBytes)
                  }}{{ row.totalBytes ? ' / ' + bytes(row.totalBytes) : '' }}</small
                >
              </template>
              <small v-if="row.download?.errorCode">{{ reason(row.download.errorCode) }}</small>
            </td>
            <td>
              <template v-if="row.fileName"
                >{{ row.fileName
                }}<small
                  >{{ row.size !== null ? bytes(row.size) : '' }} ·
                  {{ row.downloadedAt ? when(row.downloadedAt) : '' }}</small
                ></template
              >
              <span v-else>—</span>
            </td>
            <td>
              <el-button
                size="small"
                :disabled="
                  !resources.supported ||
                  !row.present ||
                  submitting ||
                  pending ||
                  !(drafts[key(row.targetKey)] ?? row.url)?.trim()
                "
                @click="
                  submit({
                    kind: 'FETCH',
                    targetKey: row.targetKey,
                    url: (drafts[key(row.targetKey)] ?? row.url ?? '').trim(),
                  })
                "
                >下载</el-button
              >
              <small v-if="row.download"
                ><a :href="href('runs', row.download.id)">下载日志</a></small
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="empty-state">
      {{
        !selected ? '请选择任务配置。' : loading ? '正在读取资源…' : '暂无匹配入口，可扫描 XPath。'
      }}
    </p>
  </section>
</template>

<style scoped>
td small {
  display: block;
  margin-top: 6px;
  overflow-wrap: anywhere;
}
td input {
  min-width: 16rem;
  width: 100%;
}
td progress {
  display: block;
  width: 7rem;
}
</style>
