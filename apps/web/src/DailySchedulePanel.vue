<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import type { ScheduleInput, NodeView } from '@apk/contracts';
import { api, mutation } from './api';
import { dailyLabels, reasonLabels } from './result-labels';
const props = defineProps<{
  nodeId: string;
  configVersionId: string;
  releaseId: string;
  nodes: NodeView[];
  showProxy?: boolean;
}>();
interface Schedule {
  id: string;
  version: number;
  enabled: boolean;
  nodeId: string;
  body: ScheduleInput;
}
const schedules = ref<Schedule[]>([]),
  days = ref<{ id: string; day: string; status: string; errorCode: string | null }[]>([]),
  error = ref(''),
  notice = ref(''),
  busy = ref(false);
const time = ref('00:05'),
  enabled = ref(false),
  autoRegister = ref(true),
  successTarget = ref(10),
  attemptLimit = ref(30);
const selected = computed(() => schedules.value.find((s) => s.nodeId === props.nodeId));
const proxies = ref<{ id: string; createdAt: string }[]>([]),
  proxyId = ref('');
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
async function refresh() {
  schedules.value = (await api<{ items: Schedule[] }>('/schedules?limit=100')).items;
  proxies.value = (
    await api<{
      items: { id: string; type: string; createdAt: string; revokedAt: string | null }[];
    }>('/secrets?limit=100')
  ).items.filter((s) => s.type === 'HTTP_PROXY' && !s.revokedAt);
}
watch(
  () => [props.nodeId, selected.value?.version],
  () => {
    const body = selected.value?.body;
    time.value = body?.time ?? '00:05';
    enabled.value = body?.enabled ?? false;
    autoRegister.value = body?.autoRegister ?? true;
    successTarget.value = body?.successTarget ?? 10;
    attemptLimit.value = body?.attemptLimit ?? 30;
  },
);
async function save() {
  await action(async () => {
    const body: ScheduleInput = {
      nodeId: props.nodeId,
      configVersionId: props.configVersionId,
      releaseId: props.releaseId,
      enabled: enabled.value,
      autoRegister: autoRegister.value,
      time: time.value,
      timezone: 'Asia/Shanghai',
      successTarget: successTarget.value,
      attemptLimit: attemptLimit.value,
    };
    const old = selected.value;
    await mutation(
      old ? '/schedules/' + old.id : '/schedules',
      body,
      old ? { 'If-Match': String(old.version) } : {},
      old ? 'PUT' : 'POST',
    );
    await refresh();
    notice.value = '每日计划已保存；关闭计划后，活动任务仍需等待节点确认停止。';
  });
}
async function toggle(s: Schedule) {
  await action(async () => {
    await mutation(
      '/schedules/' + s.id,
      { ...s.body, enabled: !s.enabled },
      { 'If-Match': String(s.version) },
      'PUT',
    );
    await refresh();
    notice.value = s.enabled
      ? '关闭意图已保存，活动任务将安全停止'
      : '计划已开启，按北京时间执行；已过当日时间会补当天一次';
  });
}
async function checkProxy() {
  await action(async () => {
    const run = await mutation<{ resourceId: string }>('/runs', {
      nodeId: props.nodeId,
      configVersionId: props.configVersionId,
      releaseId: props.releaseId,
      purpose: 'PROXY_CHECK',
      proxySecretVersionId: proxyId.value,
    });
    notice.value = '代理检查已创建，请在任务列表查看结果：' + run.resourceId;
  });
}
onMounted(() => void action(refresh));
</script>
<template>
  <section class="surface config-form">
    <h2>每日下载与注册计划</h2>
    <p class="muted">
      使用上方选择的服务器和固定配置版本。每天下载一次；注册复用
      APK，每轮关闭旧模拟器后再创建新的。新功能需要 Agent 0.5.0。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <label for="daily-time">每日下载时间（北京时间）</label
    ><input id="daily-time" v-model="time" type="time" />
    <label for="daily-target">每日批次合计成功目标</label
    ><input id="daily-target" v-model.number="successTarget" type="number" min="1" max="1000" />
    <label for="daily-limit">每日批次总尝试上限</label
    ><input
      id="daily-limit"
      v-model.number="attemptLimit"
      type="number"
      :min="successTarget"
      max="1000"
    />
    <label class="inline-check"
      ><input v-model="autoRegister" type="checkbox" />下载完成后自动注册（需完整配置及代理）</label
    >
    <label class="inline-check"><input v-model="enabled" type="checkbox" />开启每日计划</label>
    <div class="form-actions">
      <el-button :disabled="busy || !nodeId || !configVersionId || !releaseId" @click="save"
        >保存每日计划</el-button
      >
    </div>
    <el-table :data="schedules" empty-text="尚未设置每日计划">
      <el-table-column label="服务器"
        ><template #default="s">{{
          nodes.find((n) => n.id === s.row.nodeId)?.name ?? s.row.nodeId
        }}</template></el-table-column
      >
      <el-table-column label="状态"
        ><template #default="s"
          >{{ s.row.enabled ? '已开启' : '已关闭' }} · {{ s.row.body.time }} · 成功
          {{ s.row.body.successTarget }} / 尝试 {{ s.row.body.attemptLimit }}</template
        ></el-table-column
      >
      <el-table-column label="操作"
        ><template #default="s"
          ><el-button text :disabled="busy" @click="toggle(s.row)">{{
            s.row.enabled ? '关闭计划' : '开启计划'
          }}</el-button
          ><el-button
            text
            @click="
              action(async () => {
                days = (await api<{ items: typeof days }>('/schedules/' + s.row.id + '/days'))
                  .items;
              })
            "
            >查看每日记录</el-button
          ></template
        ></el-table-column
      >
    </el-table>
    <el-table v-if="days.length" :data="days">
      <el-table-column prop="day" label="日期" />
      <el-table-column label="执行阶段"
        ><template #default="s">{{
          dailyLabels[s.row.status] ?? s.row.status
        }}</template></el-table-column
      >
      <el-table-column label="等待或结束原因"
        ><template #default="s">{{
          reasonLabels[s.row.errorCode ?? ''] ?? s.row.errorCode ?? '—'
        }}</template></el-table-column
      >
    </el-table>
  </section>
  <section v-if="showProxy !== false" class="surface config-form">
    <h2>代理连通检查</h2>
    <p class="muted">
      在选中的 EC2 上测试已保存代理，不安装或打开产品 APP。探测出口仅代表本次检查请求。
    </p>
    <label for="check-proxy">已保存的 HTTP 代理</label
    ><select id="check-proxy" v-model="proxyId">
      <option value="">请选择代理</option>
      <option v-for="(p, i) in proxies" :key="p.id" :value="p.id">
        代理 {{ i + 1 }} · {{ p.id.slice(0, 8) }}
      </option>
    </select>
    <el-button
      :disabled="busy || !proxyId || !nodeId || !configVersionId || !releaseId"
      @click="checkProxy"
      >在 EC2 上检查代理</el-button
    >
  </section>
</template>
