<script setup lang="ts">
import { ref, onMounted, onUnmounted, reactive } from 'vue';
import { schemaIssues } from '@apk/contracts';
import type { NodeView, NodeInput, ReleaseInput } from '@apk/contracts';
import { api } from './api';
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
  editingVersion = ref(0);
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
  more = ref<string | null>(null);
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
async function refresh(append = false) {
  const page = await api<{ items: NodeView[]; nextCursor: string | null }>(
    '/nodes' + (append && more.value ? '?cursor=' + more.value : ''),
  );
  nodes.value = append ? [...nodes.value, ...page.items] : page.items;
  more.value = page.nextCursor;
  releases.value = (await api<{ items: ReleaseRow[] }>('/releases')).items;
  if (selected.value) {
    selected.value = await api<NodeView>('/nodes/' + selected.value.id);
    operations.value = (
      await api<{ items: Operation[] }>('/deployments?nodeId=' + selected.value.id)
    ).items;
  }
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
    if (busy.value || refreshing || editing.value) return;
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
          <p class="muted">先录入连接信息，再核验主机身份和环境。</p>
        </div>
        <el-button type="primary" :disabled="busy" @click="openForm(null)">添加服务器</el-button>
      </div>
      <el-table :data="nodes" empty-text="尚未接入服务器"
        ><el-table-column prop="name" label="名称" /><el-table-column
          prop="host"
          label="地址"
        /><el-table-column label="Agent"
          ><template #default="s">{{
            s.row.connection === 'ONLINE' ? '在线' : '离线'
          }}</template></el-table-column
        ><el-table-column label="占用"
          ><template #default="s">{{
            s.row.occupancy === 'IDLE' ? '空闲' : s.row.occupancy === 'BUSY' ? '操作中' : '待核验'
          }}</template></el-table-column
        ><el-table-column label="操作"
          ><template #default="s"
            ><el-button text @click="select(s.row)">管理</el-button></template
          ></el-table-column
        ></el-table
      >
      <el-button v-if="more" text @click="action(() => refresh(true))">加载更多服务器</el-button>
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
      <section class="surface">
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
          ><span>版本：{{ selected.agentVersion ?? '尚未注册' }}</span
          ><span>安卓：{{ selected.health?.android ? '启动已核验' : '尚未确认' }}</span
          ><span>主机身份：{{ selected.expectedFingerprint ? '已确认' : '待核对' }}</span>
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
            执行节点支持 Ubuntu 24.04 / 26.04 LTS x86_64；安装请使用 Agent 0.3.2 的新签名发布。
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
        <details class="archive-details">
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
                >停止</el-button
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
