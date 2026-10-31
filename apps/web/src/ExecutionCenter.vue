<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import type { NodeView, ConsoleRunListView, TestConfiguration } from '@apk/contracts';
import { api, mutation } from './api';
import { href, route, navigate } from './navigation';
import { today, when, stateLabels } from './console-format';
import { purposeLabels, reasonLabels } from './result-labels';
import DailySchedulePanel from './DailySchedulePanel.vue';
const tab = ref(route.value.query.get('tab') ?? 'history'),
  nodes = ref<NodeView[]>([]),
  configs = ref<{ id: string; name: string }[]>([]),
  versions = ref<{ id: string; version: number }[]>([]),
  runs = ref<ConsoleRunListView['items']>([]),
  downloads = ref<ConsoleRunListView['items']>([]),
  cursor = ref<string | null>(null),
  history = ref(false);
const nodeId = ref(''),
  configId = ref(''),
  versionId = ref(''),
  purpose = ref('DOWNLOAD'),
  sourceDownloadId = ref(''),
  successTarget = ref(10),
  attemptLimit = ref(30),
  body = ref<TestConfiguration | null>(null),
  busy = ref(false),
  error = ref('');
const legacyTools = ref(['create', 'plans'].includes(route.value.query.get('tab') ?? ''));
const listKind = ref(route.value.query.get('executionKind') ?? ''),
  listDay = ref(route.value.query.get('day') ?? '');
const listPurpose = ref(route.value.query.get('purpose') ?? ''),
  listStatus = ref(route.value.query.get('status') ?? '');
const node = computed(() => nodes.value.find((n) => n.id === nodeId.value)),
  releaseId = computed(() => node.value?.agentReleaseId ?? '');
