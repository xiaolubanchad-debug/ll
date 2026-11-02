<script setup lang="ts">
import { ElTag } from 'element-plus';
import 'element-plus/es/components/tag/style/css';
import { ref, onMounted, onUnmounted, watch } from 'vue';
import type { AssetListView, ManualApkView } from '@apk/contracts';
import { api, mutation, uploadApk } from './api';
import { today, when, stateLabels } from './console-format';
import { route, href, navigate } from './navigation';
type Asset = AssetListView['items'][number];
const day = ref(route.value.query.get('day') ?? today()),
  q = ref(route.value.query.get('q') ?? ''),
  status = ref(route.value.query.get('status') ?? 'ALL');
const items = ref<Asset[]>([]),
  cursor = ref<string | null>(null),
  busy = ref(false),
  error = ref(''),
  actionError = ref(''),
  notice = ref(''),
  uploading = ref(''),
  percent = ref(0);
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
  APK_INVALID: '历史 APK 预校验失败，可重新上传',
  APK_METADATA_UNREADABLE: '无法读取启动所需包名或系统版本',
  FILE_TRANSFER_MISMATCH: '文件传输结果不一致，请重新上传',
  NODE_UPGRADE_REQUIRED: '等待执行节点更新到 Agent 0.15.1',
  APK_TOO_LARGE: '文件超过配置大小限制',
  DOWNLOAD_FAILED: '网页未取得 APK',
  NODE_BUSY: '服务器忙，请停止任务并等待清理后下发',
  IMPORT_TOOL_REQUIRED: '等待补包工具发布',
  APK_UPLOAD_INTERRUPTED: '上传中断，可重新上传',
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
async function upload(row: Asset, event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file || uploading.value) return;
  uploading.value = row.id;
  percent.value = 0;
  notice.value = '';
  actionError.value = '';
  try {
    const session = await mutation<ManualApkView>('/apk-assets/' + row.id + '/uploads', {});
    if (file.size > session.maxBytes)
      throw Error('文件超过该任务限制：' + Math.round(session.maxBytes / 1024 / 1024) + ' MB');
    await uploadApk<ManualApkView>(
      '/apk-uploads/' + session.id + '/file',
      file,
      (p) => (percent.value = p),
    );
    notice.value = 'APK 文件已接收，等待服务器空闲后下发。补包就绪后，请手动开始任务。';
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '补包失败';
  } finally {
    uploading.value = '';
    await load();
  }
}
async function act(row: Asset, action: 'retry' | 'cancel') {
  if (!row.manualUpload || uploading.value) return;
  uploading.value = row.id;
  try {
    await mutation('/apk-uploads/' + row.manualUpload.id + '/' + action, {});
    notice.value = action === 'retry' ? '已重新排队下发' : '已请求取消补包';
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    uploading.value = '';
    await load();
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
      !uploading.value &&
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
  <section class="surface">
    <h2>APK 下载与补包</h2>
    <p class="muted">
      显示成功及失败的下载入口。当天最新下载的失败项可以上传 APK
      补包；原始下载日志保留。补包不会自动开始任务。
    </p>
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
    <el-alert v-if="actionError" :title="actionError" type="error" @close="actionError = ''" />
    <el-alert v-if="notice" :title="notice" type="success" show-icon @close="notice = ''" />
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
                }}</small
                ><small v-if="r.manualUpload.status === 'APPLIED'"
                  >下次手动开始任务时使用</small
                ></template
              ><span v-else>—</span
              ><small v-if="uploading === r.id">上传 / 处理 {{ percent }}%</small>
            </td>
            <td>
              <div class="row-actions">
                <label v-if="r.canUpload" class="apk-upload"
                  ><span>上传 APK 补包</span
                  ><input
                    type="file"
                    accept=".apk,application/vnd.android.package-archive"
                    :disabled="!!uploading"
                    @change="upload(r, $event)"
                /></label>
                <el-button
                  v-if="
                    r.manualUpload?.apk &&
                    ['FAILED', 'CANCELLED', 'APPLIED', 'NEEDS_REVIEW'].includes(
                      r.manualUpload.status,
                    )
                  "
                  size="small"
                  :disabled="!!uploading"
                  @click="act(r, 'retry')"
                  >重新下发</el-button
                >
                <el-button
                  v-if="
                    r.manualUpload &&
                    ['UPLOADING', 'RECEIVING', 'QUEUED', 'IMPORTING'].includes(
                      r.manualUpload.status,
                    )
                  "
                  size="small"
                  :disabled="!!uploading"
                  @click="act(r, 'cancel')"
                  >取消补包</el-button
                >
                <a :href="href('runs', r.runId)">下载日志</a>
              </div>
              <small v-if="!r.canUpload && !r.manualUpload && r.status !== 'SUCCEEDED'">{{
                r.uploadBlockedReason
              }}</small>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="busy && !items.length" class="empty-state">正在读取下载结果…</p>
    <p v-else-if="!items.length && !error" class="empty-state">
      所选日期和筛选条件下暂无下载记录。
    </p>
    <p class="muted">
      历史包信息不代表文件仍保留在服务器；安装前确认缓存文件未在传输中改变。补包仅用于当前日期、同一服务器及来源配置。
    </p>
    <el-button v-if="cursor" :disabled="busy" @click="load(true)">加载更多</el-button>
  </section>
</template>
<style scoped>
.apk-upload {
  display: inline-flex;
  position: relative;
  overflow: hidden;
  padding: 7px 12px;
  border: 1px solid #32715d;
  border-radius: 6px;
  color: #266650;
  cursor: pointer;
  white-space: nowrap;
}
.apk-upload input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  max-width: 100%;
}
.row-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.data-table small {
  display: block;
  margin-top: 7px;
  max-width: 260px;
  overflow-wrap: anywhere;
}
</style>
