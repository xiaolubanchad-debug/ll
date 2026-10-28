<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { NodeView } from '@apk/contracts';
import { schemaIssues } from '@apk/contracts';
import { api, mutation } from './api';
import { href } from './navigation';
import { when, stateLabels } from './console-format';
interface Proxy {
  id: string;
  name: string | null;
  createdAt: string;
}
const proxies = ref<Proxy[]>([]),
  nodes = ref<NodeView[]>([]),
  configs = ref<{ id: string; name: string }[]>([]),
  versions = ref<{ id: string; version: number }[]>([]),
  name = ref(''),
  host = ref(''),
  port = ref<number | undefined>(),
  username = ref(''),
  password = ref(''),
  nodeId = ref(''),
  configId = ref(''),
  versionId = ref(''),
  proxyId = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  check = ref<{
    id: string;
    status: string;
    proxyObservation?: { status: string };
    errorCode: string | null;
  } | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
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
async function refresh() {
  proxies.value = (
    await api<{ items: (Proxy & { type: string; revokedAt: string | null })[] }>(
      '/secrets?limit=100',
    )
  ).items.filter((p) => p.type === 'HTTP_PROXY' && !p.revokedAt);
}
async function save() {
  await work(async () => {
    const body = {
      type: 'HTTP_PROXY',
      ...(name.value.trim() ? { name: name.value.trim() } : {}),
      secretValue: {
        host: host.value,
        port: port.value,
        username: username.value,
        password: password.value,
      },
    };
    if (schemaIssues('SecretInput', body).length)
      throw Error('请填写有效的 HTTP 代理地址、单个端口和凭据');
    const p = await api<Proxy>('/secrets/versions', 'POST', body);
    proxyId.value = p.id;
    username.value = '';
    password.value = '';
    await refresh();
    notice.value = '代理已加密保存。请在任务方案中选择此代理并保存新版本。';
  });
}
async function loadVersions() {
  versionId.value = '';
  versions.value = configId.value
    ? (
        await api<{ items: typeof versions.value }>(
          '/configs/' + configId.value + '/versions?limit=100',
        )
      ).items
    : [];
}
async function checkProxy() {
  await work(async () => {
    const n = nodes.value.find((n) => n.id === nodeId.value);
    if (!n?.agentReleaseId || n.connection !== 'ONLINE' || n.occupancy !== 'IDLE')
      throw Error('请选择已部署、在线且空闲的服务器');
    const r = await mutation<{ resourceId: string }>('/runs', {
      nodeId: n.id,
      configVersionId: versionId.value,
      releaseId: n.agentReleaseId,
      purpose: 'PROXY_CHECK',
      proxySecretVersionId: proxyId.value,
    });
    check.value = await api('/runs/' + r.resourceId);
    notice.value = '检查已排队，下面会自动显示结果。此操作不打开产品 APP。';
  });
}
onMounted(() => {
  void work(async () => {
    await refresh();
    nodes.value = (await api<{ items: NodeView[] }>('/nodes?limit=100')).items;
    configs.value = (await api<{ items: typeof configs.value }>('/configs?limit=100')).items;
  });
  timer = setInterval(() => {
    if (check.value && ['QUEUED', 'ASSIGNED', 'RUNNING'].includes(check.value.status))
      void api<typeof check.value>('/runs/' + check.value.id)
        .then((r) => {
          check.value = r;
        })
        .catch(() => {});
  }, 2000);
});
onUnmounted(() => {
  clearInterval(timer);
  username.value = '';
  password.value = '';
});
</script>
<template>
  <div class="console-stack">
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <section class="surface config-form">
      <h2>新增 HTTP 代理</h2>
      <p class="muted">地址填写主机名，不含 http://；端口范围中选择一个端口，例如 10000。</p>
      <p class="muted">
        凭据加密保存。修改代理需新建版本，再由任务方案明确引用；运行中的任务不会改变。
      </p>
      <form @submit.prevent="save">
        <div class="filter-grid">
          <label
            >代理名称<input
              v-model="name"
              maxlength="100"
              placeholder="例如：住宅代理主线路" /></label
          ><label>代理地址<input v-model="host" placeholder="res.proxy-seller.com" /></label
          ><label
            >端口<el-input-number
              v-model="port"
              :min="1"
              :max="65535"
              placeholder="单个端口，例如 10000" /></label
          ><label>代理用户名<input v-model="username" autocomplete="off" /></label
          ><label
            >代理密码<input v-model="password" type="password" autocomplete="new-password"
          /></label>
        </div>
        <el-button
          type="primary"
          native-type="submit"
          :disabled="busy || !host || !port || !password"
          >加密保存代理</el-button
        >
      </form>
    </section>
    <section class="surface">
      <h2>已保存代理</h2>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>保存时间</th>
              <th>引用编号</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in proxies" :key="p.id">
              <td>{{ p.name ?? '历史代理 ' + p.id.slice(0, 8) }}</td>
              <td>{{ when(p.createdAt) }}</td>
              <td class="fingerprint">{{ p.id.slice(0, 8) }}</td>
              <td><el-button text @click="proxyId = p.id">选择并检查</el-button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!proxies.length" class="empty-state">尚未保存代理。</p>
    </section>
    <section class="surface config-form">
      <h2>代理连通检查</h2>
      <p class="muted">在所选服务器上检查连接和认证，不安装或打开 APP。检查出口仅代表本次请求。</p>
      <div class="filter-grid">
        <label
          >检查代理<select v-model="proxyId">
            <option value="">请选择</option>
            <option v-for="p in proxies" :key="p.id" :value="p.id">
              {{ p.name ?? '历史代理 ' + p.id.slice(0, 8) }}
            </option>
          </select></label
        ><label
          >检查服务器<select v-model="nodeId">
            <option value="">请选择在线且空闲的服务器</option>
            <option v-for="n in nodes" :key="n.id" :value="n.id">
              {{ n.name }} · {{ n.connection === 'ONLINE' ? '在线' : '离线' }}
            </option>
          </select></label
        ><label
          >检查所用方案<select v-model="configId" @change="work(loadVersions)">
            <option value="">请选择已保存方案</option>
            <option v-for="c in configs" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select></label
        ><label
          >固定配置版本<select v-model="versionId">
            <option value="">请选择版本</option>
            <option v-for="v in versions" :key="v.id" :value="v.id">版本 {{ v.version }}</option>
          </select></label
        >
      </div>
      <el-button :disabled="busy || !proxyId || !nodeId || !versionId" @click="checkProxy"
        >在 EC2 上检查代理</el-button
      >
      <div v-if="check" class="selection-summary">
        检查状态：{{ stateLabels[check.status] ?? check.status }}
        <p v-if="check.status === 'SUCCEEDED'">连接与认证检查通过。</p>
        <p v-if="check.status === 'FAILED'">连接或认证未通过，请核对代理服务、端口与凭据。</p>
        <a :href="href('runs', check.id)">查看检查日志 →</a>
      </div>
    </section>
  </div>
</template>
