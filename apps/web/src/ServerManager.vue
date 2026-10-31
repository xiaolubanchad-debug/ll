<script setup lang="ts">
import { ref, onMounted, onUnmounted, reactive, nextTick } from 'vue';
import { schemaIssues } from '@apk/contracts';
import type {
  NodeView,
  NodeInput,
  ReleaseInput,
  TaskPlanView,
  TaskPlanDetail,
} from '@apk/contracts';
import { api, mutation } from './api';
import { when } from './console-format';
import {
  activeCycle,
  currentFlow,
  finishedCycle,
  ownsRun,
  preferredTask,
  executionLabel,
  startReason,
  logRun,
} from './server-console';
import TaskWizard from './TaskWizard.vue';
import RunDetail from './RunDetail.vue';
import MaintenanceManager from './MaintenanceManager.vue';
const emit = defineEmits<{ changed: [] }>();
interface Operation {
  id: string;
  kind: string;
  status: string;
  stopRequested: boolean;
  errorCode: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}
interface ReleaseRow {
  id: string;
  manifest: ReleaseInput;
}
const nodes = ref<NodeView[]>([]),
  selected = ref<NodeView | null>(null),
  operations = ref<Operation[]>([]),
  releases = ref<ReleaseRow[]>([]),
  events = ref<{ sequence: number; status: string; code: string }[]>([]);
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  editing = ref(false),
  editingId = ref<string | null>(null),
  editingVersion = ref(0),
  archiveNodeId = ref<string | null>(null);
const form = reactive({
  name: '',
  host: '',
  port: 22,
  username: 'ubuntu',
  method: 'SSH_KEY',
  privateKey: '',
  passphrase: '',
  password: '',
  sudoPassword: '',
});
const fingerprint = ref(''),
  releaseId = ref(''),
  licenseAccepted = ref(false),
  manifestText = ref(''),
  taskChoices = ref<TaskPlanView[]>([]),
  templateConfigs = ref<{ id: string; name: string }[]>([]),
  editorCopyConfigId = ref<string | undefined>(undefined),
  choices = reactive<Record<string, string>>({}),
  editorNode = ref<NodeView | null>(null),
  editorTask = ref<TaskPlanDetail | undefined>(undefined),
  confirmTask = ref<TaskPlanView | null>(null),
  visibleLog = ref<string | null>(null),
  managementPanel = ref<HTMLElement | null>(null);
