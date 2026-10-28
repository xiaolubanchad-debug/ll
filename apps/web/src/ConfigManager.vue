<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { configurationIssues, schemaIssues } from '@apk/contracts';
import { api, mutation } from './api';
import RegistrationFlowEditor from './RegistrationFlowEditor.vue';
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
const proxies = ref<{ id: string; createdAt: string }[]>([]);
async function loadProxies() {
  proxies.value = (
    await api<{
      items: { id: string; type: string; createdAt: string; revokedAt: string | null }[];
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
    body.execution.mode = 'FULL';
    body.execution.proxySecretVersionId = proxyId.value;
    emit('load', JSON.stringify(body, null, 2));
    notice.value = '草稿已切换为完整测试，仍需配置每个 APK 的注册流程并保存新版本';
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
</script>
<template>
  <div class="version-manager">
    <h2>配置版本管理</h2>
    <p class="muted">
      保存后版本不可修改。完整测试按包名匹配注册流程；没有启用流程的 APK 会跳过安装注册。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <details>
      <summary>HTTP 代理配置</summary>
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
        凭据不会写入配置 JSON。轮询代理的探测 IP 只代表探测当时，不保证注册请求使用相同出口。
      </p>
    </details>
    <RegistrationFlowEditor :draft-text="draftText" @load="(value) => emit('load', value)" />
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
      <el-table :data="versions" empty-text="尚未保存版本"
        ><el-table-column prop="version" label="版本" /><el-table-column label="摘要"
          ><template #default="s"
            ><span class="fingerprint">{{ s.row.configHash.slice(0, 16) }}</span></template
          ></el-table-column
        ><el-table-column label="操作"
          ><template #default="s"
            ><el-button text @click="load(s.row)">载入版本</el-button></template
          ></el-table-column
        ></el-table
      ></template
    >
  </div>
</template>
