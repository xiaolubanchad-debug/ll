<script setup lang="ts">
import { ElTag } from 'element-plus';
import 'element-plus/es/components/tag/style/css';
import { ref, onMounted, onUnmounted, watch } from 'vue';
import type { AssetListView } from '@apk/contracts';
import ApkWorkbench from './ApkWorkbench.vue';
import { api } from './api';
import { today, when, stateLabels } from './console-format';
import { route, href, navigate } from './navigation';
type Asset = AssetListView['items'][number];
const day = ref(route.value.query.get('day') ?? today()),
  q = ref(route.value.query.get('q') ?? ''),
  status = ref(route.value.query.get('status') ?? 'ALL');
const items = ref<Asset[]>([]),
  cursor = ref<string | null>(null),
  busy = ref(false),
  error = ref('');
const manualLabels: Record<string, string> = {
  UPLOADING: '等待选择文件',
  RECEIVING: '正在接收文件',
  QUEUED: '等待下发',
  IMPORTING: '正在下发到服务器',
  APPLIED: '补包已就绪',
  FAILED: '补包失败',
  CANCELLED: '补包已取消',
  EXPIRED: '已过期',
  NEEDS_REVIEW: '下发结果待核验',
};
const reasons: Record<string, string> = {
  APK_INVALID: '历史 APK 预校验失败',
  APK_METADATA_UNREADABLE: '无法读取启动所需包名或系统版本',
  FILE_TRANSFER_MISMATCH: '文件传输结果不一致',
  NODE_UPGRADE_REQUIRED: '等待执行节点更新到 Agent 0.15.1',
  APK_TOO_LARGE: '文件超过配置大小限制',
  DOWNLOAD_FAILED: '网页未取得 APK',
  NODE_BUSY: '服务器忙，请停止任务并等待清理后下发',
  IMPORT_TOOL_REQUIRED: '等待补包工具发布',
  APK_UPLOAD_INTERRUPTED: '历史上传中断',
  JOB_CANCELLED: '已取消',
  DAY_CHANGED: '下载日期已过期',
};
const packageOf = (r: Asset) => r.apk ?? r.manualUpload?.apk;
const reason = (code: string | null | undefined) => (code ? (reasons[code] ?? code) : '—');
async function load(append = false) {
  if (busy.value) return;
  busy.value = true;
  try {
    const page = await api<AssetListView>(
      '/apk-assets?' +
        new URLSearchParams({
          day: day.value,
          q: q.value,
          status: status.value,
          limit: '30',
          ...(append && cursor.value ? { cursor: cursor.value } : {}),
        }),
    );
    items.value = append ? [...items.value, ...page.items] : page.items;
    cursor.value = page.nextCursor;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '资源读取失败';
  } finally {
    busy.value = false;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => route.value.key,
  () => {
    day.value = route.value.query.get('day') ?? today();
    q.value = route.value.query.get('q') ?? '';
    status.value = route.value.query.get('status') ?? 'ALL';
    void load();
  },
);
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (
      items.value.some(
        (r) =>
          r.manualUpload && ['QUEUED', 'IMPORTING', 'RECEIVING'].includes(r.manualUpload.status),
      )
    )
      void load();
  }, 10000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <ApkWorkbench />
  <section class="surface">
    <h2>历史 APK 记录</h2>
    <p class="muted">按日期查询已结束和正在处理的历史记录。</p>
    <form
      class="toolbar"
      @submit.prevent="
        navigate('assets', '', { day, q, status });
        load();
      "
    >
      <label>下载日期<input v-model="day" type="date" /></label>
      <label>APP / 入口<input v-model="q" maxlength="100" placeholder="包名或入口名称" /></label>
      <label
        >下载结果<select v-model="status">
          <option value="ALL">全部</option>
          <option value="SUCCESS">下载成功</option>
          <option value="FAILED">失败 / 已停止</option>
          <option value="PENDING">等待 / 执行中</option>
          <option value="MANUAL">有手动补包</option>
        </select></label
      >
      <el-button native-type="submit" :disabled="busy">查询</el-button
      ><el-button :disabled="busy" @click="load()">刷新</el-button>
    </form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>入口 / 包名</th>
            <th>下载结果</th>
            <th>版本 / 架构</th>
            <th>服务器 / 日期</th>
            <th>手动补包</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id">
            <td>
              <strong>{{ r.label }}</strong
              ><small>{{
                packageOf(r)?.fileName ?? packageOf(r)?.packageName ?? '尚无 APK 文件'
              }}</small
              ><small v-if="packageOf(r)" class="fingerprint"
                >SHA256 {{ packageOf(r)?.apkSha256.slice(0, 16) }}</small
              >
            </td>
            <td>
              <el-tag
                :type="
                  r.status === 'SUCCEEDED' ? 'success' : r.status === 'FAILED' ? 'danger' : 'info'
                "
                >{{
                  r.status === 'SUCCEEDED'
                    ? '下载成功'
                    : r.status === 'FAILED'
                      ? '下载失败'
                      : (stateLabels[r.status] ?? r.status)
                }}</el-tag
              ><small v-if="r.errorCode">{{ reason(r.errorCode) }}</small>
            </td>
            <td>
              <template v-if="packageOf(r)"
                >{{ packageOf(r)?.versionName ?? '无版本名称' }} · {{ packageOf(r)?.versionCode
                }}<small>{{ packageOf(r)?.abis.join(', ') || '未声明原生架构' }}</small
                ><small
                  >{{ ((packageOf(r)?.size ?? 0) / 1024 / 1024).toFixed(1) }} MB</small
                ></template
              ><span v-else>—</span>
            </td>
            <td>
              {{ r.nodeName }}<small>{{ r.cacheDay ?? r.apk?.cacheDay }}</small
              ><small>{{ when(r.createdAt) }}</small>
            </td>
            <td>
              <template v-if="r.manualUpload"
                ><strong>{{ manualLabels[r.manualUpload.status] ?? r.manualUpload.status }}</strong
                ><small v-if="r.manualUpload.errorCode">{{
                  reason(r.manualUpload.errorCode)
                }}</small></template
              ><span v-else>—</span>
            </td>
            <td>
              <a :href="href('runs', r.runId)">下载日志</a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="busy && !items.length" class="empty-state">正在读取下载结果…</p>
    <p v-else-if="!items.length && !error" class="empty-state">
      所选日期和筛选条件下暂无下载记录。
    </p>
    <p class="muted">历史包信息不代表文件仍保留在服务器；安装前确认缓存文件未在传输中改变。</p>
    <el-button v-if="cursor" :disabled="busy" @click="load(true)">加载更多</el-button>
  </section>
</template>
<style scoped>
.data-table small {
  display: block;
  margin-top: 7px;
  max-width: 260px;
  overflow-wrap: anywhere;
}
</style>
