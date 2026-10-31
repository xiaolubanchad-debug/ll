<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import type { AssetListView } from '@apk/contracts';
import { api } from './api';
import { today, when } from './console-format';
import { route, href, navigate } from './navigation';
const day = ref(route.value.query.get('day') ?? today()),
  q = ref(route.value.query.get('q') ?? ''),
  items = ref<AssetListView['items']>([]),
  cursor = ref<string | null>(null),
  busy = ref(false),
  error = ref('');
async function load(append = false) {
  if (busy.value) return;
  busy.value = true;
  try {
    const p = await api<AssetListView>(
      '/apk-assets?' +
        new URLSearchParams({
          day: day.value,
          q: q.value,
          limit: '30',
          ...(append && cursor.value ? { cursor: cursor.value } : {}),
        }),
    );
    items.value = append ? [...items.value, ...p.items] : p.items;
    cursor.value = p.nextCursor;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '资源读取失败';
  } finally {
    busy.value = false;
  }
}
watch(
  () => route.value.key,
  () => {
    day.value = route.value.query.get('day') ?? today();
    q.value = route.value.query.get('q') ?? '';
    void load();
  },
);
onMounted(() => void load());
</script>
<template>
  <section class="surface">
    <h2>APK 校验记录</h2>
    <p class="muted">
      按下载日期查看已取得的包信息。历史记录不代表文件仍保留在节点；安装前执行端会再次核验缓存。
    </p>
    <form class="toolbar" @submit.prevent="navigate('assets', '', { day, q })">
      <label>下载日期<input v-model="day" type="date" /></label
      ><label>APP / 入口<input v-model="q" maxlength="100" placeholder="包名或入口名称" /></label
      ><el-button native-type="submit" :disabled="busy">查询 APK</el-button>
    </form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>入口 / 包名</th>
            <th>版本与架构</th>
            <th>服务器</th>
            <th>下载日期</th>
            <th>校验摘要</th>
            <th>关联执行</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id">
            <td>
              <strong>{{ r.label }}</strong
              ><small>{{ r.apk?.packageName }}</small>
            </td>
            <td>
              {{ r.apk?.versionName ?? '无版本名称' }} · {{ r.apk?.versionCode ?? '—'
              }}<small>{{ r.apk?.abis.join(', ') || '未声明原生架构' }}</small>
            </td>
            <td>{{ r.nodeName }}</td>
            <td>
              {{ r.apk?.cacheDay }}<small>{{ when(r.createdAt) }}</small>
            </td>
            <td class="fingerprint">{{ r.apk?.apkSha256.slice(0, 16) }}</td>
            <td><a :href="href('runs', r.runId)">查看下载日志</a></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!items.length && !busy" class="empty-state">
      当天尚无 APK 校验记录，请先完成下载任务。
    </p>
    <el-button v-if="cursor" :disabled="busy" @click="load(true)">加载更多 APK</el-button>
  </section>
</template>
