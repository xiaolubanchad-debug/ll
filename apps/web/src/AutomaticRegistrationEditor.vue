<script setup lang="ts">
import { ref, watch } from 'vue';
import { configurationIssues } from '@apk/contracts';
import type { TestConfiguration } from '@apk/contracts';
const props = defineProps<{ draftText: string }>(),
  emit = defineEmits<{ load: [value: string] }>();
const enabled = ref(false),
  ocr = ref(true),
  steps = ref(8),
  seconds = ref(60),
  verifySeconds = ref(60),
  customStartup = ref(false),
  closeSeconds = ref(3),
  splashSeconds = ref(15),
  startupSeconds = ref(60),
  closeLimit = ref(12),
  closeIcons = ref(true),
  error = ref(''),
  notice = ref('');
function read(clear = true) {
  if (clear) {
    error.value = '';
    notice.value = '';
  }
  try {
    const body = JSON.parse(props.draftText) as TestConfiguration,
      settings = body.execution.autoRegistration;
    enabled.value = settings?.enabled ?? false;
    ocr.value = settings?.screenshotFallback ?? true;
    steps.value = settings?.maxNavigationSteps ?? 8;
    seconds.value = (settings?.timeoutMs ?? 60000) / 1000;
    verifySeconds.value = (settings?.successTimeoutMs ?? 60000) / 1000;
    customStartup.value = settings?.startup !== undefined;
    closeSeconds.value = (settings?.startup?.confirmationTimeoutMs ?? 3000) / 1000;
    splashSeconds.value = (settings?.startup?.splashTimeoutMs ?? 15000) / 1000;
    startupSeconds.value = (settings?.startup?.totalTimeoutMs ?? 60000) / 1000;
    closeLimit.value = settings?.startup?.maxActions ?? 12;
    closeIcons.value = settings?.startup?.iconRecognition ?? true;
  } catch {
    error.value = '当前配置 JSON 格式无效';
  }
}
watch(
  () => {
    try {
      return JSON.stringify(JSON.parse(props.draftText).execution?.autoRegistration ?? null);
    } catch {
      return 'INVALID';
    }
  },
  () => read(false),
  { immediate: true },
);
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
        ...(customStartup.value
          ? {
              startup: {
                confirmationTimeoutMs: closeSeconds.value * 1000,
                splashTimeoutMs: splashSeconds.value * 1000,
                totalTimeoutMs: startupSeconds.value * 1000,
                maxActions: closeLimit.value,
                iconRecognition: closeIcons.value,
              },
            }
          : {}),
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
  <details>
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
    <details>
      <summary>启动广告与弹窗处理</summary>
      <p class="muted">
        Agent 0.9.0 默认等待并确认关闭。图形识别在节点本地进行；仅处理已确认弹窗区域的关闭图标。
      </p>
      <label
        ><input v-model="customStartup" type="checkbox" />自定义处理上限（需要 Agent 0.9.0）</label
      >
      <template v-if="customStartup">
        <label for="startup-confirm">关闭确认窗口（1–5 秒）</label
        ><input id="startup-confirm" v-model.number="closeSeconds" type="number" min="1" max="5" />
        <label for="startup-splash">单次倒计时等待上限（1–45 秒）</label
        ><input id="startup-splash" v-model.number="splashSeconds" type="number" min="1" max="45" />
        <label for="startup-total">每次注册的处理总时限（10–90 秒）</label
        ><input
          id="startup-total"
          v-model.number="startupSeconds"
          type="number"
          min="10"
          max="90"
        />
        <label for="startup-limit">最多关闭次数（1–12）</label
        ><input id="startup-limit" v-model.number="closeLimit" type="number" min="1" max="12" />
        <label
          ><input v-model="closeIcons" type="checkbox" />允许在明确弹窗区域识别图形
          ×（同时需要本地图片识别）</label
        >
      </template>
    </details>
    <el-button @click="apply">将自动识别设置应用到草稿</el-button>
    <p class="muted">
      成功后保存并核对复用路径。图片识别在执行节点本地进行；输入框需能可靠读取。手机号、验证码或无法确定的页面会提示待适配并结束当前批次，结果未知时暂停核验。
    </p>
  </details>
</template>