const stages: Record<string, string> = {
  QUEUED: '等待 Worker',
  CONNECTING: '连接服务器',
  CHECKING: '检查环境',
  INSTALLING: '安装固定版本',
  CONFIGURING: '配置节点身份',
  STARTING: '启动 Agent',
  VERIFYING: '核验心跳与安卓',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已停止',
  NEEDS_REVIEW: '需要核验',
};
const codes: Record<string, string> = {
  NO_KVM: '未检测到 KVM 设备',
  DISK_LOW: '磁盘剩余空间不足',
  SUDO_REQUIRED: 'sudo 权限或密码不可用',
  UNSUPPORTED_OS: '支持 Ubuntu 24.04 / 26.04 LTS',
  UNSUPPORTED_ARCH: '需要 x86_64',
  SSH_AUTH_FAILED: 'SSH 认证或连接失败',
  SSH_UNREACHABLE: '无法连接 SSH 服务',
  HOST_KEY_MISMATCH: '主机指纹不一致',
  ANDROID_NOT_READY: '安卓环境尚未就绪',
  AGENT_TIMEOUT: '未确认 Agent 就绪',
  INSTALL_IN_PROGRESS: '存在未完成的安装标记',
  WORKER_LOST: '部署 Worker 失联，需核验',
  OK: '检查完成',
  ANSIBLE_FAILED: '部署步骤未完成',
  NODE_OWNERSHIP_CONFLICT: '该主机已属于其他节点',
};
const terminal = (s: string) => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(s);
function describe(e: unknown) {
  return e instanceof Error ? e.message : '操作失败，请重试';
}
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = describe(e);
  } finally {
    busy.value = false;
  }
}
async function all<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: T[]; nextCursor: string | null } = await api(
      path + '?limit=100' + (cursor ? '&cursor=' + cursor : ''),
    );
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
let generation = 0;
async function refresh() {
  const g = ++generation,
    selectedId = selected.value?.id;
  const [ns, rs, ts, cs] = await Promise.all([
    all<NodeView>('/nodes'),
    all<ReleaseRow>('/releases'),
    all<TaskPlanView>('/task-plans'),
    all<{ id: string; name: string }>('/configs'),
  ]);
  if (g !== generation) return;
  nodes.value = ns;
  releases.value = rs;
  taskChoices.value = ts;
  templateConfigs.value = cs;
  releases.value.sort(
    (a, b) =>
      (b.manifest.features?.length ?? 0) - (a.manifest.features?.length ?? 0) ||
      b.manifest.agentVersion.localeCompare(a.manifest.agentVersion, 'en', { numeric: true }),
  );
  if (!releases.value.some((r) => r.id === releaseId.value))
    releaseId.value = releases.value[0]?.id ?? '';
  if (selected.value && selected.value.id === selectedId) {
    const ops = (await api<{ items: Operation[] }>('/deployments?nodeId=' + selectedId)).items;
    if (g !== generation || selected.value?.id !== selectedId) return;
    selected.value = ns.find((n) => n.id === selected.value!.id) ?? null;
    operations.value = ops;
  }
}
const taskFor = (node: NodeView) => preferredTask(node, taskChoices.value, choices[node.id]);
function memory(node: NodeView) {
  const value = node.health?.memoryKiB;
  return node.connection === 'ONLINE' && typeof value === 'number' && value > 0
    ? (value / 1024 ** 2).toFixed(1) + ' GiB 总内存'
    : '内存未知';
}
function deploymentLabel(node: NodeView) {
  return (
    (
      {
        INSTALLED: '已部署',
        NOT_INSTALLED: '未部署',
        INSTALLING: '部署中',
        NEEDS_REVIEW: '待核验',
      } as Record<string, string>
    )[node.deploymentStatus] ?? '待检查'
  );
}
async function configure(node: NodeView, create = false, copyConfigId?: string) {
  await action(async () => {
    const task = create ? undefined : taskFor(node);
    if (node.occupancy !== 'IDLE' || (task && (task.enabled || activeCycle(task))))
      throw Error('请先停止任务并等待清理，再编辑配置');
    editorTask.value = task ? await api<TaskPlanDetail>('/task-plans/' + task.id) : undefined;
    editorCopyConfigId.value = copyConfigId;
    editorNode.value = node;
    visibleLog.value = null;
    await nextTick();
    document
      .querySelector('.server-task-editor')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function chooseTask(node: NodeView, event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  if (id === '__new__') {
    (event.target as HTMLSelectElement).value = taskFor(node)?.id ?? '';
    void configure(node, true);
  } else if (id.startsWith('__copy__:')) {
    (event.target as HTMLSelectElement).value = taskFor(node)?.id ?? '';
    const configId = id.slice('__copy__:'.length);
    if (!templateConfigs.value.some((c) => c.id === configId)) return;
    void configure(node, true, configId);
  } else choices[node.id] = id;
}
async function savedTask(id: string) {
  if (editorNode.value) choices[editorNode.value.id] = id;
  editorNode.value = null;
  editorTask.value = undefined;
  await action(async () => {
    await refresh();
    notice.value = '任务配置已保存。点击该服务器的“开始”执行。';
  });
}
async function startTask(node: NodeView) {
  const task = taskFor(node);
  if (!task) {
    await configure(node, true);
    return;
  }
  if (startReason(node, task)) {
    error.value = startReason(node, task);
    return;
  }
  if (finishedCycle(task)) {
    confirmTask.value = task;
    return;
  }
  await control(task, 'START');
}
async function control(task: TaskPlanView, kind: 'START' | 'NEW_ROUND') {
  await action(async () => {
    const fresh = await api<TaskPlanDetail>('/task-plans/' + task.id);
    if (fresh.task.nodeId !== task.nodeId || fresh.task.version !== task.version) {
      await refresh();
      throw Error('任务配置或状态已变化，请核对后再开始');
    }
    if (!currentFlow(fresh.task)) throw Error('请先将历史流程转换为 APP 打开测试');
    await mutation(
      '/task-plans/' + task.id + '/control',
      { action: kind },
      { 'If-Match': String(task.version) },
    );
    confirmTask.value = null;
    await refresh();
    notice.value = '任务已开启，等待执行端领取；进度与日志会自动更新。';
  });
}
async function stopServer(node: NodeView) {
  await action(async () => {
    const fresh = await api<NodeView>('/nodes/' + node.id);
    if (fresh.activeOperationId)
      await mutation('/deployments/' + fresh.activeOperationId + '/stop', {
        reason: '管理员从服务器页请求停止',
      });
    else {
      const current = (await all<TaskPlanView>('/task-plans')).filter((t) => t.nodeId === node.id);
      const task =
        current.find((t) => ownsRun(t, fresh.activeRunId)) ??
        current.find((t) => t.enabled || activeCycle(t));
      if (fresh.activeRunId && !current.some((t) => ownsRun(t, fresh.activeRunId)))
        await mutation('/runs/' + fresh.activeRunId + '/stop', {
          reason: '管理员从服务器页请求停止',
        });
      else if (task)
        await mutation(
          '/task-plans/' + task.id + '/control',
          { action: 'STOP' },
          { 'If-Match': String(task.version) },
        );
      else throw Error('服务器没有需要停止的任务');
    }
    await refresh();
    notice.value = '停止请求已保存，等待执行端停止与清理确认。';
  });
}
async function manage(node: NodeView, focusDeploy = false) {
  editorNode.value = null;
  visibleLog.value = null;
  await select(node);
  await nextTick();
  const panel =
    focusDeploy && node.expectedFingerprint
      ? managementPanel.value?.querySelector('.deploy-panel')
      : managementPanel.value;
  panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function requestArchive(node: NodeView) {
  await manage(node);
  archiveNodeId.value = node.id;
  await nextTick();
  managementPanel.value
    ?.querySelector('.archive-details')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function checkServer(node: NodeView) {
  selected.value = node;
  editorNode.value = null;
  visibleLog.value = null;
  await start(node.expectedFingerprint ? 'checks' : 'fingerprint-probes');
  await nextTick();
  managementPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function logs(node: NodeView) {
  const id = logRun(node, taskFor(node));
  if (id) {
    visibleLog.value = id;
    editorNode.value = null;
  } else void manage(node);
}

function clearSecrets() {
  form.privateKey = '';
  form.passphrase = '';
  form.password = '';
  form.sudoPassword = '';
}
function openForm(node: NodeView | null) {
  editing.value = true;
  editingId.value = node?.id ?? null;
  editingVersion.value = node?.version ?? 0;
  Object.assign(form, {
    name: node?.name ?? '',
    host: node?.host ?? '',
    port: node?.port ?? 22,
    username: node?.username ?? 'ubuntu',
  });
  clearSecrets();
}
async function keyFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 65536) {
    error.value = '私钥文件不能超过64 KiB';
    return;
  }
  form.privateKey = await file.text();
  (event.target as HTMLInputElement).value = '';
}
async function save() {
  await action(async () => {
    const old = editingId.value ? await api<NodeView>('/nodes/' + editingId.value) : null;
    let credential = old?.credentialVersionId ?? null;
    let sudo = old?.sudoCredentialVersionId ?? null;
    const input: NodeInput = {
      name: form.name,
      host: form.host,
      port: Number(form.port),
      username: form.username,
      credentialVersionId: credential ?? '11111111-1111-4111-8111-111111111111',
      sudoCredentialVersionId: sudo,
    };
    if (schemaIssues('NodeInput', input).length)
      throw Error('请检查服务器名称、地址、端口和 SSH 用户名');
    const hasNew = form.method === 'SSH_KEY' ? !!form.privateKey : !!form.password;
    if (!credential && !hasNew) throw Error('请提供 SSH 私钥或密码');
    if (hasNew) {
      const secret = await api<{ id: string }>('/secrets/versions', 'POST', {
        type: form.method,
        secretValue:
          form.method === 'SSH_KEY'
            ? {
                privateKey: form.privateKey,
                ...(form.passphrase ? { passphrase: form.passphrase } : {}),
              }
            : { password: form.password },
      });
      credential = secret.id;
    }
    if (form.sudoPassword)
      sudo = (
        await api<{ id: string }>('/secrets/versions', 'POST', {
          type: 'SUDO_PASSWORD',
          secretValue: { password: form.sudoPassword },
        })
      ).id;
    input.credentialVersionId = credential!;
    input.sudoCredentialVersionId = sudo;
    selected.value = await api<NodeView>(
      old ? '/nodes/' + old.id : '/nodes',
      old ? 'PATCH' : 'POST',
      input,
      old ? { 'If-Match': String(editingVersion.value) } : {},
    );
    clearSecrets();
    editing.value = false;
    await refresh();
    emit('changed');
    notice.value = '服务器资料已保存，凭据不会回显';
  });
}
async function select(node: NodeView) {
  selected.value = node;
  fingerprint.value = '';
  events.value = [];
  await action(() => refresh());
}
async function start(kind: 'fingerprint-probes' | 'checks') {
  if (!selected.value) return;
  await action(async () => {
    await api(
      '/nodes/' + selected.value!.id + '/' + kind,
      'POST',
      {},
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    await refresh();
    notice.value = '操作已排队，等待部署 Worker 执行';
  });
}
async function trust() {
  if (!selected.value) return;
  await action(async () => {
    const probe = operations.value.find((o) => o.kind === 'PROBE' && o.status === 'SUCCEEDED');
    if (!probe) throw Error('请先完成本次主机指纹探测');
    selected.value = await api<NodeView>(
      '/nodes/' + selected.value!.id + '/host-key',
      'PUT',
      { probeId: probe.id, expectedFingerprint: fingerprint.value },
      { 'If-Match': String(selected.value!.version) },
    );
    fingerprint.value = '';
    await refresh();
    notice.value = '主机身份已确认';
  });
}
async function deploy() {
  if (!selected.value) return;
  await action(async () => {
    if (!licenseAccepted.value || !releaseId.value) throw Error('请选择发布版本并确认 SDK 许可');
    await api(
      '/deployments',
      'POST',
      { nodeId: selected.value!.id, releaseId: releaseId.value, licenseAccepted: true },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    await refresh();
    notice.value = '部署已排队，安装完成后还会核验 Agent 心跳和安卓启动';
  });
}
async function registerRelease() {
  await action(async () => {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText.value);
    } catch {
      throw Error('发布清单 JSON 格式无效');
    }
    if (schemaIssues('ReleaseInput', manifest).length) throw Error('发布清单格式不正确');
    await api('/releases', 'POST', manifest);
    manifestText.value = '';
    await refresh();
    notice.value = '固定发布版本已登记';
  });
}
async function stop(id: string) {
  await action(async () => {
    await api(
      '/deployments/' + id + '/stop',
      'POST',
      { reason: '管理员请求停止' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    await refresh();
    notice.value = '停止请求已记录，等待 Worker 确认';
  });
}
async function showEvents(id: string) {
  await action(async () => {
    events.value = (
      await api<{ items: typeof events.value }>('/deployments/' + id + '/events')
    ).items;
  });
}
async function archive() {
  if (!selected.value) return;
  await action(async () => {
    await api('/nodes/' + selected.value!.id, 'DELETE', undefined, {
      'If-Match': String(selected.value!.version),
    });
    selected.value = null;
    operations.value = [];
    await refresh();
    emit('changed');
    notice.value = '服务器已归档，原操作记录保留';
  });
}
async function reconcile() {
  if (!selected.value) return;
  await action(async () => {
    const check = operations.value.find(
      (o) => o.kind === 'CHECK' && terminal(o.status) && o.result?.markerPresent === false,
    );
    if (!check) throw Error('请先完成新的远程检查，并确认旧安装进程与标记已清除');
    await api(
      '/nodes/' + selected.value!.id + '/reconciliations',
      'POST',
      { checkId: check.id, reason: '管理员已核对远程检查，确认旧安装已结束' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    await refresh();
    notice.value = '服务器隔离已解除';
  });
}
let timer: ReturnType<typeof setInterval> | undefined,
  refreshing = false;
onMounted(() => {
  void action(() => refresh());
  timer = setInterval(() => {
    if (
      busy.value ||
      refreshing ||
      editing.value ||
      editorNode.value ||
      confirmTask.value ||
      document.hidden
    )
      return;
    refreshing = true;
    void refresh()
      .catch((e) => {
        error.value = describe(e);
      })
      .finally(() => {
        refreshing = false;
      });
  }, 3000);
});
onUnmounted(() => {
  generation++;
  clearInterval(timer);
  clearSecrets();
  manifestText.value = '';
});
</script>
<template>
  <div class="server-manager">
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
    <section class="surface">
      <div class="server-toolbar">
        <div>
          <h2>服务器列表</h2>
          <p class="muted">配置、部署、开始、停止和日志集中在这里。首次接入先核验主机身份。</p>
        </div>
        <el-button type="primary" :disabled="busy" @click="openForm(null)">添加服务器</el-button>
      </div>
      <p class="muted">
        选择任务配置后直接开始。每台服务器同时运行一台模拟器，每个 APP 前台停留 10 秒。
      </p>
      <div class="table-scroll server-table-wrap">
        <table class="console-table server-console-table" aria-label="服务器操作列表">
          <thead>
            <tr>
              <th>名称 / 连接</th>
              <th>部署</th>
              <th>运行状态</th>
              <th>任务配置</th>
              <th>CPU / 内存</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="node in nodes" :key="node.id" :aria-label="node.name">
              <td data-label="服务器">
                <strong>{{ node.name }}</strong
                ><small>{{ node.host }}:{{ node.port }} · {{ node.username }}</small
                ><small>Agent {{ node.agentVersion ?? '尚未接入' }}</small>
              </td>
              <td data-label="部署">
                <span
                  :class="['server-status', node.deploymentStatus === 'INSTALLED' ? 'ready' : '']"
                  >{{ deploymentLabel(node) }}</span
                >
              </td>
              <td data-label="运行状态">
                <span
                  :class="['server-status', node.occupancy === 'QUARANTINED' ? 'attention' : '']"
                  >{{ executionLabel(node, taskFor(node)) }}</span
                ><small>{{ node.connection === 'ONLINE' ? '在线' : '离线' }}</small
                ><small v-if="taskFor(node)?.latestCycle"
                  >完成 {{ taskFor(node)?.latestCycle?.successes }} /
                  {{ taskFor(node)?.latestCycle?.successTarget }}</small
                >
              </td>
              <td data-label="任务配置" class="server-task-cell">
                <select
                  :aria-label="node.name + ' 的任务配置'"
                  :value="taskFor(node)?.id ?? ''"
                  :disabled="
                    busy ||
                    node.occupancy !== 'IDLE' ||
                    !!taskFor(node)?.enabled ||
                    (!!taskFor(node) && activeCycle(taskFor(node)!))
                  "
                  @change="chooseTask(node, $event)"
                >
                  <option v-if="!taskFor(node)" value="">请选择或新建配置</option>
                  <option
                    v-for="t in taskChoices.filter((t) => t.nodeId === node.id && !t.archivedAt)"
                    :key="t.id"
                    :value="t.id"
                  >
                    {{ t.name }}{{ !currentFlow(t) ? '（历史流程）' : '' }}
                  </option>
                  <optgroup v-if="templateConfigs.length" label="复制已有配置">
                    <option v-for="c in templateConfigs" :key="c.id" :value="'__copy__:' + c.id">
                      复制：{{ c.name }}
                    </option>
                  </optgroup>
                  <option value="__new__">＋ 新建任务配置</option></select
                ><small v-if="taskFor(node)?.nextRunAt"
                  >下次 {{ when(taskFor(node)?.nextRunAt) }}</small
                ><small v-else-if="taskFor(node)">{{
                  taskFor(node)?.automatic
                    ? '每日 ' + taskFor(node)?.time + '（未开启）'
                    : '手动执行'
                }}</small>
              </td>
              <td data-label="CPU / 内存">
                <small>CPU 未采集</small><small>{{ memory(node) }}</small>
              </td>
              <td data-label="操作">
                <div class="server-row-actions">
                  <el-button
                    :disabled="busy || node.occupancy !== 'IDLE'"
                    @click="manage(node, true)"
                    >部署</el-button
                  >
                  <el-button
                    type="primary"
                    :title="startReason(node, taskFor(node))"
                    :disabled="busy || !!startReason(node, taskFor(node))"
                    @click="startTask(node)"
                    >开始</el-button
                  >
                  <el-button
                    class="stop-task-button"
                    :disabled="
                      busy ||
                      !(
                        node.activeRunId ||
                        node.activeOperationId ||
                        taskFor(node)?.enabled ||
                        (taskFor(node) && activeCycle(taskFor(node)!))
                      ) ||
                      node.activeStopRequested ||
                      taskFor(node)?.latestCycle?.status === 'STOPPING'
                    "
                    @click="stopServer(node)"
                    >{{
                      node.activeStopRequested || taskFor(node)?.latestCycle?.status === 'STOPPING'
                        ? '等待清理'
                        : '停止'
                    }}</el-button
                  >
                  <el-button
                    :disabled="busy || node.occupancy === 'BUSY'"
                    @click="checkServer(node)"
                    >检查</el-button
                  >
                  <el-button :disabled="busy" @click="logs(node)">日志</el-button>
                  <el-button
                    :disabled="
                      busy ||
                      node.occupancy !== 'IDLE' ||
                      !!taskFor(node)?.enabled ||
                      (!!taskFor(node) && activeCycle(taskFor(node)!))
                    "
                    @click="configure(node)"
                    >配置</el-button
                  >
                  <el-button :disabled="busy || node.occupancy !== 'IDLE'" @click="openForm(node)"
                    >连接资料</el-button
                  >
                  <el-button
                    :disabled="busy || node.connection === 'ONLINE' || node.occupancy !== 'IDLE'"
                    title="归档需先停止 Agent 并等待离线，历史记录保留"
                    @click="requestArchive(node)"
                    >归档</el-button
                  >
                </div>
                <small v-if="startReason(node, taskFor(node))" class="server-blocked">{{
                  startReason(node, taskFor(node))
                }}</small>
              </td>
            </tr>
            <tr v-if="!nodes.length">
              <td colspan="6" class="empty-state">尚未接入服务器</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section
      v-if="confirmTask"
      class="surface confirmation-box"
      role="alert"
      aria-label="确认再次开始"
    >
      <h2>再次开始：{{ confirmTask.name }}</h2>
      <p>
        本轮已达到完成目标或尝试上限。确认后新增一轮，目标
        {{ confirmTask.successTarget }} 次，最多尝试 {{ confirmTask.attemptLimit }} 次；复用当天
        APK，历史计数保留。
      </p>
      <el-button type="primary" :disabled="busy" @click="control(confirmTask, 'NEW_ROUND')"
        >确认新增一轮</el-button
      ><el-button :disabled="busy" @click="confirmTask = null">取消</el-button>
    </section>
    <div v-if="editorNode" class="server-task-editor">
      <TaskWizard
        :key="editorNode.id + ':' + (editorTask?.task.id ?? 'new')"
        :initial="editorTask"
        :fixed-node-id="editorNode.id"
        :copy-config-id="editorCopyConfigId"
        compact
        @saved="savedTask"
        @cancel="editorNode = null"
      />
    </div>
    <section v-if="visibleLog" class="surface server-inline-log">
      <el-button @click="visibleLog = null">关闭日志</el-button
      ><RunDetail :key="visibleLog" :run-id="visibleLog" />
    </section>
    <section v-if="editing" class="surface config-form">
      <h2>{{ editingId ? '编辑服务器' : '添加服务器' }}</h2>
      <form @submit.prevent="save">
        <label for="node-name">服务器名称</label
        ><el-input id="node-name" v-model="form.name" maxlength="100" />
        <label for="node-host">IP 或域名</label
        ><el-input id="node-host" v-model="form.host" placeholder="例如 203.0.113.10" />
        <label for="node-port">SSH 端口</label
        ><el-input id="node-port" v-model="form.port" type="number" min="1" max="65535" />
        <label for="node-user">SSH 用户名</label
        ><el-input id="node-user" v-model="form.username" autocomplete="off" />
        <label for="credential-method">连接方式</label
        ><select id="credential-method" v-model="form.method" @change="clearSecrets">
          <option value="SSH_KEY">SSH 私钥</option>
          <option value="SSH_PASSWORD">SSH 密码</option>
        </select>
        <template v-if="form.method === 'SSH_KEY'"
          ><label for="node-key">私钥内容{{ editingId ? '（留空沿用原凭据）' : '' }}</label
          ><textarea
            id="node-key"
            v-model="form.privateKey"
            class="secret-editor"
            autocomplete="off"
            spellcheck="false" /><label for="key-file">或选择私钥文件</label
          ><input id="key-file" type="file" accept=".pem,.key" @change="keyFile" /><label
            for="key-passphrase"
            >私钥口令（可选）</label
          ><el-input
            id="key-passphrase"
            v-model="form.passphrase"
            type="password"
            autocomplete="new-password"
        /></template>
        <template v-else
          ><label for="node-password">SSH 密码{{ editingId ? '（留空沿用原凭据）' : '' }}</label
          ><el-input
            id="node-password"
            v-model="form.password"
            type="password"
            autocomplete="new-password"
        /></template>
        <label for="sudo-password">sudo 密码（免密 sudo 时留空）</label
        ><el-input
          id="sudo-password"
          v-model="form.sudoPassword"
          type="password"
          autocomplete="new-password"
        />
        <div class="form-actions">
          <el-button type="primary" native-type="submit" :loading="busy">保存服务器</el-button
          ><el-button
            @click="
              editing = false;
              clearSecrets();
            "
            >取消</el-button
          >
        </div>
      </form>
    </section>
    <template v-if="selected && !editing">
      <section ref="managementPanel" class="surface">
        <div class="server-toolbar">
          <div>
            <h2>{{ selected.name }}</h2>
            <p class="muted">{{ selected.host }}:{{ selected.port }} · {{ selected.username }}</p>
          </div>
          <el-button :disabled="busy || selected.occupancy !== 'IDLE'" @click="openForm(selected)"
            >编辑资料</el-button
          >
        </div>
        <div class="server-facts">
          <span>Agent：{{ selected.connection === 'ONLINE' ? '在线' : '离线' }}</span
          ><span>版本：{{ selected.agentVersion ?? '尚未接入' }}</span
          ><span>安卓：{{ selected.health?.android ? '启动已核验' : '尚未确认' }}</span
          ><span>主机身份：{{ selected.expectedFingerprint ? '已确认' : '待核对' }}</span>
          <span>执行方式：单模拟器 · APP 前台停留 10 秒</span>
        </div>
        <p v-if="selected.expectedFingerprint" class="fingerprint">
          {{ selected.expectedFingerprint }}
        </p>
        <div class="form-actions">
          <el-button
            :disabled="busy || selected.occupancy === 'BUSY'"
            @click="start('fingerprint-probes')"
            >探测主机指纹</el-button
          ><el-button
            :disabled="busy || !selected.expectedFingerprint || selected.occupancy === 'BUSY'"
            @click="start('checks')"
            >SSH 连接与环境检查</el-button
          ><el-button
            v-if="selected.occupancy === 'QUARANTINED'"
            :disabled="busy"
            @click="reconcile"
            >依据新检查解除隔离</el-button
          >
        </div>
        <div
          v-if="operations.some((o) => o.kind === 'PROBE' && o.status === 'SUCCEEDED')"
          class="trust-panel"
        >
          <p class="muted">
            探测结果只代表本次连接看到的主机。请从可信渠道核对后输入，系统不会自动信任。
          </p>
          <p class="fingerprint">
            本次探测：{{
              operations.find((o) => o.kind === 'PROBE' && o.status === 'SUCCEEDED')?.result
                ?.fingerprint
            }}
          </p>
          <label for="host-fingerprint">核对后的 SHA256 主机指纹</label
          ><el-input id="host-fingerprint" v-model="fingerprint" placeholder="SHA256:…" /><el-button
            class="trust-button"
            :disabled="busy || selected.occupancy !== 'IDLE' || !fingerprint"
            @click="trust"
            >确认主机身份</el-button
          >
        </div>
        <div class="deploy-panel">
          <h3>部署固定版本</h3>
          <label for="release-id">发布版本</label>
          <p class="muted">
            执行节点支持 Ubuntu 24.04 / 26.04 LTS x86_64；选择已登记的签名版本进行部署。
          </p>
          <select id="release-id" v-model="releaseId">
            <option value="">请选择已登记的版本</option>
            <option v-for="r in releases" :key="r.id" :value="r.id">
              {{ r.manifest.agentVersion }} · {{ r.manifest.gitCommit.slice(0, 8) }} ·
              {{ r.id.slice(0, 8) }}
            </option></select
          ><label class="license-label"
            ><input v-model="licenseAccepted" type="checkbox" /> 已阅读并接受
            <a
              href="https://developer.android.com/studio/terms"
              target="_blank"
              rel="noopener noreferrer"
              >Android SDK 许可协议</a
            ></label
          ><el-button
            type="primary"
            :disabled="
              busy ||
              !selected.expectedFingerprint ||
              selected.occupancy !== 'IDLE' ||
              !releaseId ||
              !licenseAccepted
            "
            @click="deploy"
            >一键部署</el-button
          >
        </div>
        <details class="archive-details" :open="archiveNodeId === selected.id">
          <summary>归档服务器</summary>
          <p class="muted">先在服务器停止 Agent，并等待离线。归档会撤销节点身份，保留历史记录。</p>
          <el-button
            :disabled="busy || selected.connection === 'ONLINE' || selected.occupancy !== 'IDLE'"
            @click="archive"
            >确认归档服务器</el-button
          >
        </details>
      </section>
      <section class="surface">
        <h2>部署与检查记录</h2>
        <p class="muted">排队后由独立 Worker 执行。停止请求需等待执行端确认。</p>
        <el-table :data="operations" empty-text="暂无操作"
          ><el-table-column label="操作"
            ><template #default="s">{{
              s.row.kind === 'PROBE' ? '指纹探测' : s.row.kind === 'CHECK' ? '环境检查' : '部署'
            }}</template></el-table-column
          ><el-table-column label="阶段"
            ><template #default="s"
              >{{ stages[s.row.status] ?? s.row.status
              }}{{
                s.row.stopRequested && !terminal(s.row.status) ? ' · 停止待确认' : ''
              }}</template
            ></el-table-column
          ><el-table-column label="结果"
            ><template #default="s">{{
              codes[s.row.errorCode] ?? s.row.errorCode ?? ''
            }}</template></el-table-column
          ><el-table-column label="操作"
            ><template #default="s"
              ><el-button text @click="showEvents(s.row.id)">步骤</el-button
              ><el-button
                v-if="!terminal(s.row.status)"
                text
                :disabled="busy || s.row.stopRequested"
                @click="stop(s.row.id)"
                >停止部署</el-button
              ></template
            ></el-table-column
          ></el-table
        >
        <ol v-if="events.length" class="operation-events">
          <li v-for="event in events" :key="event.sequence">
            {{ stages[event.status] ?? event.status }} · {{ codes[event.code] ?? event.code }}
          </li>
        </ol>
        <div
          v-for="op in operations.filter((o) => o.kind === 'CHECK' && o.result).slice(0, 1)"
          :key="op.id"
          class="inspection"
        >
          <h3>最近远程检查</h3>
          <p>
            系统：{{ op.result?.ubuntu }} · 架构：{{ op.result?.arch }} · KVM 设备：{{
              op.result?.kvm ? '已发现' : '未发现'
            }}
            · 剩余磁盘：{{ Math.floor(Number(op.result?.freeDiskBytes ?? 0) / 1024 ** 3) }} GiB
          </p>
          <p class="muted">
            远程检查不等于安卓启动验收；安卓状态以本次部署启动检查和 Agent 心跳为准。
          </p>
        </div>
      </section>
    </template>
    <details class="surface">
      <summary>历史程序版本：归档、恢复与删除</summary>
      <MaintenanceManager />
    </details>
    <section class="surface">
      <details>
        <summary>登记签名发布版本</summary>
        <p class="muted">
          在中台服务器生成发布构件后，将对应 manifest.json 粘贴到这里。服务端将校验签名及本地构件。
        </p>
        <label for="release-manifest">签名发布清单 JSON</label
        ><textarea
          id="release-manifest"
          v-model="manifestText"
          class="json-editor"
          spellcheck="false"
        />
        <div class="form-actions">
          <el-button :disabled="busy || !manifestText" @click="registerRelease"
            >登记发布版本</el-button
          >
        </div>
      </details>
    </section>
  </div>
</template>
