<script setup lang="ts">
import { ref, reactive } from 'vue';
import { configurationIssues } from '@apk/contracts';
import type { TestConfiguration } from '@apk/contracts';
const props = defineProps<{ draftText: string }>();
const emit = defineEmits<{ load: [value: string] }>();
const packageName = ref(''),
  entryId = ref(''),
  activity = ref(''),
  error = ref(''),
  notice = ref('');
type By = 'id' | 'xpath' | 'accessibilityId';
const fields = reactive<{ key: string; label: string; required: boolean; by: By; value: string }[]>(
  [
    { key: 'open', label: '打开注册页的按钮（可选）', required: false, by: 'id', value: '' },
    { key: 'username', label: '用户名输入框', required: true, by: 'id', value: '' },
    { key: 'password', label: '密码输入框', required: true, by: 'id', value: '' },
    { key: 'confirm', label: '确认密码输入框（可选）', required: false, by: 'id', value: '' },
    { key: 'submit', label: '提交注册按钮', required: true, by: 'id', value: '' },
    { key: 'success', label: '注册成功标识', required: true, by: 'id', value: '' },
    { key: 'failure', label: '明确注册失败标识（可选）', required: false, by: 'id', value: '' },
  ],
);
function apply() {
  error.value = '';
  notice.value = '';
  try {
    const body = JSON.parse(props.draftText) as TestConfiguration;
    if (
      (!entryId.value.trim() && (!packageName.value.trim() || !activity.value.trim())) ||
      fields.some((f) => f.required && !f.value.trim())
    )
      throw Error('请填写包名、启动页面和所有必填控件');
    const old = body.registrationFlows.find((f) =>
      entryId.value.trim()
        ? f.entryId === entryId.value.trim()
        : !f.entryId && f.packageName === packageName.value.trim(),
    );
    if (
      old &&
      (old.steps.length > 5 || old.steps.some((s) => s.action === 'back' || s.action === 'wait'))
    )
      throw Error('此 APK 已配置多步骤流程，请在完整配置中保留并单独适配');
    type Flow = TestConfiguration['registrationFlows'][number];
    const locator = (key: string) => {
      const f = fields.find((f) => f.key === key)!;
      return { by: f.by, value: f.value.trim() };
    };
    const has = (key: string) => !!fields.find((f) => f.key === key)!.value.trim();
    const steps: Flow['steps'] = [];
    if (has('open'))
      steps.push({ action: 'click', locator: locator('open'), timeoutMs: 20000, optional: false });
    steps.push(
      {
        action: 'input',
        locator: locator('username'),
        text: '{username}',
        timeoutMs: 20000,
        optional: false,
      },
      {
        action: 'input',
        locator: locator('password'),
        text: '{password}',
        timeoutMs: 20000,
        optional: false,
      },
    );
    if (has('confirm'))
      steps.push({
        action: 'input',
        locator: locator('confirm'),
        text: '{password}',
        timeoutMs: 20000,
        optional: false,
      });
    steps.push({ action: 'submit', locator: locator('submit'), timeoutMs: 20000, optional: false });
    const flow: Flow = {
      packageName: entryId.value.trim() ? '*' : packageName.value.trim(),
      activity: entryId.value.trim() ? '@launcher' : activity.value.trim(),
      ...(entryId.value.trim() ? { entryId: entryId.value.trim() } : {}),
      enabled: true,
      steps,
      success: { locator: locator('success'), timeoutMs: 60000 },
      ...(has('failure') ? { failure: { locator: locator('failure'), timeoutMs: 10000 } } : {}),
    };
    body.registrationFlows = body.registrationFlows.filter((f) =>
      flow.entryId ? f.entryId !== flow.entryId : !!f.entryId || f.packageName !== flow.packageName,
    );
    body.registrationFlows.push(flow);
    if (configurationIssues(body).length)
      throw Error('流程或当前草稿不符合配置规则，请核对包名、启动页面和控件定位');
    emit('load', JSON.stringify(body, null, 2));
    notice.value = '注册流程已应用到草稿；绑定代理后，请保存草稿为新版本。运行中的任务不会改变。';
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
    <summary>添加基础注册流程</summary>
    <p class="muted">
      适用于用户名、密码和提交按钮在同一页面的 APP。包名、启动页面和控件需从实际 APK
      界面核对；账户和密码由系统随机生成，不在这里填写。多页面流程需单独适配。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <label for="flow-entry">图标入口 PID（每日换包时填写）</label
    ><el-input
      id="flow-entry"
      v-model="entryId"
      placeholder="从图标 XPath 或下载任务中读取，如 2692"
    />
    <p v-if="entryId" class="muted">
      每天自动读取该入口的新包名和启动页面。控件 ID 中的包名前缀可写为
      {packageName}。注册界面改变时需重新适配。
    </p>
    <label for="flow-package">APK 包名</label
    ><el-input
      id="flow-package"
      v-model="packageName"
      :disabled="!!entryId"
      placeholder="从实际 APK 读取"
    />
    <label for="flow-activity">APP 启动页面</label
    ><el-input
      id="flow-activity"
      v-model="activity"
      :disabled="!!entryId"
      placeholder="从实际 APK 读取"
    />
    <div v-for="field in fields" :key="field.key">
      <label :for="'flow-by-' + field.key">{{ field.label }} · 定位方式</label
      ><select :id="'flow-by-' + field.key" v-model="field.by">
        <option value="id">控件 ID</option>
        <option value="xpath">页面路径 XPath</option>
        <option value="accessibilityId">无障碍标签</option>
      </select>
      <label :for="'flow-value-' + field.key">{{ field.label }} · 定位值</label
      ><el-input
        :id="'flow-value-' + field.key"
        v-model="field.value"
        placeholder="由实际 APP 界面核对填写"
      />
    </div>
    <el-button @click="apply">应用基础注册流程到草稿</el-button>
  </details>
</template>
