<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { ElDialog, ElSelect, ElOption } from 'element-plus';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/option/style/css';
import type { TestDataPage, TestDataCredentials, TestClientInfo } from '@apk/contracts';
import { api } from './api';
import { when } from './console-format';
import { navigate } from './navigation';
const nodeId = ref(''),
  runId = ref(''),
  nodes = ref<{ id: string; name: string }[]>([]);
const rows = ref<TestDataPage['items']>([]),
  next = ref<string | null>(null),
  busy = ref(false),
  error = ref(''),
  info = ref<TestClientInfo | null>(null),
  selected = ref<TestDataCredentials | null>(null),
  visible = ref(false),
  selectedId = ref('');
let timer: ReturnType<typeof setInterval> | undefined,
  disposed = false,
  paged = false;
async function load(append = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const page = await api<TestDataPage>(
      '/test-data?limit=30' +
        (nodeId.value ? '&nodeId=' + encodeURIComponent(nodeId.value) : '') +
        (runId.value ? '&runId=' + encodeURIComponent(runId.value) : '') +
        (append && next.value ? '&cursor=' + encodeURIComponent(next.value) : ''),
    );
    if (disposed) return;
    rows.value = append ? [...rows.value, ...page.items] : page.items;
    next.value = page.nextCursor;
    if (append) paged = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取测试数据失败';
  } finally {
    busy.value = false;
  }
}
async function reveal(id: string) {
  error.value = '';
  selected.value = null;
  selectedId.value = id;
  try {
    const value = await api<TestDataCredentials>('/test-data/' + id + '/credentials', 'POST', {
      reason: '核对自有测试 APK 生成的账户',
    });
    if (!disposed && selectedId.value === id) {
      selected.value = value;
      visible.value = true;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取测试账户失败';
  }
}
onMounted(async () => {
  await load();
  try {
    info.value = await api<TestClientInfo>('/test-client/info');
    nodes.value = (await api<{ items: { id: string; name: string }[] }>('/nodes?limit=100')).items;
  } catch {
    /* Records remain readable before publishing an APK. */
  }
  if (disposed) return;
  timer = setInterval(() => {
    if (!document.hidden && !paged && !busy.value) void load();
  }, 3000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  selected.value = null;
});
</script>
<template>
  <section class="surface">
    <div class="section-heading">
      <div>
        <h2>测试数据</h2>
        <p class="muted">
          仅展示自有测试 APK 实际上报并创建的账户。IP 来自创建请求，不额外查询代理出口。
        </p>
      </div>
      <div class="form-actions">
        <el-button
          :disabled="busy"
          @click="
            paged = false;
            load();
          "
          >刷新</el-button
        >
        <el-button
          type="primary"
          :disabled="!info?.ready"
          @click="navigate('tasks', '', { new: 'true', ownedTest: 'true' })"
          >创建自测任务</el-button
        >
        <a v-if="info?.ready" :href="info.downloadUrl" target="_blank" rel="noopener"
          >下载测试 APK</a
        >
      </div>
    </div>
    <div class="form-actions">
      <el-select
        v-model="nodeId"
        clearable
        placeholder="全部服务器"
        aria-label="筛选服务器"
        @change="
          paged = false;
          load();
        "
        style="width: 200px"
      >
        <el-option v-for="n in nodes" :key="n.id" :label="n.name" :value="n.id" />
      </el-select>
      <el-input
        v-model="runId"
        clearable
        placeholder="按执行记录 ID 筛选（可选）"
        aria-label="筛选执行记录"
        @change="
          paged = false;
          load();
        "
        style="width: 330px"
      />
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="info && !info.ready" class="muted">测试 APK 尚未发布；发布后可从这里创建自测任务。</p>
    <p v-if="!rows.length && !busy" class="empty-state">
      暂无上报记录。通过中台任务安装、打开自有测试 APK 后，账户与设备观测会显示在这里。
    </p>
    <el-table :data="rows" empty-text="暂无测试数据">
      <el-table-column label="时间 / 轮次" min-width="170"
        ><template #default="{ row }">
          {{ when(row.createdAt) }}<br /><el-button
            text
            @click="navigate('runs', row.runId, { view: 'logs' })"
            >第 {{ row.position }} 轮 · 查看日志</el-button
          >
        </template></el-table-column
      >
      <el-table-column prop="nodeName" label="执行服务器" min-width="110" />
      <el-table-column label="测试账户" min-width="150"
        ><template #default="{ row }">
          {{ row.username }}<br /><el-button text @click="reveal(row.id)"
            >查看密码和设备 ID</el-button
          >
        </template></el-table-column
      >
      <el-table-column prop="sourceIp" label="账户创建请求 IP" min-width="150" />
      <el-table-column label="APP 设备 ID（哈希）" min-width="160"
        ><template #default="{ row }">
          <span :title="row.androidIdHash">{{ row.androidIdHash.slice(0, 16) }}…</span>
        </template></el-table-column
      >
      <el-table-column label="实际型号 / 档案" min-width="190"
        ><template #default="{ row }">
          {{ row.model }}<br /><small>{{ row.profileId }} · API {{ row.apiLevel }}</small
          ><br />
          <span :class="row.modelMatched ? 'tone-success' : 'tone-warning'">{{
            row.modelMatched ? '型号匹配' : '型号不一致'
          }}</span>
        </template></el-table-column
      >
      <el-table-column label="实际请求 UA" min-width="220"
        ><template #default="{ row }">
          <span :title="row.userAgent">{{ row.userAgent.slice(0, 75) }}…</span><br />
          <span :class="row.uaMatched ? 'tone-success' : 'tone-warning'">{{
            row.uaMatched ? '请求 UA 匹配' : '请求 UA 不一致'
          }}</span>
        </template></el-table-column
      >
    </el-table>
    <el-button v-if="next" :disabled="busy" @click="load(true)">加载更早记录</el-button>
    <el-dialog
      v-model="visible"
      title="自有测试账户"
      width="min(560px,95vw)"
      @closed="
        selected = null;
        selectedId = '';
      "
    >
      <template v-if="selected">
        <p>此次查看已记录审计。</p>
        <p>
          用户名：<strong>{{ selected.username }}</strong>
        </p>
        <p>
          密码：<strong>{{ selected.password }}</strong>
        </p>
        <p>APP Android ID：{{ selected.androidId }}</p>
      </template>
    </el-dialog>
  </section>
</template>
