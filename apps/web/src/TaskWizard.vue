<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import type {
  TaskPlanDetail,
  TaskPlanInput,
  TestConfiguration,
  NodeView,
  TestClientInfo,
} from '@apk/contracts';
import { configurationIssues } from '@apk/contracts';
import example from '../../../contracts/fixtures/config.valid.json';
import { api, mutation } from './api';
const props = defineProps<{
    initial?: TaskPlanDetail;
    initialStep?: number;
    ownedTest?: boolean;
  }>(),
  emit = defineEmits<{ saved: [id: string]; cancel: [] }>();
const step = ref(props.initialStep ?? 1),
  busy = ref(false),
  error = ref(''),
  name = ref(props.initial?.task.name ?? ''),
  nodeId = ref(props.initial?.task.nodeId ?? ''),
  proxyId = ref(props.initial?.configuration.execution.proxySecretVersionId ?? ''),
  automatic = ref(props.initial?.task.automatic ?? false),
  time = ref(props.initial?.task.time ?? '00:05'),
  concurrency = ref<1>(1),
  target = ref(props.initial?.task.successTarget ?? 10),
  limit = ref(props.initial?.task.attemptLimit ?? 30),
  importId = ref(props.initial?.task.configId ?? '');
const source = ref(props.initial?.configuration.source.url ?? ''),
  xpath = ref(props.initial?.configuration.source.xpath ?? example.source.xpath),
  mode = ref<'FULL' | 'DOWNLOAD_ONLY'>(props.initial?.configuration.execution.mode ?? 'FULL');
const multiApp = ref(
    props.initial
      ? !!props.initial.configuration.execution.appOpen?.appsPerDevice
      : (props.ownedTest ?? false),
  ),
  appsMin = ref(props.initial?.configuration.execution.appOpen?.appsPerDevice?.min ?? 3),
  appsMax = ref(props.initial?.configuration.execution.appOpen?.appsPerDevice?.max ?? 5);
const randomDeviceProfile = ref(
    props.initial?.configuration.execution.appOpen?.randomDeviceProfile ?? props.ownedTest ?? false,
  ),
  ownedTestClient = ref(
    props.initial?.configuration.execution.appOpen?.ownedTestClient ?? props.ownedTest ?? false,
  );
const base = ref<TestConfiguration>(
  props.initial?.configuration ??
    ({
      ...structuredClone(example),
      registrationFlows: [],
    } as TestConfiguration),
);
const nodes = ref<NodeView[]>([]),
  proxies = ref<
    {
      id: string;
      name: string | null;
      type: string;
      revokedAt: string | null;
    }[]
  >([]),
  configs = ref<{ id: string; name: string }[]>([]);
const proxyName = ref(''),
  host = ref(''),
  port = ref(10000),
  user = ref(''),
  password = ref('');
