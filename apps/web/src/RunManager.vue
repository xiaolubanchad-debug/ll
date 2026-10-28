<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import TaskEvidence from './TaskEvidence.vue';
import DailySchedulePanel from './DailySchedulePanel.vue';
import { purposeLabels, reasonLabels } from './result-labels';
import { api, mutation } from './api';
import type { NodeView } from '@apk/contracts';
const nodes = ref<NodeView[]>([]),
  configs = ref<{ id: string; name: string }[]>([]),
  versions = ref<{ id: string; version: number }[]>([]),
  runs = ref<
    {
      id: string;
      status: string;
      nodeId: string;
      purpose: string;
      cacheDay: string | null;
      createdAt: string;
    }[]
  >([]);
const purpose = ref('DOWNLOAD'),
  sourceDownloadId = ref(''),
  successTarget = ref(10),
  attemptLimit = ref(30);
const releaseId = computed(
  () => nodes.value.find((n) => n.id === nodeId.value)?.agentReleaseId ?? '',
);
const downloads = computed(() =>
  runs.value.filter(
    (r) =>
      r.nodeId === nodeId.value &&
      r.purpose === 'DOWNLOAD' &&
      r.cacheDay ===
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()) &&
      ['SUCCEEDED', 'PARTIAL_FAILED'].includes(r.status),
  ),
);
const nodeId = ref(''),
  configId = ref(''),
  versionId = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  cursor = ref<string | null>(null);
const mode = ref('DOWNLOAD_ONLY'),
  evidenceId = ref('');
const evidenceTask = computed(() => tasks.value.find((t) => t.id === evidenceId.value));
async function loadMode() {
  await action(async () => {
    mode.value = versionId.value
      ? (
          await api<{ body: { execution: { mode: string } } }>(
            '/configs/' + configId.value + '/versions/' + versionId.value,
          )
        ).body.execution.mode
      : 'DOWNLOAD_ONLY';
  });
}
interface Run {
  id: string;
  status: string;
  configVersionId: string;
  releaseId: string;
  stopRequested: boolean;
  errorCode: string | null;
  purpose: string;
  successTarget: number;
  attemptLimit: number;
  attemptsStarted: number;
  successes: number;
  proxyObservation?: { status: string; ip?: string; scope?: string };
}
const selected = ref<Run | null>(null),
  tasks = ref<
    {
      id: string;
      label: string;
      entryId?: string | null;
      status: string;
      cacheHit: boolean;
      errorCode: string | null;
      apk: { packageName: string; apkSha256: string; cacheDay: string } | null;
      observation?: {
        model: string;
        locale: string;
        shellAndroidIdHash: string;
        proxyObservedIp: string;
        proxyObservedAt: string;
      };
      reviews?: { outcome: string; reason: string }[];
    }[]
  >([]),
  taskCursor = ref<string | null>(null),
  events = ref<
    { id: string; sequence: number; recordedForReview: boolean; body: { type: string } }[]
  >([]);
