<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { api, mutation } from './api';
import type { RegistrationRecognition } from '@apk/contracts';
const props = defineProps<{
  task: {
    id: string;
    status: string;
    accountAvailable?: boolean;
    recognition?: RegistrationRecognition;
    observation?: {
      model: string;
      locale: string;
      shellAndroidIdHash: string;
      proxyObservedIp: string;
      proxyObservedAt: string;
    };
    reviews?: { outcome: string; reason: string }[];
  };
}>();
const emit = defineEmits<{ updated: [] }>();
const artifacts = ref<{ id: string; recordedForReview: boolean }[]>([]),
  reason = ref(''),
  account = ref<{ username: string; password: string } | null>(null),
  error = ref(''),
  busy = ref(false),
  outcome = ref('FAILED'),
  reviewReason = ref(''),
  images = ref(false);
let clearTimer: ReturnType<typeof setTimeout> | undefined;
function clearAccount() {
  account.value = null;
  clearTimeout(clearTimer);
}
async function work(action: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
async function view() {
  await work(async () => {
    clearAccount();
    account.value = await api('/tasks/' + props.task.id + '/account-view', 'POST', {
      reason: reason.value,
    });
    reason.value = '';
    clearTimer = setTimeout(clearAccount, 30000);
  });
}
async function evidence() {
  await work(async () => {
    artifacts.value = (
      await api<{ items: typeof artifacts.value }>('/tasks/' + props.task.id + '/artifacts')
    ).items;
    images.value = true;
  });
}
async function review() {
  await work(async () => {
    await mutation('/tasks/' + props.task.id + '/reconciliations', {
      outcome: outcome.value,
      reason: reviewReason.value,
      evidenceIds: artifacts.value.map((a) => a.id),
    });
    reviewReason.value = '';
    emit('updated');
  });
}
function visibility() {
  if (document.hidden) clearAccount();
}
document.addEventListener('visibilitychange', visibility);
onUnmounted(() => {
  clearAccount();
  document.removeEventListener('visibilitychange', visibility);
});
</script>
<template>
  <section class="surface">
    <h3>注册证据</h3>
    <p class="fingerprint">{{ task.id }}</p>
    <template v-if="task.recognition">
      <p>
        注册路径：{{
          { CONTROLS: '页面控件识别', OCR: '本地图片入口识别', LEARNED: '复用已验证路径' }[
            task.recognition.source
          ]
        }}
        · 已导航 {{ task.recognition.navigationSteps }} 步
      </p>
      <p>
        路径缓存：{{
          { MISS: '首次识别', HIT: '已核对复用', INVALIDATED: '旧路径变化，重新识别' }[
            task.recognition.cache
          ]
        }}
        · {{ task.recognition.learned ? '已保存成功路径' : '未保存新的成功路径' }}
      </p>
      <p v-if="task.recognition.needsAdaptation">
        当前页面需要适配，可查看下方脱敏截图；剩余未执行次数未计入尝试。
      </p>
      <p v-if="task.recognition.automaticIdentity">
        自动身份：{{
          task.recognition.automaticIdentity.kind === 'GUEST' ? '游客' : 'APP 分配的身份'
        }}。 仅记录当前 APP 页面观察，不计入注册成功数。
      </p>
    </template>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="task.observation"
      ><p>模拟器实际型号：{{ task.observation.model }} · 语言：{{ task.observation.locale }}</p>
      <p class="fingerprint">Shell Android ID 摘要：{{ task.observation.shellAndroidIdHash }}</p>
      <p>
        代理探测出口：{{ task.observation.proxyObservedIp }} ·
        {{ task.observation.proxyObservedAt }}
      </p>
      <p class="muted">
        这是模拟器及 Shell 作用域的观测，不能代表真实手机或 App 读取的设备 ID。App UA
        未验证；轮询代理的注册出口未确认。
      </p></template
    >
    <el-button :disabled="busy" @click="evidence">查看脱敏截图</el-button>
    <div v-if="images">
      <p v-if="!artifacts.length" class="muted">尚无已上传截图</p>
      <figure v-for="a in artifacts" :key="a.id">
        <img
          :src="'/api/v1/artifacts/' + a.id + '/content'"
          alt="注册流程脱敏截图"
          style="max-width: 100%; max-height: 640px"
          referrerpolicy="no-referrer"
        />
        <figcaption v-if="a.recordedForReview">迟到证据，仅供人工核验</figcaption>
      </figure>
    </div>
    <label for="account-reason">查看测试账户的原因</label
    ><el-input id="account-reason" v-model="reason" maxlength="300" />
    <el-button :disabled="busy || !reason.trim() || task.accountAvailable === false" @click="view"
      >审计后查看账户</el-button
    >
    <p v-if="task.accountAvailable === false" class="muted">此轮尚无已保存账户。</p>
    <div v-if="account">
      <p>用户名：{{ account.username }}</p>
      <p>密码：{{ account.password }}</p>
      <el-button @click="clearAccount">隐藏账户</el-button
      ><small>30 秒后自动隐藏；账户不保存在浏览器本地存储。</small>
    </div>
    <template v-if="task.status === 'UNKNOWN'"
      ><p class="muted">提交结果未知，系统不会重试注册。请核对 APK 产品后台后记录决议。</p>
      <label for="review-outcome">核验结果</label
      ><select id="review-outcome" v-model="outcome">
        <option value="FAILED">已确认未注册成功</option>
        <option value="SUCCEEDED">已确认注册成功</option></select
      ><label for="review-reason">核验说明（至少 10 字）</label
      ><el-input
        id="review-reason"
        v-model="reviewReason"
        type="textarea"
        maxlength="1000"
      /><el-button :disabled="busy || reviewReason.trim().length < 10" @click="review"
        >记录人工核验决议</el-button
      >
      <p v-for="(r, i) in task.reviews" :key="i">
        最近决议：{{ r.outcome === 'SUCCEEDED' ? '已确认成功' : '已确认失败' }} · {{ r.reason }}
      </p></template
    >
  </section>
</template>
