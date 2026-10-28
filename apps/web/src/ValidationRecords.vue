<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { ValidationListView } from '@apk/contracts';
import { api } from './api';
import { when, stateLabels } from './console-format';
const rows = ref<ValidationListView['items']>([]),
  cursor = ref<string | null>(null),
  error = ref('');
async function load(append = false) {
  try {
    const p = await api<ValidationListView>(
      '/console/validations?limit=20' + (append && cursor.value ? '&cursor=' + cursor.value : ''),
    );
    rows.value = append ? [...rows.value, ...p.items] : p.items;
    cursor.value = p.nextCursor;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '验收记录读取失败';
  }
}
onMounted(() => void load());
</script>
<template>
  <section class="surface">
    <h2>系统验收记录</h2>
    <p class="muted">自有 APK 与受控服务的验证记录。这里的成功不计入真实产品注册成功数。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-for="r in rows" :key="r.id" class="validation-row">
      <strong>{{ r.nodeName }} · {{ r.passed ? '用例验收通过' : '用例未全部通过' }}</strong
      ><small
        >{{ when(r.createdAt) }} · {{ r.cleanupComplete ? '已确认清理' : '清理尚未确认' }}</small
      >
      <ul>
        <li v-for="c in r.cases" :key="c.name">
          {{ c.name }} · {{ stateLabels[c.status] ?? c.status }} · 请求 {{ c.requests }} 次 ·
          {{
            c.proof === 'APP_UI' ? 'APP 页面证明' : c.proof === 'NONE' ? '无确定结果证明' : c.proof
          }}
        </li>
      </ul>
    </div>
    <p v-if="!rows.length" class="empty-state">尚无独立系统验收记录。</p>
    <el-button v-if="cursor" @click="load(true)">加载更早验收</el-button>
  </section>
</template>