const unavailable = computed(() =>
  !node.value
    ? '请选择执行服务器'
    : node.value.connection !== 'ONLINE'
      ? '服务器尚未在线'
      : node.value.occupancy !== 'IDLE'
        ? '服务器被任务占用或等待核验'
        : !releaseId.value
          ? '服务器尚未部署'
          : !versionId.value
            ? '请选择配置版本'
            : purpose.value === 'REGISTER' && body.value?.execution.mode !== 'FULL'
              ? '注册需要已设置代理的完整方案'
              : purpose.value === 'REGISTER' &&
                  (!node.value.health?.android || node.value.registrationProtocol !== '1.0')
                ? '服务器的安卓注册环境尚未就绪'
                : purpose.value === 'REGISTER' && !sourceDownloadId.value
                  ? '请先完成当前方案当天的 APK 下载'
                  : purpose.value === 'REGISTER' &&
                      (successTarget.value < 1 ||
                        attemptLimit.value < successTarget.value ||
                        attemptLimit.value > 1000)
                    ? '请核对成功目标及尝试上限'
                    : '',
);
async function work(fn: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
async function loadRuns(append = false) {
  const query = new URLSearchParams({
    limit: '30',
    ...(listKind.value ? { executionKind: listKind.value } : {}),
    ...(listDay.value ? { cacheDay: listDay.value } : {}),
    ...(listPurpose.value ? { purpose: listPurpose.value } : {}),
    ...(listStatus.value ? { status: listStatus.value } : {}),
    ...(append && cursor.value ? { cursor: cursor.value } : {}),
  });
  const p = await api<ConsoleRunListView>('/console/runs?' + query);
  runs.value = append ? [...runs.value, ...p.items] : p.items;
  cursor.value = p.nextCursor;
  history.value = append;
}
async function choices() {
  [nodes.value, configs.value] = await Promise.all([
    api<{ items: NodeView[] }>('/nodes?limit=100').then((p) => p.items),
    api<{ items: typeof configs.value }>('/configs?limit=100').then((p) => p.items),
  ]);
}
async function loadVersions() {
  versionId.value = '';
  body.value = null;
  downloads.value = [];
  sourceDownloadId.value = '';
  versions.value = configId.value
    ? (
        await api<{ items: typeof versions.value }>(
          '/configs/' + configId.value + '/versions?limit=100',
        )
      ).items
    : [];
}
async function loadDownload() {
  sourceDownloadId.value = '';
  downloads.value = [];
  if (!nodeId.value || !versionId.value) return;
  const p = await api<ConsoleRunListView>(
    '/console/runs?' +
      new URLSearchParams({
        purpose: 'DOWNLOAD',
        nodeId: nodeId.value,
        configVersionId: versionId.value,
        cacheDay: today(),
        limit: '100',
      }),
  );
  downloads.value = p.items.filter((r) => ['SUCCEEDED', 'PARTIAL_FAILED'].includes(r.status));
  if (downloads.value.length === 1) sourceDownloadId.value = downloads.value[0].id;
}
async function loadVersion() {
  body.value = versionId.value
    ? (
        await api<{ body: TestConfiguration }>(
          '/configs/' + configId.value + '/versions/' + versionId.value,
        )
      ).body
    : null;
  await loadDownload();
}
async function start() {
  if (unavailable.value) return;
  await work(async () => {
    const r = await mutation<{ resourceId: string }>('/runs', {
      nodeId: nodeId.value,
      configVersionId: versionId.value,
      releaseId: releaseId.value,
      ...(purpose.value !== 'LEGACY' ? { purpose: purpose.value } : {}),
      ...(purpose.value === 'REGISTER'
        ? {
            sourceDownloadId: sourceDownloadId.value,
            successTarget: successTarget.value,
            attemptLimit: attemptLimit.value,
          }
        : {}),
    });
    navigate('runs', r.resourceId);
  });
}
function selectTab(value: string) {
  tab.value = value;
  navigate('runs', '', {
    tab: value,
    ...(listPurpose.value ? { purpose: listPurpose.value } : {}),
    ...(listStatus.value ? { status: listStatus.value } : {}),
  });
}
watch(
  () => route.value.key,
  () => {
    tab.value = route.value.query.get('tab') ?? 'create';
    listKind.value = route.value.query.get('executionKind') ?? '';
    listDay.value = route.value.query.get('day') ?? '';
    listPurpose.value = route.value.query.get('purpose') ?? '';
    listStatus.value = route.value.query.get('status') ?? '';
    void work(() => loadRuns());
  },
);
let timer: ReturnType<typeof setInterval> | undefined,
  refreshing = false;
onMounted(() => {
  void work(async () => {
    await choices();
    await loadRuns();
  });
  timer = setInterval(() => {
    if (busy.value || refreshing || document.hidden) return;
    refreshing = true;
    void choices()
      .then(() => (!history.value ? loadRuns() : undefined))
      .catch((e) => {
        error.value = e instanceof Error ? e.message : '刷新失败';
      })
      .finally(() => {
        refreshing = false;
      });
  }, 5000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <div class="console-stack">
    <div class="toolbar">
      <a :href="href('nodes')">← 返回服务器工作台</a
      ><el-button text @click="legacyTools = !legacyTools">历史兼容工具</el-button>
    </div>
    <div v-if="legacyTools" class="section-tabs" role="tablist" aria-label="执行任务分区">
      <button
        :class="{ active: tab === 'create' }"
        role="tab"
        :aria-selected="tab === 'create'"
        @click="selectTab('create')"
      >
        新建执行</button
      ><button
        :class="{ active: tab === 'history' }"
        role="tab"
        :aria-selected="tab === 'history'"
        @click="selectTab('history')"
      >
        执行历史</button
      ><button
        :class="{ active: tab === 'plans' }"
        role="tab"
        :aria-selected="tab === 'plans'"
        @click="selectTab('plans')"
      >
        每日计划
      </button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <section v-if="tab !== 'history'" class="surface config-form">
      <span class="phase-tag">{{ tab === 'plans' ? '计划绑定信息' : '执行准备' }}</span>
      <h2>{{ tab === 'plans' ? '选择计划的服务器与方案' : '开始测试任务' }}</h2>
      <p class="muted">
        旧版兼容工具。日常下载与 APP
        打开测试请在服务器列表开始，历史批次和未知结果保留原有处理规则。
      </p>
      <div class="filter-grid">
        <label for="run-node"
          >执行服务器<select
            id="run-node"
            aria-label="执行服务器"
            v-model="nodeId"
            @change="work(loadDownload)"
          >
            <option value="">请选择服务器</option>
            <option v-for="n in nodes" :key="n.id" :value="n.id">
              {{ n.name }} · {{ n.connection === 'ONLINE' ? '在线' : '离线' }} ·
              {{ n.occupancy === 'IDLE' ? '空闲' : '占用或待核验' }}
            </option>
          </select></label
        ><label for="run-config"
          >任务配置<select
            id="run-config"
            aria-label="任务配置"
            v-model="configId"
            @change="work(loadVersions)"
          >
            <option value="">请选择任务方案</option>
            <option v-for="c in configs" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select></label
        ><label for="run-version"
          >固定配置版本<select
            id="run-version"
            aria-label="固定配置版本"
            v-model="versionId"
            @change="work(loadVersion)"
          >
            <option value="">请选择版本</option>
            <option v-for="v in versions" :key="v.id" :value="v.id">版本 {{ v.version }}</option>
          </select></label
        >
      </div>
      <div v-if="node && versionId" class="selection-summary">
        绑定服务器：{{ node.name }} · 方案：{{ configs.find((c) => c.id === configId)?.name }} ·
        版本 {{ versions.find((v) => v.id === versionId)?.version }} ·
        {{
          body?.execution.appOpen
            ? '下载并打开 APP'
            : body?.execution.mode === 'FULL'
              ? '历史账户流程'
              : '仅下载'
        }}<small v-if="body?.execution.mode === 'FULL' && !body.execution.appOpen"
          >注册方式：{{
            body.execution.autoRegistration?.enabled
              ? '自动寻找入口，手工流程优先'
              : '按已配置手工流程'
          }}</small
        >
      </div>
      <template v-if="tab === 'create'"
        ><label for="run-purpose"
          >执行内容<select id="run-purpose" aria-label="执行内容" v-model="purpose">
            <option value="DOWNLOAD">仅下载当天 APK（每天一次）</option>
            <option value="REGISTER">
              {{ body?.execution.appOpen ? '复用当天 APK 打开测试' : '旧版账户流程' }}
            </option>
            <option value="LEGACY">旧版单次流程</option>
          </select></label
        >
        <div v-if="purpose === 'REGISTER'" class="registration-options">
          <label for="run-source"
            >当天已完成的下载批次<select
              id="run-source"
              aria-label="当天已完成的下载批次"
              v-model="sourceDownloadId"
            >
              <option value="">请选择当前服务器、当前方案当天的下载批次</option>
              <option v-for="d in downloads" :key="d.id" :value="d.id">
                {{ d.cacheDay }} · {{ d.configName }} · {{ d.id.slice(0, 8) }}
              </option>
            </select></label
          >
          <div class="filter-grid">
            <label for="run-target"
              >所有 APK 合计成功目标<input
                id="run-target"
                v-model.number="successTarget"
                type="number"
                min="1"
                max="1000" /></label
            ><label for="run-limit"
              >总尝试上限<input
                id="run-limit"
                v-model.number="attemptLimit"
                type="number"
                :min="successTarget"
                max="1000"
            /></label>
          </div>
          <p class="muted">
            注册复用已下载 APK，每轮使用独立模拟器。结果未知时暂停核验，不重复提交。
          </p>
        </div>
        <p v-if="unavailable" class="readiness-hint">{{ unavailable }}</p>
        <el-button type="primary" :disabled="busy || !!unavailable" @click="start">{{
          body?.execution.appOpen
            ? '开始 APP 测试'
            : purpose === 'REGISTER'
              ? '开始循环注册'
              : purpose === 'LEGACY' && body?.execution.mode === 'FULL'
                ? '开始安装注册'
                : '开始下载'
        }}</el-button></template
      >
    </section>
    <DailySchedulePanel
      v-if="tab === 'plans'"
      :node-id="nodeId"
      :config-version-id="versionId"
      :release-id="releaseId"
      :nodes="nodes"
      :show-proxy="false"
    />
    <section v-if="tab === 'history'" class="surface">
      <div class="section-heading">
        <h2>执行历史</h2>
        <el-button :disabled="busy" @click="work(() => loadRuns())">刷新最新</el-button>
      </div>
      <form
        class="toolbar"
        @submit.prevent="
          navigate('runs', '', {
            tab: 'history',
            purpose: listPurpose,
            status: listStatus,
            executionKind: listKind,
            day: listDay,
          })
        "
      >
        <label
          >流程<select v-model="listKind">
            <option value="">全部流程</option>
            <option value="APP_OPEN">APP 打开测试</option>
            <option value="DOWNLOAD_ONLY">APK 下载</option>
            <option value="REGISTRATION">历史账户流程</option>
          </select></label
        >
        <label>APK 业务日期<input v-model="listDay" type="date" /></label>
        <label
          >执行类型<select v-model="listPurpose">
            <option value="">全部类型</option>
            <option v-for="(label, key) in purposeLabels" :key="key" :value="key">
              {{ key === 'REGISTER' ? 'APP 执行（含历史流程）' : label }}
            </option>
          </select></label
        ><label
          >批次状态<select v-model="listStatus">
            <option value="">全部状态</option>
            <option
              v-for="s in [
                'RUNNING',
                'STOP_REQUESTED',
                'SUCCEEDED',
                'PARTIAL_FAILED',
                'FAILED',
                'NEEDS_REVIEW',
                'CANCELLED',
              ]"
              :key="s"
              :value="s"
            >
              {{ stateLabels[s] }}
            </option>
          </select></label
        ><el-button native-type="submit">筛选执行</el-button>
      </form>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>方案 / 时间</th>
              <th>服务器</th>
              <th>执行内容</th>
              <th>状态</th>
              <th>成功 / 尝试</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td>
                {{ r.configName }} · v{{ r.configVersion }}<small>{{ when(r.createdAt) }}</small>
              </td>
              <td>{{ r.nodeName }}</td>
              <td>
                {{
                  r.executionKind === 'APP_OPEN'
                    ? 'APP 启动停留'
                    : (purposeLabels[r.purpose] ?? r.purpose)
                }}
              </td>
              <td>
                {{ stateLabels[r.status] ?? r.status
                }}<small>{{ r.errorCode ? (reasonLabels[r.errorCode] ?? r.errorCode) : '' }}</small>
              </td>
              <td>
                {{
                  r.purpose === 'REGISTER'
                    ? (r.executionKind === 'APP_OPEN' ? '完成轮数 ' : '成功账户 ') +
                      r.successes +
                      ' / ' +
                      r.successTarget +
                      ' · 尝试 ' +
                      r.attemptsStarted
                    : '—'
                }}
              </td>
              <td><a :href="href('runs', r.id)">查看详情与日志</a></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!runs.length" class="empty-state">暂无符合条件的执行记录。</p>
      <el-button v-if="cursor" :disabled="busy" @click="work(() => loadRuns(true))"
        >加载更多执行</el-button
      >
    </section>
  </div>
</template>
