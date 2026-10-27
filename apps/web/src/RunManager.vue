<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api, mutation } from './api';
import type { NodeView } from '@apk/contracts';
const nodes = ref<NodeView[]>([]),
  configs = ref<{ id: string; name: string }[]>([]),
  versions = ref<{ id: string; version: number }[]>([]),
  runs = ref<{ id: string; status: string; nodeId: string }[]>([]);
const nodeId = ref(''),
  configId = ref(''),
  versionId = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  cursor = ref<string | null>(null);
interface Run {
  id: string;
  status: string;
  configVersionId: string;
  releaseId: string;
  stopRequested: boolean;
  errorCode: string | null;
}
const selected = ref<Run | null>(null),
  tasks = ref<
    {
      id: string;
      label: string;
      status: string;
      cacheHit: boolean;
      errorCode: string | null;
      apk: { packageName: string; apkSha256: string; cacheDay: string } | null;
    }[]
  >([]),
  taskCursor = ref<string | null>(null),
  events = ref<
    { id: string; sequence: number; recordedForReview: boolean; body: { type: string } }[]
  >([]);
const status: Record<string, string> = {
  QUEUED: '等待领取',
  ASSIGNED: '等待接收确认',
  RUNNING: '下载中',
  STOP_REQUESTED: '停止待确认',
  SUCCEEDED: '已完成',
  PARTIAL_FAILED: '部分失败',
  FAILED: '失败',
  CANCELLED: '已停止',
  NEEDS_REVIEW: '待核验',
  DOWNLOADING: '正在下载',
  DOWNLOADED: '文件已校验',
  SKIPPED: '已跳过',
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
    '/runs' + (append && cursor.value ? '?cursor=' + cursor.value : ''),
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
    });
    selected.value = await api<Run>('/runs/' + created.resourceId);
    await refresh();
    notice.value = '下载任务已建立，将使用固定配置版本';
  });
}
async function stop() {
  if (!selected.value) return;
  await action(async () => {
    await mutation('/runs/' + selected.value!.id + '/stop', { reason: '管理员请求停止下载' });
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
      <h2>开始下载任务</h2>
      <p class="muted">仅下载与文件校验。每个服务器串行执行，同日缓存命中仍会复核文件。</p>
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
      ><select id="run-version" v-model="versionId">
        <option value="">请选择版本</option>
        <option v-for="v in versions" :key="v.id" :value="v.id">版本 {{ v.version }}</option>
      </select>
      <div class="form-actions">
        <el-button type="primary" :disabled="busy || !nodeId || !versionId" @click="start"
          >开始下载</el-button
        >
      </div>
    </section>
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
      <p>状态：{{ status[selected.status] ?? selected.status }} {{ selected.errorCode ?? '' }}</p>
      <p class="muted">配置版本：{{ selected.configVersionId }} · 发布：{{ selected.releaseId }}</p>
      <div class="form-actions">
        <el-button
          v-if="['QUEUED', 'ASSIGNED', 'RUNNING', 'STOP_REQUESTED'].includes(selected.status)"
          :disabled="busy || selected.stopRequested"
          @click="stop"
          >停止下载</el-button
        ><el-button v-if="selected.status === 'NEEDS_REVIEW'" :disabled="busy" @click="reconcile"
          >核验清理后解除占用</el-button
        >
      </div>
      <p v-if="selected.status === 'NEEDS_REVIEW'" class="muted">
        先重启节点服务，确认旧浏览器已清理并收到新的空闲心跳，再进行人工核验。系统不会自动重跑。
      </p>
      <el-table :data="tasks" empty-text="尚未发现目标"
        ><el-table-column prop="label" label="入口" /><el-table-column label="结果"
          ><template #default="s"
            >{{ status[s.row.status] ?? s.row.status }} {{ s.row.errorCode ?? '' }}</template
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
  </div>
</template>