const status: Record<string, string> = {
  QUEUED: '等待领取',
  ASSIGNED: '等待接收确认',
  RUNNING: '执行中',
  STOP_REQUESTED: '停止待确认',
  SUCCEEDED: '已完成',
  PARTIAL_FAILED: '部分失败',
  FAILED: '失败',
  CANCELLED: '已停止',
  NEEDS_REVIEW: '待核验',
  DOWNLOADING: '正在下载',
  DOWNLOADED: '文件已校验',
  SKIPPED: '已跳过',
  PREPARING: '准备模拟器',
  INSTALLING: '正在安装',
  LAUNCHING: '正在启动',
  REGISTERING: '填写注册流程',
  VERIFYING: '核验提交结果',
  UNKNOWN: '注册结果未知',
};
async function action(work: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
async function details(append = false) {
  if (!selected.value) return;
  selected.value = await api<Run>('/runs/' + selected.value.id);
  const p = await api<{ items: typeof tasks.value; nextCursor: string | null }>(
    '/runs/' +
      selected.value.id +
      '/tasks?limit=100' +
      (append && taskCursor.value ? '&cursor=' + taskCursor.value : ''),
  );
  tasks.value = append ? [...tasks.value, ...p.items] : p.items;
  taskCursor.value = p.nextCursor;
  events.value = (
    await api<{ items: typeof events.value }>('/runs/' + selected.value.id + '/events?limit=100')
  ).items;
}
async function refresh(append = false) {
  nodes.value = (await api<{ items: NodeView[] }>('/nodes?limit=100')).items;
  configs.value = (await api<{ items: typeof configs.value }>('/configs?limit=100')).items;
  const p = await api<{ items: typeof runs.value; nextCursor: string | null }>(
    '/runs?limit=100' + (append && cursor.value ? '&cursor=' + cursor.value : ''),
  );
  runs.value = append ? [...runs.value, ...p.items] : p.items;
  cursor.value = p.nextCursor;
  if (selected.value) await details();
}
async function loadVersions() {
  versionId.value = '';
  if (!configId.value) {
    versions.value = [];
    return;
  }
  await action(async () => {
    versions.value = (
      await api<{ items: typeof versions.value }>(
        '/configs/' + configId.value + '/versions?limit=100',
      )
    ).items;
  });
}
async function start() {
  await action(async () => {
    const node = nodes.value.find((n) => n.id === nodeId.value);
    if (!node?.agentReleaseId) throw Error('请选择已部署的执行服务器');
    const created = await mutation<{ resourceId: string }>('/runs', {
      nodeId: node.id,
      configVersionId: versionId.value,
      releaseId: node.agentReleaseId,
      ...(purpose.value !== 'LEGACY' ? { purpose: purpose.value } : {}),
      ...(purpose.value === 'REGISTER'
        ? {
            sourceDownloadId: sourceDownloadId.value,
            successTarget: successTarget.value,
            attemptLimit: attemptLimit.value,
          }
        : {}),
    });
    selected.value = await api<Run>('/runs/' + created.resourceId);
    await refresh();
    notice.value =
      purpose.value === 'REGISTER' || (purpose.value === 'LEGACY' && mode.value === 'FULL')
        ? '完整测试已建立，将创建测试账户并保留执行证据'
        : '下载任务已建立，将使用固定配置版本';
  });
}
async function stop() {
  if (!selected.value) return;
  await action(async () => {
    await mutation('/runs/' + selected.value!.id + '/stop', { reason: '管理员请求停止任务' });
    await refresh();
    notice.value = '停止请求已记录，须等待节点确认清理完成';
  });
}
async function reconcile() {
  if (!selected.value) return;
  await action(async () => {
    await mutation('/runs/' + selected.value!.id + '/reconciliations', {
      reason: '管理员核验节点清理结果及新心跳',
    });
    await refresh();
    notice.value = '已记录核验并解除服务器占用，原批次状态保持';
  });
}
let timer: ReturnType<typeof setInterval> | undefined,
  refreshing = false;
onMounted(() => {
  void action(() => refresh());
  timer = setInterval(() => {
    if (busy.value || refreshing) return;
    refreshing = true;
    void refresh()
      .catch((e) => {
        error.value = e instanceof Error ? e.message : '刷新失败';
      })
      .finally(() => {
        refreshing = false;
      });
  }, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <div class="server-manager">
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <section class="surface config-form">
      <h2>开始测试任务</h2>
      <p class="muted">
        根据固定配置版本执行下载或完整安装注册。每个服务器串行执行，同日缓存命中仍会复核文件。
      </p>
      <label for="run-node">执行服务器</label
      ><select id="run-node" v-model="nodeId">
        <option value="">请选择在线且空闲的服务器</option>
        <option
          v-for="node in nodes"
          :key="node.id"
          :value="node.id"
          :disabled="
            node.connection !== 'ONLINE' ||
            node.occupancy !== 'IDLE' ||
            node.downloadProtocol !== '1.0'
          "
        >
          {{ node.name }} · {{ node.connection === 'ONLINE' ? '在线' : '离线' }} ·
          {{ node.downloadProtocol === '1.0' ? '支持下载' : '需升级' }}
        </option></select
      ><label for="run-config">任务配置</label
      ><select id="run-config" v-model="configId" @change="loadVersions">
        <option value="">请选择已保存的配置</option>
        <option v-for="c in configs" :key="c.id" :value="c.id">{{ c.name }}</option></select
      ><label for="run-version">固定配置版本</label
      ><select id="run-version" v-model="versionId" @change="loadMode">
        <option value="">请选择版本</option>
        <option v-for="v in versions" :key="v.id" :value="v.id">版本 {{ v.version }}</option>
      </select>
      <label for="run-purpose">执行内容</label
      ><select id="run-purpose" v-model="purpose">
        <option value="DOWNLOAD">仅下载当天 APK（每天一次）</option>
        <option value="REGISTER">复用当天 APK 循环注册</option>
        <option value="LEGACY">旧版单次流程</option>
      </select>
      <template v-if="purpose === 'REGISTER'">
        <label for="run-source">当天已完成的下载批次</label
        ><select id="run-source" v-model="sourceDownloadId">
          <option value="">请选择下载批次</option>
          <option v-for="d in downloads" :key="d.id" :value="d.id">
            {{ d.cacheDay }} · {{ d.id.slice(0, 8) }}
          </option>
        </select>
        <label for="run-target">所有 APK 合计成功目标</label
        ><input id="run-target" v-model.number="successTarget" type="number" min="1" max="1000" />
        <label for="run-limit">总尝试上限</label
        ><input
          id="run-limit"
          v-model.number="attemptLimit"
          type="number"
          :min="successTarget"
          max="1000"
        />
      </template>
      <p v-if="purpose === 'REGISTER' || (purpose === 'LEGACY' && mode === 'FULL')" class="muted">
        完整测试会实际安装 APK 并创建账户，提交结果未知时暂停本批次并等待人工核验。
      </p>
      <div class="form-actions">
        <el-button
          type="primary"
          :disabled="
            busy ||
            !nodeId ||
            !versionId ||
            (purpose === 'REGISTER' &&
              (!sourceDownloadId ||
                successTarget < 1 ||
                attemptLimit < successTarget ||
                attemptLimit > 1000))
          "
          @click="start"
          >{{
            purpose === 'REGISTER'
              ? '开始循环注册'
              : purpose === 'LEGACY' && mode === 'FULL'
                ? '开始安装注册'
                : '开始下载'
          }}</el-button
        >
      </div>
    </section>
    <DailySchedulePanel
      :node-id="nodeId"
      :config-version-id="versionId"
      :release-id="releaseId"
      :nodes="nodes"
    />
    <section class="surface">
      <h2>测试任务列表</h2>
      <el-table :data="runs" empty-text="暂无测试任务"
        ><el-table-column prop="id" label="批次编号" /><el-table-column label="状态"
          ><template #default="s">{{
            status[s.row.status] ?? s.row.status
          }}</template></el-table-column
        ><el-table-column label="操作"
          ><template #default="s"
            ><el-button
              text
              @click="
                action(async () => {
                  selected = await api('/runs/' + s.row.id);
                  await details();
                })
              "
              >查看任务</el-button
            ></template
          ></el-table-column
        ></el-table
      ><el-button v-if="cursor" text @click="action(() => refresh(true))">加载更多任务</el-button>
    </section>
    <section v-if="selected" class="surface">
      <h2>批次结果</h2>
      <p class="fingerprint">{{ selected.id }}</p>
      <p>
        {{ purposeLabels[selected.purpose] ?? '测试任务' }} · 状态：{{
          status[selected.status] ?? selected.status
        }}
        {{ reasonLabels[selected.errorCode ?? ''] ?? selected.errorCode ?? '' }}
      </p>
      <p v-if="selected.purpose === 'REGISTER'">
        成功 {{ selected.successes }} / {{ selected.successTarget }} · 已尝试
        {{ selected.attemptsStarted }} / {{ selected.attemptLimit }}
      </p>
      <p v-if="selected.proxyObservation">
        代理检查：{{ selected.proxyObservation.status === 'SUCCEEDED' ? '通过' : '失败' }} ·
        本次探测出口 {{ selected.proxyObservation.ip ?? '—' }}
      </p>
      <p class="muted">配置版本：{{ selected.configVersionId }} · 发布：{{ selected.releaseId }}</p>
      <div class="form-actions">
        <el-button
          v-if="['QUEUED', 'ASSIGNED', 'RUNNING', 'STOP_REQUESTED'].includes(selected.status)"
          :disabled="busy || selected.stopRequested"
          @click="stop"
          >停止任务</el-button
        ><el-button v-if="selected.status === 'NEEDS_REVIEW'" :disabled="busy" @click="reconcile"
          >核验清理后解除占用</el-button
        >
      </div>
      <p v-if="selected.status === 'NEEDS_REVIEW'" class="muted">
        确认节点已清理并收到新的空闲心跳；存在未知注册任务时，须先逐项记录人工核验决议。系统不会自动重跑。
      </p>
      <el-table :data="tasks" empty-text="尚未发现目标"
        ><el-table-column prop="label" label="入口" /><el-table-column
          prop="entryId"
          label="入口 PID"
        /><el-table-column label="结果"
          ><template #default="s"
            >{{
              selected.purpose === 'REGISTER' && s.row.status === 'DOWNLOADING'
                ? '读取当天缓存'
                : (status[s.row.status] ?? s.row.status)
            }}
            {{ reasonLabels[s.row.errorCode ?? ''] ?? s.row.errorCode ?? '' }}</template
          ></el-table-column
        ><el-table-column label="APK"
          ><template #default="s"
            >{{ s.row.apk?.packageName ?? '—'
            }}<small v-if="s.row.apk">
              · {{ s.row.apk.cacheDay }} ·
              {{ s.row.cacheHit ? '复用已校验缓存' : '本次下载' }}</small
            ></template
          ></el-table-column
        ><el-table-column label="摘要"
          ><template #default="s">{{
            s.row.apk?.apkSha256.slice(0, 16) ?? '—'
          }}</template></el-table-column
        ><el-table-column label="证据与账户"
          ><template #default="s"
            ><el-button text @click="evidenceId = s.row.id">查看注册证据</el-button></template
          ></el-table-column
        ></el-table
      ><el-button v-if="taskCursor" text @click="action(() => details(true))"
        >加载更多目标</el-button
      >
      <details>
        <summary>执行事件</summary>
        <ol>
          <li v-for="event in events" :key="event.id">
            {{ event.sequence }} · {{ event.body.type }}
            {{ event.recordedForReview ? '（迟到核验证据）' : '' }}
          </li>
        </ol>
      </details>
    </section>
    <TaskEvidence
      v-if="evidenceTask"
      :key="evidenceTask.id"
      :task="evidenceTask"
      @updated="action(() => details())"
    />
  </div>
</template>
