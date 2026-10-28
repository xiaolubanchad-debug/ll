<script setup lang="ts">
import { ref } from 'vue';
import { configurationIssues } from '@apk/contracts';
import type { TestConfiguration } from '@apk/contracts';
const props = defineProps<{ draftText: string }>(),
  emit = defineEmits<{ load: [value: string] }>();
const enabled = ref(false),
  ocr = ref(true),
  steps = ref(8),
  seconds = ref(60),
  verifySeconds = ref(60),
  error = ref(''),
  notice = ref('');
function read() {
  error.value = '';
  notice.value = '';
  try {
    const body = JSON.parse(props.draftText) as TestConfiguration,
      settings = body.execution.autoRegistration;
    enabled.value = settings?.enabled ?? false;
    ocr.value = settings?.screenshotFallback ?? true;
    steps.value = settings?.maxNavigationSteps ?? 8;
    seconds.value = (settings?.timeoutMs ?? 60000) / 1000;
    verifySeconds.value = (settings?.successTimeoutMs ?? 60000) / 1000;
  } catch {
    error.value = '当前配置 JSON 格式无效';
  }
}
function apply() {
  error.value = '';
  notice.value = '';
  try {
    const body = JSON.parse(props.draftText) as TestConfiguration;
    if (enabled.value) {
      if (body.execution.mode !== 'FULL' || !body.execution.proxySecretVersionId)
        throw Error('请先将代理应用到草稿，再开启自动识别注册');
      body.execution.autoRegistration = {
        enabled: true,
        screenshotFallback: ocr.value,
        maxNavigationSteps: steps.value,
        timeoutMs: seconds.value * 1000,
        successTimeoutMs: verifySeconds.value * 1000,
      };
    } else delete body.execution.autoRegistration;
    if (configurationIssues(body).length) throw Error('请核对识别步数、时间及当前配置');
    emit('load', JSON.stringify(body, null, 2));
    notice.value = '识别设置已应用到草稿，请保存为新版本；运行中的任务不会改变。';
  } catch (e) {
    error.value =
      e instanceof SyntaxError
        ? '当前配置 JSON 格式无效'
        : e instanceof Error
          ? e.message
          : '配置无效';
  }
}
</script>
<template>
  <details
    @toggle="
      (event) => {
        if ((event.target as HTMLDetailsElement).open) read();
      }
    "
  >
    <summary>自动识别注册入口</summary>
    <p class="muted">
      适用于不同 APP 的注册入口。已启用的手工流程优先；其他 APP 自动寻找入口和用户名、密码表单。需
      Agent 0.6.0。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <label><input v-model="enabled" type="checkbox" />开启自动寻找注册入口</label>
    <label><input v-model="ocr" type="checkbox" />允许本地图片文字识别注册入口</label>
    <label for="auto-nav-steps">最多寻找步数（1–12）</label
    ><input id="auto-nav-steps" v-model.number="steps" type="number" min="1" max="12" />
    <label for="auto-nav-seconds">寻找入口时限（15–90 秒）</label
    ><input id="auto-nav-seconds" v-model.number="seconds" type="number" min="15" max="90" />
    <label for="auto-verify-seconds">提交结果核验时限（1–60 秒）</label
    ><input
      id="auto-verify-seconds"
      v-model.number="verifySeconds"
      type="number"
      min="1"
      max="60"
    />
    <el-button @click="apply">将自动识别设置应用到草稿</el-button>
    <p class="muted">
      成功后保存并核对复用路径。图片识别在执行节点本地进行；输入框需能可靠读取。手机号、验证码或无法确定的页面会提示待适配并结束当前批次，结果未知时暂停核验。
    </p>
  </details>
</template>
