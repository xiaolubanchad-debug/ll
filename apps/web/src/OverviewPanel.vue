<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { OverviewView } from '@apk/contracts';
import { api } from './api';
import { categoryLabels, stateLabels, today, when } from './console-format';
import { href, navigate } from './navigation';
import { purposeLabels, reasonLabels } from './result-labels';
const data = ref<OverviewView | null>(null),
  day = ref(today()),
  error = ref(''),
  busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  if (busy.value) return;
  busy.value = true;
  const requestedDay = day.value;
  try {
    const result = await api<OverviewView>('/console/overview?day=' + day.value);
    if (requestedDay === day.value) data.value = result;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取统计失败';
  } finally {
    busy.value = false;
    if (requestedDay !== day.value) void load();
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (!document.hidden) void load();
  }, 5000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <div class="console-stack">
    <div class="toolbar">
      <label>统计日期（北京时间）<input v-model="day" type="date" @change="load" /></label
      ><el-button :disabled="busy" @click="load">刷新统计</el-button
      ><span v-if="data" class="muted">更新于 {{ when(data.generatedAt) }}</span>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="data">
      <div class="metric-grid">
        <a class="metric-card" :href="href('runs', '', { executionKind: 'APP_OPEN', day })"
          ><span>APP 打开完成</span><strong>{{ data.appOpens?.completed ?? '—' }}</strong
          ><small>已尝试 {{ data.appOpens?.attempts ?? '—' }} · 前台停留 10 秒并清理</small></a
        >
        <a
          class="metric-card"
          :href="href('runs', '', { executionKind: 'APP_OPEN', status: 'FAILED' })"
          ><span>APP 执行失败</span><strong>{{ data.appOpens?.failed ?? '—' }}</strong
          ><small
            >待核验 {{ data.appOpens?.needsReview ?? '—' }} · 执行中
            {{ data.appOpens?.pending ?? '—' }}</small
          ></a
        >
        <a class="metric-card" :href="href('test-data')"
          ><span>自有测试数据上报</span><strong>{{ data.appOpens?.testReports ?? '—' }}</strong
          ><small>真实账户记录 · 查看全部测试数据</small></a
        >
        <a class="metric-card" :href="href('assets', '', { day })"
          ><span>APK 下载校验成功</span><strong>{{ data.downloads.validated }}</strong
          ><small>下载失败 {{ data.downloads.failed }} · 查看资源 →</small></a
        >
      </div>
      <p class="muted">
        打开完成与自有账户上报独立统计。业务日期按北京时间计算，打开完成不代表第三方 APP 注册成功。
      </p>
      <details class="surface legacy-summary">
        <summary>历史账户流程统计</summary>
        <div class="metric-grid">
          <a
            v-for="key in ['SUCCESS', 'REJECTED', 'ERROR', 'ADAPTATION', 'UNKNOWN'] as const"
            :key="key"
            class="metric-card"
            :href="
              href('results', '', {
                from: day,
                to: day,
                category: key,
                ...(key === 'UNKNOWN' ? { review: 'OPEN' } : {}),
              })
            "
            ><span>{{ key === 'UNKNOWN' ? '待核验' : categoryLabels[key] }}</span
            ><strong :class="'ink-' + key.toLowerCase()">{{
              key === 'UNKNOWN'
                ? data.registrations.UNKNOWN - data.reviewedUnknown
                : data.registrations[key]
            }}</strong
            ><small>查看对应注册记录 →</small></a
          >
        </div>
        <p class="muted">
          统计覆盖数据库中的全部记录；未知结果中已有
          {{ data.reviewedUnknown }} 条人工决议，原始未知记录保留。系统验收不计入产品注册。
        </p>
      </details>
      <section class="surface">
        <div class="section-heading">
          <div>
            <h2>当前执行与待处理</h2>
            <p class="muted">
              在线 {{ data.servers.online }} / {{ data.servers.total }} 台 · 占用
              {{ data.servers.busy }} 台 · 隔离待核验 {{ data.servers.quarantined }} 台
            </p>
          </div>
          <el-button @click="navigate('nodes')">进入服务器工作台</el-button>
        </div>
        <div v-if="!data.activeRuns.length" class="empty-state">
          <h3>当前没有执行中的批次</h3>
          <p>在服务器列表选择任务配置，点击开始后自动下载、安装并打开 APP。</p>
          <el-button @click="navigate('nodes')">配置并开始任务</el-button>
        </div>
        <div v-for="run in data.activeRuns" :key="run.id" class="execution-row">
          <div>
            <strong>{{ run.configName }}</strong>
            <p>
              {{ run.nodeName }} ·
              {{
                run.executionKind === 'APP_OPEN'
                  ? 'APP 启动停留'
                  : (purposeLabels[run.purpose] ?? run.purpose)
              }}
              ·
              {{ stateLabels[run.status] ?? run.status }}
            </p>
            <small v-if="run.errorCode">{{ reasonLabels[run.errorCode] ?? run.errorCode }}</small>
          </div>
          <div>
            <p v-if="run.purpose === 'REGISTER'">
              {{ run.executionKind === 'APP_OPEN' ? '完成轮数' : '成功账户' }} {{ run.successes }} /
              {{ run.successTarget }} · 尝试 {{ run.attemptsStarted }} /
              {{ run.attemptLimit }}
            </p>
            <a :href="href('runs', run.id)">查看详情与日志 →</a>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
