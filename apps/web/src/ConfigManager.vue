<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { configurationIssues, schemaIssues } from '@apk/contracts';
import { api, mutation } from './api';
import MaintenanceManager from './MaintenanceManager.vue';
const props = defineProps<{ draftText: string }>();
const emit = defineEmits<{ load: [value: string] }>();
interface Config {
  id: string;
  name: string;
  version: number;
  versions?: Version[];
}
interface Version {
  id: string;
  version: number;
  configHash: string;
  body?: unknown;
  createdAt: string;
}
const configs = ref<Config[]>([]),
  selected = ref<Config | null>(null),
  versions = ref<Version[]>([]),
  name = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  cursor = ref<string | null>(null);
const proxyHost = ref(''),
  proxyPort = ref<number | undefined>(undefined),
  proxyUser = ref(''),
  proxyPassword = ref(''),
  proxyId = ref('');
const legacy = computed(() => {
  try {
    const v = JSON.parse(props.draftText);
    return v.execution?.mode === 'FULL' && !v.execution.appOpen;
  } catch {
    return false;
  }
});
function convert() {
  void action(async () => {
    const v = JSON.parse(props.draftText);
    v.execution.appOpen = { dwellMs: 10000, concurrency: 1 };
    v.execution.contentIsolation = true;
    delete v.execution.autoRegistration;
    v.registrationFlows = [];
    emit('load', JSON.stringify(v, null, 2));
    notice.value = '已转换当前草稿。保存为新版本后生效，历史记录保留。';
  });
}
const proxies = ref<{ id: string; createdAt: string; name?: string | null }[]>([]);
async function loadProxies() {
  proxies.value = (
    await api<{
      items: {
        id: string;
        type: string;
        name?: string | null;
        createdAt: string;
        revokedAt: string | null;
      }[];
    }>('/secrets?limit=100')
  ).items.filter((s) => s.type === 'HTTP_PROXY' && !s.revokedAt);
}
async function saveProxy() {
  await action(async () => {
    const body = {
      type: 'HTTP_PROXY',
      secretValue: {
        host: proxyHost.value,
        port: proxyPort.value,
        username: proxyUser.value,
        password: proxyPassword.value,
      },
    };
    if (schemaIssues('SecretInput', body).length)
      throw Error('请填写有效的 HTTP 代理地址、端口和凭据');
    const saved = await api<{ id: string }>('/secrets/versions', 'POST', body);
    proxyId.value = saved.id;
    proxyUser.value = '';
    proxyPassword.value = '';
    await loadProxies();
    notice.value = '代理已加密保存，可将引用应用到草稿';
  });
}
function applyProxy() {
  void action(async () => {
    const body = JSON.parse(props.draftText);
    if (!proxyId.value) {
      body.execution.mode = 'DOWNLOAD_ONLY';
      delete body.execution.proxySecretVersionId;
      delete body.execution.autoRegistration;
      delete body.execution.appOpen;
      body.registrationFlows = [];
      emit('load', JSON.stringify(body, null, 2));
      notice.value = '已移除代理，草稿切换为仅下载模式。';
      return;
    }
    if (legacy.value) throw Error('请先明确转换历史流程，再修改代理');
    body.execution.mode = 'FULL';
    body.execution.appOpen ??= { dwellMs: 10000, concurrency: 1 };
    body.execution.contentIsolation = true;
    delete body.execution.autoRegistration;
    body.registrationFlows = [];
    body.execution.proxySecretVersionId = proxyId.value;
    emit('load', JSON.stringify(body, null, 2));
    notice.value = '已将代理应用到 APP 打开测试草稿。保存新版本后生效。';
  });
}
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
async function refresh(append = false) {
  const p = await api<{ items: Config[]; nextCursor: string | null }>(
    '/configs' + (append && cursor.value ? '?cursor=' + cursor.value : ''),
  );
  configs.value = append ? [...configs.value, ...p.items] : p.items;
  cursor.value = p.nextCursor;
}
async function select(c: Config) {
  await action(async () => {
    selected.value = await api<Config>('/configs/' + c.id);
    versions.value = (
      await api<{ items: Version[] }>('/configs/' + c.id + '/versions?limit=100')
    ).items;
    name.value = c.name;
    if (versions.value[0]) {
      const latest = await api<Version>('/configs/' + c.id + '/versions/' + versions.value[0].id);
      emit('load', JSON.stringify(latest.body, null, 2));
      notice.value = '已载入最新保存版本，编辑后请另存新版本。';
    }
  });
}
async function create() {
  await action(async () => {
    const c = await mutation<Config>('/configs', { name: name.value });
    selected.value = c;
    versions.value = [];
    await refresh();
    notice.value = '配置已建立，可保存当前草稿为第一个版本';
  });
}
async function save() {
  if (!selected.value) return;
  await action(async () => {
    let body: unknown;
    try {
      body = JSON.parse(props.draftText);
    } catch {
      throw Error('配置 JSON 格式无效');
    }
    if (legacy.value) throw Error('请先将历史流程转换为 APP 打开测试，再保存新版本');
    if (configurationIssues(body).length) throw Error('请先修正配置校验问题');
    await mutation('/configs/' + selected.value!.id + '/versions', body, {
      'If-Match': String(selected.value!.version),
    });
    selected.value = await api<Config>('/configs/' + selected.value!.id);
    versions.value = (
      await api<{ items: Version[] }>('/configs/' + selected.value.id + '/versions?limit=100')
    ).items;
    await refresh();
    notice.value = '已保存不可变版本，运行中的任务不会改变';
  });
}
async function load(v: Version) {
  if (!selected.value) return;
  await action(async () => {
    const full = await api<Version>('/configs/' + selected.value!.id + '/versions/' + v.id);
    emit('load', JSON.stringify(full.body, null, 2));
    notice.value = '历史版本已载入草稿，编辑后需另存新版本';
  });
}
onMounted(
  () =>
    void action(async () => {
      await refresh();
      await loadProxies();
    }),
);
onUnmounted(() => {
  proxyUser.value = '';
  proxyPassword.value = '';
});
watch(
  () => props.draftText,
  () => {
    try {
      const value = JSON.parse(props.draftText);
      proxyId.value = value.execution?.proxySecretVersionId ?? '';
    } catch {
      /* Keep the current selection while editing JSON. */
    }
  },
  { immediate: true },
);
</script>
<template>
  <div class="version-manager">
    <h2>代理与配置版本</h2>
    <p class="muted">内容隔离默认开启，旧配置同样生效。仅保存受限功能证据，不展示原始 APP 内容。</p>
    <p class="muted">
      保存产生新版本，运行中的任务继续使用原版本。当前流程为安装、打开、停留 10 秒和清理。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <label for="scheme-proxy">APP 网络代理</label
    ><select id="scheme-proxy" v-model="proxyId" @change="applyProxy">
      <option value="">请选择已保存代理</option>
      <option v-for="p in proxies" :key="p.id" :value="p.id">
        {{ p.name ?? '历史代理 ' + p.id.slice(0, 8) }}
      </option>
    </select>
    <div class="form-actions">
      <el-button :disabled="busy || !proxyId" @click="applyProxy">应用所选代理到草稿</el-button
      ><a href="#/proxies">管理和检查代理 →</a>
    </div>
    <div v-if="legacy" class="confirmation-box" role="alert">
      <p>载入了历史账户流程。旧版本保持原样；转换草稿后可另存为 APP 打开测试。</p>
      <el-button :disabled="busy" @click="convert">转换为 APP 打开测试</el-button>
    </div>
    <details>
      <summary>快速新增代理（可选）</summary>
      <label for="proxy-host">代理地址</label
      ><el-input id="proxy-host" v-model="proxyHost" placeholder="proxy.example.com" />
      <label for="proxy-port">端口</label
      ><el-input-number
        id="proxy-port"
        v-model="proxyPort"
        :min="1"
        :max="65535"
        placeholder="填写服务商提供的单个端口"
      />
      <p class="muted">
        端口范围需选一个填写，例如 10000–10199 可填写 10000。地址只填主机名或 IP。
      </p>
      <label for="proxy-user">代理用户名</label
      ><el-input id="proxy-user" v-model="proxyUser" autocomplete="off" />
      <label for="proxy-password">代理密码</label
      ><el-input
        id="proxy-password"
        v-model="proxyPassword"
        type="password"
        autocomplete="new-password"
      />
      <div class="form-actions">
        <el-button :disabled="busy || !proxyHost || !proxyPort || !proxyPassword" @click="saveProxy"
          >加密保存代理</el-button
        >
      </div>
      <label for="proxy-version">已保存的代理引用</label
      ><select id="proxy-version" v-model="proxyId">
        <option value="">请选择</option>
        <option v-for="p in proxies" :key="p.id" :value="p.id">
          {{ p.id }} · {{ new Date(p.createdAt).toLocaleString() }}
        </option>
      </select>
      <el-button :disabled="busy || !proxyId" @click="applyProxy">将代理应用到当前草稿</el-button>
      <p class="muted">
        凭据不会写入配置 JSON。轮询代理的探测 IP 只代表探测当时，不保证 APP 请求使用相同出口。
      </p>
    </details>
    <label for="config-name">配置名称</label
    ><el-input id="config-name" v-model="name" maxlength="100" />
    <div class="form-actions">
      <el-button :disabled="busy || !name" @click="create">新建配置</el-button
      ><el-button type="primary" :disabled="busy || !selected" @click="save"
        >保存草稿为新版本</el-button
      >
    </div>
    <el-table :data="configs" empty-text="尚无保存的配置"
      ><el-table-column prop="name" label="名称" /><el-table-column label="操作"
        ><template #default="s"
          ><el-button text @click="select(s.row)">选择配置</el-button></template
        ></el-table-column
      ></el-table
    ><el-button v-if="cursor" text @click="action(() => refresh(true))">加载更多配置</el-button>
    <template v-if="selected"
      ><h3>当前配置：{{ selected.name }}</h3>
      <MaintenanceManager
        :key="selected.id + ':' + selected.version"
        :config-id="selected.id"
        @choose-version="(id) => load({ id, version: 0, configHash: '', createdAt: '' })"
    /></template>
  </div>
</template>
