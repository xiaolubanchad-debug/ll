<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import type {
  RegistrationListView,
  RegistrationDetailView,
  NodeView,
  ResultCategory,
} from '@apk/contracts';
import { api } from './api';
import { categoryLabels, stateLabels, today, when, duration } from './console-format';
import { reasonLabels } from './result-labels';
import { route, navigate, href } from './navigation';
import TaskEvidence from './TaskEvidence.vue';
const items = ref<RegistrationListView['items']>([]),
  cursor = ref<string | null>(null),
  nodes = ref<NodeView[]>([]),
  detail = ref<RegistrationDetailView | null>(null),
  busy = ref(false),
  error = ref(''),
  history = ref(false);
const from = ref(route.value.query.get('from') ?? today()),
  to = ref(route.value.query.get('to') ?? today()),
  node = ref(route.value.query.get('nodeId') ?? ''),
  category = ref(route.value.query.get('category') ?? ''),
  q = ref(route.value.query.get('q') ?? ''),
  review = ref(route.value.query.get('review') ?? '');
let generation = 0,
  pendingReset = false,
  active = true,
  timer: ReturnType<typeof setInterval> | undefined;
function filters() {
  return {
    from: from.value,
    to: to.value,
    nodeId: node.value,
    category: category.value,
    q: q.value,
    review: review.value,
  };
}
async function load(append = false) {
  if (busy.value) {
    if (!append) pendingReset = true;
    return;
  }
  busy.value = true;
  error.value = '';
  const current = generation;
  try {
    const query = new URLSearchParams(
      Object.entries({
        ...filters(),
        limit: '30',
        ...(append && cursor.value ? { cursor: cursor.value } : {}),
      }).filter(([, v]) => v),
    );
    const page = await api<RegistrationListView>('/registrations?' + query);
    if (current !== generation) return;
    items.value = append ? [...items.value, ...page.items] : page.items;
    cursor.value = page.nextCursor;
    history.value = append;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取注册记录失败';
  } finally {
    busy.value = false;
    if (pendingReset && active) {
      pendingReset = false;
      void load();
    }
  }
}
async function loadDetail() {
  const id = route.value.query.get('task');
  detail.value = null;
  if (!id) return;
  try {
    const value = await api<RegistrationDetailView>('/registrations/' + encodeURIComponent(id));
    if (active && route.value.query.get('task') === id) detail.value = value;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '记录读取失败';
  }
}
function search() {
  navigate('results', '', filters());
  void load();
}
function open(id: string) {
  navigate('results', '', { ...filters(), task: id });
}
watch(category, (value) => {
  if (value && value !== 'UNKNOWN') review.value = '';
});
watch(
  () => route.value.key,
  () => {
    generation++;
    from.value = route.value.query.get('from') ?? today();
    to.value = route.value.query.get('to') ?? from.value;
    node.value = route.value.query.get('nodeId') ?? '';
    category.value = route.value.query.get('category') ?? '';
    q.value = route.value.query.get('q') ?? '';
    review.value = route.value.query.get('review') ?? '';
    void load();
    void loadDetail();
  },
);
onMounted(() => {
  void load();
  void loadDetail();
  void api<{ items: NodeView[] }>('/nodes?limit=100')
    .then((p) => {
      nodes.value = p.items;
    })
    .catch(() => {});
  timer = setInterval(() => {
    if (!history.value && !busy.value && !document.hidden) void load();
  }, 5000);
});
onUnmounted(() => {
  active = false;
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <div class="console-stack">
    <section class="surface">
      <div class="section-heading">
        <div>
          <h2>历史账户记录</h2>
          <p class="muted">
            保留旧账户流程及人工核验记录。当前 APP 打开结果见执行历史，自有客户端上报见测试数据。
          </p>
        </div>
        <el-button
          :disabled="busy"
          @click="
            history = false;
            load();
          "
          >刷新最新</el-button
        >
      </div>
      <form class="filter-grid" @submit.prevent="search">
        <label>开始日期<input v-model="from" type="date" /></label
        ><label>结束日期<input v-model="to" type="date" /></label
        ><label
          >服务器<select v-model="node" aria-label="服务器">
            <option value="">全部服务器</option>
            <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }}</option>
          </select></label
        ><label
          >结果<select v-model="category" aria-label="结果">
            <option value="">全部结果</option>
            <option v-for="(label, key) in categoryLabels" :key="key" :value="key">
              {{ label }}
            </option>
          </select></label
        ><label
          >未知结果核验<select v-model="review" aria-label="未知结果核验">
            <option value="">全部</option>
            <option value="OPEN">尚未人工核验</option>
            <option value="RESOLVED">已有人工决议</option>
          </select></label
        ><label>APP 或入口<input v-model="q" placeholder="包名或入口名称" maxlength="100" /></label
        ><el-button type="primary" native-type="submit" :disabled="busy">查询记录</el-button>
      </form>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <p v-if="history" class="muted">
        正在浏览历史分页，自动刷新已暂停；“刷新最新”返回当前筛选的最新记录。
      </p>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>开始时间</th>
              <th>APP / 入口</th>
              <th>服务器</th>
              <th>轮次</th>
              <th>结果</th>
              <th>最后阶段与原因</th>
              <th>耗时</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in items" :key="r.id">
              <td>{{ when(r.startedAt) }}</td>
              <td>
                <strong>{{ r.label || r.apk?.packageName || '未命名入口' }}</strong
                ><small>{{ r.apk?.packageName ?? '尚未取得 APK' }} · {{ r.configName }}</small>
              </td>
              <td>{{ r.nodeName }}</td>
              <td>{{ r.position }}</td>
              <td>
                <span :class="['result-badge', 'tone-' + r.category.toLowerCase()]">{{
                  categoryLabels[r.category as ResultCategory]
                }}</span
                ><small v-if="r.reviewOutcome"
                  >人工确认{{
                    r.reviewOutcome === 'SUCCEEDED' ? '成功' : '失败'
                  }}；原结果保留</small
                >
              </td>
              <td>
                {{ stateLabels[r.lastStage] ?? r.lastStage
                }}<small>{{
                  r.errorCode ? (reasonLabels[r.errorCode] ?? r.errorCode) : '—'
                }}</small>
              </td>
              <td>{{ duration(r.elapsedMs) }}</td>
              <td><el-button text @click="open(r.id)">查看详情</el-button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!items.length && !busy" class="empty-state">
        <h3>当前筛选下暂无注册记录</h3>
        <p>当前使用 APP 打开测试，此处仅显示旧账户流程历史。可调整日期查阅。</p>
        <a :href="href('runs')">查看执行历史 →</a>
      </div>
      <el-button v-if="cursor" :disabled="busy" @click="load(true)">加载更多注册记录</el-button>
    </section>
    <template v-if="detail"
      ><section class="surface">
        <div class="section-heading">
          <h2>第 {{ detail.record.position }} 轮 · {{ categoryLabels[detail.record.category] }}</h2>
          <el-button @click="navigate('results', '', filters())">收起详情</el-button>
        </div>
        <p>
          {{ detail.record.nodeName }} ·
          {{ detail.record.apk?.packageName ?? detail.record.label }} ·
          {{ when(detail.record.startedAt) }}
        </p>
        <p>
          {{
            detail.record.errorCode
              ? (reasonLabels[detail.record.errorCode] ?? detail.record.errorCode)
              : '暂无错误记录'
          }}
        </p>
        <a :href="href('runs', detail.record.runId, { task: detail.record.id })"
          >查看这一轮执行时间线 →</a
        >
      </section>
      <TaskEvidence
        :key="detail.record.id"
        :task="{
          id: detail.record.id,
          status: detail.record.status,
          accountAvailable: detail.record.hasAccount,
          recognition: detail.recognition ?? undefined,
          observation: detail.observation ?? undefined,
          reviews: detail.reviews,
        }"
        @updated="
          loadDetail();
          load();
        "
    /></template>
  </div>
</template>
