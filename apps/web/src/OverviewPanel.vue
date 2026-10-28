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
        ><a class="metric-card" :href="href('assets', '', { day })"
          ><span>APK 下载校验成功</span><strong>{{ data.downloads.validated }}</strong
          ><small>下载失败 {{ data.downloads.failed }} · 查看资源 →</small></a
        >
      </div>
      <p class="muted">
        统计覆盖数据库中的全部记录；未知结果中已有
        {{ data.reviewedUnknown }} 条人工决议，原始未知记录保留。系统验收不计入产品注册。
      </p>
      <section class="surface">
        <div class="section-heading">
          <div>
            <h2>当前执行与待处理</h2>
            <p class="muted">
              在线 {{ data.servers.online }} / {{ data.servers.total }} 台 · 占用
              {{ data.servers.busy }} 台 · 隔离待核验 {{ data.servers.quarantined }} 台
            </p>
          </div>
          <el-button @click="navigate('runs')">创建执行</el-button>
        </div>
        <div v-if="!data.activeRuns.length" class="empty-state">
          <h3>当前没有执行中的批次</h3>
          <p>保存任务方案后，先下载当天 APK，再开始注册或开启每日计划。</p>
          <el-button @click="navigate('config')">配置任务方案</el-button>
        </div>
        <div v-for="run in data.activeRuns" :key="run.id" class="execution-row">
          <div>
            <strong>{{ run.configName }}</strong>
            <p>
              {{ run.nodeName }} · {{ purposeLabels[run.purpose] ?? run.purpose }} ·
              {{ stateLabels[run.status] ?? run.status }}
            </p>
            <small v-if="run.errorCode">{{ reasonLabels[run.errorCode] ?? run.errorCode }}</small>
          </div>
          <div>
            <p v-if="run.purpose === 'REGISTER'">
              成功 {{ run.successes }} / {{ run.successTarget }} · 尝试 {{ run.attemptsStarted }} /
              {{ run.attemptLimit }}
            </p>
            <a :href="href('runs', run.id)">查看详情与日志 →</a>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