watch(nodeId, (id) => {
  if (!props.initial && !props.ownedTest)
    multiApp.value = ['0.13.0', '0.13.1', '0.13.2', '0.13.3'].includes(
      nodes.value.find((n) => n.id === id)?.agentVersion ?? '',
    );
});
watch(target, (value, previous) => {
  if (limit.value === previous * 3) limit.value = Math.min(800, value * 3);
});
const draft = computed(() => {
  const v = JSON.parse(JSON.stringify(base.value)) as TestConfiguration;
  v.name = name.value || 'APK 测试任务';
  v.source = { ...v.source, url: source.value, xpath: xpath.value };
  v.execution.mode = mode.value;
  v.execution.contentIsolation = true;
  delete v.execution.autoRegistration;
  v.registrationFlows = [];
  if (mode.value === 'FULL') {
    v.execution.proxySecretVersionId = proxyId.value;
    v.execution.appOpen = { dwellMs: 10000, concurrency: concurrency.value };
    if (multiApp.value)
      v.execution.appOpen.appsPerDevice = {
        min: appsMin.value,
        max: appsMax.value,
      };
    if (randomDeviceProfile.value) v.execution.appOpen.randomDeviceProfile = true;
    if (ownedTestClient.value) v.execution.appOpen.ownedTestClient = true;
  } else {
    delete v.execution.appOpen;
    delete v.execution.proxySecretVersionId;
  }
  return JSON.stringify(v, null, 2);
});
const raw = ref('');
async function all<T>(path: string): Promise<T[]> {
  let cursor: string | null = null;
  const result: T[] = [];
  do {
    const p: { items: T[]; nextCursor: string | null } = await api(
      path + '?limit=100' + (cursor ? '&cursor=' + cursor : ''),
    );
    result.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  return result;
}
async function choices() {
  [nodes.value, proxies.value, configs.value] = await Promise.all([
    all<NodeView>('/nodes'),
    all<{
      id: string;
      name: string | null;
      type: string;
      revokedAt: string | null;
    }>('/secrets'),
    all<{ id: string; name: string }>('/configs'),
  ]);
  proxies.value = proxies.value.filter((p) => p.type === 'HTTP_PROXY' && !p.revokedAt);
  if (props.ownedTest && !props.initial) {
    const info = await api<TestClientInfo>('/test-client/info');
    if (!info.ready) throw Error('测试 APK 尚未发布');
    name.value = '自有 APK 设备信息测试';
    if (!info.suiteReady) throw Error('十个独立测试 APK 尚未发布');
    source.value = info.suiteSourcePageUrl!;
    xpath.value = "//a[@class='test-apk']";
    target.value = 6;
    limit.value = 6;
    appsMin.value = 3;
    appsMax.value = 3;
    multiApp.value = true;
    concurrency.value = 1;
    base.value.execution.deviceProfiles = [
      {
        id: 'pixel6-api35',
        name: '自有测试设备',
        avdDevice: 'pixel_6',
        systemImage: 'system-images;android-35;google_apis;x86_64',
        locale: 'en-US',
      },
    ];
  }
  const online = nodes.value.filter(
    (n) => n.connection === 'ONLINE' && n.deploymentStatus === 'INSTALLED',
  );
  if (!nodeId.value && online.length === 1) nodeId.value = online[0].id;
  if (!proxyId.value && proxies.value.length === 1) proxyId.value = proxies.value[0].id;
}
function apply(value: string) {
  try {
    const c = JSON.parse(value) as TestConfiguration;
    if (configurationIssues(c).length) throw Error('高级配置有误，请检查后应用');
    base.value = c;
    source.value = c.source.url;
    xpath.value = c.source.xpath;
    proxyId.value = c.execution.proxySecretVersionId ?? '';
    mode.value = c.execution.mode;
    concurrency.value = 1;
    multiApp.value = !!c.execution.appOpen?.appsPerDevice;
    appsMin.value = c.execution.appOpen?.appsPerDevice?.min ?? 1;
    appsMax.value = c.execution.appOpen?.appsPerDevice?.max ?? 1;
    randomDeviceProfile.value = c.execution.appOpen?.randomDeviceProfile ?? false;
    ownedTestClient.value = c.execution.appOpen?.ownedTestClient ?? false;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '配置无效';
  }
}
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
async function importConfig() {
  if (!importId.value) return;
  await work(async () => {
    const p = await api<{ items: { id: string }[] }>(
      '/configs/' + importId.value + '/versions?limit=1',
    );
    if (!p.items[0]) throw Error('此方案还没有保存配置');
    const v = await api<{ body: TestConfiguration }>(
      '/configs/' + importId.value + '/versions/' + p.items[0].id,
    );
    apply(JSON.stringify(v.body));
    name.value = configs.value.find((c) => c.id === importId.value)?.name ?? v.body.name;
  });
}
async function saveProxy() {
  await work(async () => {
    const saved = await api<{ id: string }>('/secrets/versions', 'POST', {
      type: 'HTTP_PROXY',
      ...(proxyName.value ? { name: proxyName.value } : {}),
      secretValue: {
        host: host.value,
        port: port.value,
        username: user.value,
        password: password.value,
      },
    });
    user.value = '';
    password.value = '';
    await choices();
    proxyId.value = saved.id;
  });
}
function next() {
  error.value = '';
  if (
    step.value === 1 &&
    (!name.value.trim() || !/^https?:\/\//.test(source.value) || !xpath.value.trim())
  ) {
    error.value = '请填写任务名称、有效网站地址和 XPath';
    return;
  }
  if (step.value === 2 && (!nodeId.value || (mode.value === 'FULL' && !proxyId.value))) {
    error.value = '请选择服务器及 APP 网络代理';
    return;
  }
  step.value++;
}
async function save() {
  await work(async () => {
    const c = JSON.parse(draft.value) as TestConfiguration;
    const issues = configurationIssues(c);
    if (issues.length)
      throw Error('配置需要修正：' + issues.map((i) => i.path + ' ' + i.message).join('；'));
    if (
      !Number.isInteger(target.value) ||
      !Number.isInteger(limit.value) ||
      limit.value < target.value
    )
      throw Error('尝试上限需不小于成功目标');
    if (randomDeviceProfile.value && !multiApp.value && limit.value > 3)
      throw Error('测试型号每批最多 3 轮，请将尝试上限设为 3 或以下');
    const input: TaskPlanInput = {
      name: name.value.trim(),
      nodeId: nodeId.value,
      ...(importId.value ? { configId: importId.value } : {}),
      configuration: c,
      automatic: automatic.value,
      time: time.value,
      successTarget: target.value,
      attemptLimit: limit.value,
    };
    const task = await mutation<{ id: string }>(
      props.initial ? '/task-plans/' + props.initial.task.id : '/task-plans',
      input,
      props.initial ? { 'If-Match': String(props.initial.task.version) } : {},
      props.initial ? 'PUT' : 'POST',
    );
    emit('saved', task.id);
  });
}
onMounted(() => void work(choices));
onUnmounted(() => {
  user.value = '';
  password.value = '';
});
</script>
<template>
  <section class="surface task-wizard">
    <div class="section-heading">
      <div>
        <span class="phase-tag">第 {{ step }} / 3 步</span>
        <h2>{{ initial ? '编辑任务' : '新建任务' }}</h2>
      </div>
      <el-button :disabled="busy" @click="emit('cancel')">取消</el-button>
    </div>
    <ol class="wizard-progress">
      <li :class="{ active: step === 1 }">1 网站来源</li>
      <li :class="{ active: step === 2 }">2 执行环境</li>
      <li :class="{ active: step === 3 }">3 执行目标</li>
    </ol>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <fieldset :disabled="busy" class="wizard-fields">
      <p class="muted">内容隔离默认开启：保留真实功能操作，仅展示功能记录，不回传原始 APP 画面。</p>
      <template v-if="step === 1">
        <details v-if="!initial">
          <summary>从已有方案接入（可选）</summary>
          <label for="task-import">已有方案</label
          ><select id="task-import" v-model="importId" @change="importConfig">
            <option value="">新建独立任务</option>
            <option v-for="c in configs" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select>
          <p class="muted">接入保留原历史，不会启动旧计划。</p>
        </details>
        <label for="task-name">任务名称</label
        ><input
          id="task-name"
          v-model="name"
          maxlength="100"
          placeholder="例如：每日 APP 启动测试"
        />
        <label for="task-url">网站 URL</label
        ><input id="task-url" v-model="source" placeholder="https://example.com/" />
        <label for="task-xpath">图标 XPath</label
        ><textarea id="task-xpath" v-model="xpath" rows="3" />
        <p class="muted">
          执行时依次处理匹配的全部图标，支持直接下载、落地页下载及自动下载。保存不会访问网站。
        </p>
      </template>
      <template v-else-if="step === 2">
        <label for="task-node">执行服务器</label
        ><select id="task-node" v-model="nodeId">
          <option value="">请选择服务器</option>
          <option v-for="n in nodes" :key="n.id" :value="n.id">
            {{ n.name }} · {{ n.connection === 'ONLINE' ? '在线' : '离线' }}
          </option>
        </select>
        <label for="task-mode">执行内容</label
        ><select id="task-mode" v-model="mode">
          <option value="FULL">下载、安装并启动 APP（停留 10 秒）</option>
          <option value="DOWNLOAD_ONLY">只下载 APK</option>
        </select>
        <template v-if="mode === 'FULL'"
          ><label for="task-proxy">APP 网络代理</label
          ><select id="task-proxy" v-model="proxyId">
            <option value="">请选择已保存代理</option>
            <option v-for="p in proxies" :key="p.id" :value="p.id">
              {{ p.name ?? '历史代理 ' + p.id.slice(0, 8) }}
            </option>
          </select>
          <details>
            <summary>新增代理</summary>
            <label for="task-proxy-name">代理名称</label
            ><input id="task-proxy-name" v-model="proxyName" />
            <div class="filter-grid">
              <label>地址<input v-model="host" placeholder="res.proxy-seller.com" /></label
              ><label>端口<input v-model.number="port" type="number" min="1" max="65535" /></label
              ><label>认证用户名<input v-model="user" autocomplete="off" /></label
              ><label
                >认证密码<input v-model="password" type="password" autocomplete="new-password"
              /></label>
            </div>
            <el-button @click="saveProxy">保存代理并选中</el-button>
          </details>
          <label for="task-concurrency">{{ multiApp ? '同时运行模拟器数' : '同时执行轮数' }}</label
          ><select id="task-concurrency" v-model="concurrency" disabled>
            <option :value="1">1 台（顺序执行，降低 CPU 压力）</option>
          </select>
          <p class="muted">
            {{
              multiApp
                ? '每台设备启动一次新模拟器，依次安装不同 APP；每个 APP 停留 10 秒后关闭并卸载，全部结束后关闭模拟器。'
                : '每轮使用独立模拟器及代理，启动 APP 后停留 10 秒再退出清理。'
            }}无需配置注册入口。
          </p>
          <label class="inline-check"
            ><input v-model="randomDeviceProfile" type="checkbox" />随机机型档案（多 APP
            模式按设备轮换，已验证后启用）</label
          >
          <label class="inline-check"
            ><input v-model="ownedTestClient" type="checkbox" />自有测试 APK
            上报账户与设备信息</label
          >
          <label class="inline-check"
            ><input v-model="multiApp" type="checkbox" />每台新模拟器依次测试多个不同 APP</label
          >
          <div v-if="multiApp" class="form-actions">
            <label
              >每台最少安装
              <el-input-number v-model="appsMin" :min="1" :max="10" aria-label="每台最少安装数量"
            /></label>
            <label
              >每台最多安装
              <el-input-number
                v-model="appsMax"
                :min="appsMin"
                :max="10"
                aria-label="每台最多安装数量"
            /></label>
          </div>
          <p v-if="multiApp" class="muted">
            在同一台设备内随机选包且不重复。APP 完成目标和尝试上限按应用次数统计；设备内型号不变。
          </p>
          <p v-if="ownedTestClient" class="muted">
            仅用于“中台测试 APK”；账户创建回执显示在“测试数据”，与启动完成数分开。
          </p></template
        >
      </template>
      <template v-else>
        <div v-if="mode === 'FULL'" class="filter-grid">
          <label for="task-target"
            >所有 APK 合计完成轮数<input
              id="task-target"
              v-model.number="target"
              type="number"
              min="1"
              max="800" /></label
          ><label for="task-limit"
            >总尝试上限<input
              id="task-limit"
              v-model.number="limit"
              type="number"
              :min="target"
              max="800"
          /></label>
        </div>
        <p v-if="mode === 'DOWNLOAD_ONLY'" class="muted">本任务只下载 APK，不创建注册账户。</p>
        <label class="inline-check"
          ><input v-model="automatic" type="checkbox" />开始后每天自动执行</label
        ><label v-if="automatic" for="task-time"
          >每天执行时间（北京时间）<input id="task-time" v-model="time" type="time"
        /></label>
        <div class="selection-summary">
          {{ name }} · {{ nodes.find((n) => n.id === nodeId)?.name }} ·
          {{ mode === 'FULL' ? '启动并停留 10 秒' : '只下载' }}
          <p>
            <span v-if="mode === 'FULL'">完成目标 {{ target }}，最多尝试 {{ limit }} 次。</span
            >{{
              automatic
                ? '开始后立即执行，并在每天 ' + time + ' 自动执行。'
                : '仅在点击开始后执行本轮。'
            }}
          </p>
          <small
            >{{
              multiApp
                ? '每台模拟器随机安装 ' +
                  appsMin +
                  '～' +
                  appsMax +
                  ' 个不同 APP，逐个卸载后再关闭整机；'
                : '停留完成后关闭模拟器并清理；'
            }}APK 保留复用。最多同时运行
            {{ concurrency }} 台模拟器，完成目标由所有路共享。每台服务器每日最多尝试 800 次
            APP，23:55 停止新增。保存后请点击开始。</small
          >
        </div>
        <details class="advanced-settings" :open="initialStep === 3">
          <summary @click="raw = draft">高级设置</summary>
          <label for="task-json">完整配置 JSON</label
          ><textarea id="task-json" v-model="raw" class="json-editor" /><el-button
            @click="apply(raw)"
            >应用高级配置</el-button
          >
        </details>
        <p v-if="initial" class="muted">
          保存不影响正在执行的批次。旧注册任务保存后切换到启动停留模式，请停止并确认清理后新增一轮；下载规则修改次日生效。
        </p>
      </template>
    </fieldset>
    <div class="form-actions">
      <el-button v-if="step > 1" :disabled="busy" @click="step--">上一步</el-button
      ><el-button v-if="step < 3" type="primary" :disabled="busy" @click="next">下一步</el-button
      ><el-button v-else type="primary" :loading="busy" @click="save">保存任务</el-button>
    </div>
  </section>
</template>
