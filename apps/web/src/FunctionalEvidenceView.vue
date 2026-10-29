<script setup lang="ts">
import { computed } from 'vue';
import type { FunctionalEvidence } from '@apk/contracts';
const props = defineProps<{ evidence: FunctionalEvidence }>();
const roles = {
  USERNAME: '用户名输入框',
  PASSWORD: '密码输入框',
  PASSWORD_CONFIRM: '确认密码输入框',
  REGISTER: '注册入口',
  LOGIN: '登录入口',
  ACCOUNT: '账号入口',
  CONSENT: '同意按钮',
  RESULT: '结果标识',
};
const box = computed(() => {
  const c = props.evidence.controls;
  return `0 0 ${Math.max(360, ...c.map((c) => c.rect.x + c.rect.width + 16))} ${Math.max(400, ...c.map((c) => c.rect.y + c.rect.height + 16))}`;
});
</script>
<template>
  <section class="functional-evidence">
    <p><strong>功能结构示意 · 非原始 APP 画面</strong></p>
    <p>
      记录阶段：{{ evidence.stage === 'RESULT' ? '注册结果核验' : '入口与页面检查' }} ·
      {{
        { SUCCEEDED: 'APP 已明确显示成功', FAILED: 'APP 已明确拒绝', UNVERIFIED: '未确认注册结果' }[
          evidence.outcome
        ]
      }}
    </p>
    <p class="muted">
      内容隔离已开启。没有原始图片、视频、正文或输入值；示意图本身不作为注册成功证明。
    </p>
    <svg
      v-if="evidence.controls.length"
      :viewBox="box"
      role="img"
      aria-label="功能控件结构示意，非 APP 截图"
      style="width: 100%; max-height: 480px; background: #f5f7fa"
    >
      <g v-for="(control, i) in evidence.controls" :key="i">
        <rect
          :x="control.rect.x"
          :y="control.rect.y"
          :width="control.rect.width"
          :height="control.rect.height"
          fill="#e7f0ed"
          stroke="#326b5d"
        />
        <text
          :x="control.rect.x + 6"
          :y="control.rect.y + Math.min(24, control.rect.height * 0.7)"
          fill="#173b32"
          font-size="16"
        >
          {{ roles[control.role] }}
        </text>
      </g>
    </svg>
    <p v-else class="muted">此记录没有可明确标注的功能控件，未推测或补画 APP 内容。</p>
    <p class="fingerprint">界面核验摘要：{{ evidence.sourceDigest }}</p>
  </section>
</template>
