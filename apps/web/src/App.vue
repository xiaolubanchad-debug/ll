<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { configurationIssues, loginIssues, passwordChangeIssues } from '@apk/contracts';
import example from '../../../contracts/fixtures/config.valid.json';
import { api, RequestError, useSession } from './api';
import type { SessionView, Row, Page } from './api';
import ServerManager from './ServerManager.vue';
import ConfigManager from './ConfigManager.vue';
import ExecutionCenter from './ExecutionCenter.vue';
import RunDetail from './RunDetail.vue';
import OverviewPanel from './OverviewPanel.vue';
import RegistrationRecords from './RegistrationRecords.vue';
import ApkAssets from './ApkAssets.vue';
import ProxyManager from './ProxyManager.vue';
import ValidationRecords from './ValidationRecords.vue';
import { route, navigate } from './navigation';
import type { Section } from './navigation';

const session = ref<SessionView | null>(null),
  loading = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const section = computed<Section>({
    get: () => route.value.section,
    set: (value) => navigate(value),
  }),
  username = ref(''),
  password = ref('');
const audit = ref<Row[]>([]),
  auditCursor = ref<string | null>(null);
const currentPassword = ref(''),
  newPassword = ref(''),
  confirmation = ref('');
const executionMode = ref('DOWNLOAD_ONLY');
const sourceUrl = ref(''),
  xpath = ref(example.source.xpath),
  validationResult = ref('');
const validationOk = ref(false);
const sample = structuredClone(example);
sample.source.url = '';
sample.execution.mode = 'DOWNLOAD_ONLY';
Reflect.deleteProperty(sample.execution, 'proxySecretVersionId');
sample.registrationFlows = [];
const draftText = ref(JSON.stringify(sample, null, 2));
const labels: Record<Section, string> = {
  overview: '工作台',
  config: '任务方案',
  runs: '执行任务',
  results: '注册记录',
  assets: 'APK 资源',
  proxies: '代理管理',
  nodes: '服务器',
  security: '系统设置',
};
function message(e: unknown) {
  return e instanceof Error ? e.message : '操作失败，请稍后重试';
}
function signedIn(value: SessionView | null) {
  session.value = value;
  useSession(value);
}
async function refresh() {
  try {
    const a = await api<Page>('/audit-events');
    audit.value = a.items;
    auditCursor.value = a.nextCursor;
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) signedIn(null);
    throw e;
  }
}
async function login() {
  error.value = '';
  if (loginIssues({ username: username.value, password: password.value }).length) {
    error.value = '请填写有效的用户名和密码';
    return;
  }
  busy.value = true;
  try {
    signedIn(
      await api<SessionView>('/auth/login', 'POST', {
        username: username.value,
        password: password.value,
      }),
    );
    await refresh();
  } catch (e) {
    error.value = message(e);
  } finally {
    password.value = '';
    busy.value = false;
  }
}
async function logout() {
  busy.value = true;
  error.value = '';
  try {
    await api('/auth/logout', 'POST', {});
    signedIn(null);
    audit.value = [];
    notice.value = '';
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function changePassword() {
  error.value = '';
  notice.value = '';
  const input = { currentPassword: currentPassword.value, newPassword: newPassword.value };
  if (passwordChangeIssues(input).length) {
    error.value = '新密码需为12–128位';
    return;
  }
  if (newPassword.value !== confirmation.value) {
    error.value = '两次新密码输入不一致';
    return;
  }
  busy.value = true;
  try {
    signedIn(await api<SessionView>('/auth/password', 'PUT', input));
    notice.value = '密码已修改，其他登录会话已退出';
    await refresh();
  } catch (e) {
    error.value = message(e);
  } finally {
    currentPassword.value = '';
    newPassword.value = '';
    confirmation.value = '';
    busy.value = false;
  }
}
function syncMode() {
  try {
    const value = JSON.parse(draftText.value);
    value.execution.mode = executionMode.value;
    if (executionMode.value === 'DOWNLOAD_ONLY') {
      delete value.execution.proxySecretVersionId;
      delete value.execution.autoRegistration;
    }
    draftText.value = JSON.stringify(value, null, 2);
  } catch {
    error.value = '请先修正高级设置中的 JSON 格式';
  }
}
function syncSource() {
  try {
    const value: unknown = JSON.parse(draftText.value);
    if (
      value &&
      typeof value === 'object' &&
      'source' in value &&
      value.source &&
      typeof value.source === 'object'
    ) {
      Object.assign(value.source, { url: sourceUrl.value, xpath: xpath.value });
      draftText.value = JSON.stringify(value, null, 2);
    }
  } catch {
    /* JSON errors are presented when the administrator requests validation. */
  }
}
function syncFormFromJson() {
  try {
    const value: unknown = JSON.parse(draftText.value);
    if (
      value &&
      typeof value === 'object' &&
      'source' in value &&
      value.source &&
      typeof value.source === 'object'
    ) {
      const source = value.source as Record<string, unknown>;
      executionMode.value =
        (value as { execution?: { mode?: string } }).execution?.mode ?? 'DOWNLOAD_ONLY';
      if (typeof source.url === 'string') sourceUrl.value = source.url;
      if (typeof source.xpath === 'string') xpath.value = source.xpath;
    }
  } catch {
    /* Keep the last valid form values while JSON is being edited. */
  }
}
async function validate() {
  validationResult.value = '';
  validationOk.value = false;
  error.value = '';
  let value: unknown;
  try {
    value = JSON.parse(draftText.value);
  } catch {
    validationResult.value = 'JSON 格式无效，请检查后再试';
    return;
  }
  const issues = configurationIssues(value);
  if (issues.length) {
    validationResult.value =
      '校验未通过：' + issues.map((i) => `${i.path} ${i.message}`).join('；');
    return;
  }
  busy.value = true;
  try {
    await api('/configs/validate', 'POST', value);
    validationOk.value = true;
    validationResult.value = '前端与服务端校验通过。可保存为新版本后建立下载任务。';
  } catch (e) {
    validationResult.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function moreAudit() {
  if (!auditCursor.value) return;
  try {
    const page = await api<Page>('/audit-events?cursor=' + auditCursor.value);
    audit.value.push(...page.items);
    auditCursor.value = page.nextCursor;
  } catch (e) {
    error.value = message(e);
  }
}
function when(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}
const actionLabels: Record<string, string> = {
  ADMIN_INITIALIZED: '管理员初始化',
  LOGIN_SUCCEEDED: '登录成功',
  LOGIN_FAILED: '登录失败',
  PASSWORD_CHANGED: '修改密码',
  LOGOUT: '退出登录',
};
onMounted(async () => {
  try {
    signedIn(await api<SessionView>('/auth/me'));
    await refresh();
  } catch (e) {
    if (!(e instanceof RequestError && e.status === 401)) error.value = message(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-if="loading" class="loading" role="status">正在连接中台…</div>
  <main v-else-if="!session" class="login-shell">
    <section class="intro">
      <div class="brand"><span class="brand-icon">A</span> APK 部署中台</div>
      <div class="intro-copy">
        <p class="eyebrow">AUTOMATION CONTROL</p>
        <h1>从一个入口，<br />管理每次测试。</h1>
        <p>集中管理服务器、部署与执行结果。<br />让每一步都有记录，每次运行都可追溯。</p>
      </div>
      <p class="intro-foot">统一部署 · 配置管理 · 执行追踪</p>
    </section>
    <section class="login-panel">
      <div class="login-card">
        <span class="phase-tag">管理控制台</span>
        <h2>管理员登录</h2>
        <p class="muted">使用初始化时创建的管理员账户</p>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <form @submit.prevent="login">
          <label for="username">用户名</label
          ><el-input
            id="username"
            v-model="username"
            autocomplete="username"
            placeholder="请输入管理员用户名"
            maxlength="64"
            size="large"
          />
          <label for="password">密码</label
          ><el-input
            id="password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
            maxlength="128"
            show-password
            size="large"
          />
          <el-button
            class="login-button"
            type="primary"
            native-type="submit"
            size="large"
            :loading="busy"
            >登录中台</el-button
          >
        </form>
        <p class="login-hint">首次使用请先在服务器完成管理员初始化。</p>
      </div>
    </section>
  </main>
  <div v-else class="console-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-icon">A</span> APK 中台</div>
      <span class="nav-caption">管理空间</span>
      <nav aria-label="主导航">
        <button
          v-for="(label, key) in labels"
          :key="key"
          :class="{ active: section === key }"
          @click="
            section = key;
            error = '';
            notice = '';
          "
        >
          {{ label }}<span>↗</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <span class="status-dot"></span> 执行记录统一管理
        <p>1.7 · 执行结果与日志</p>
      </div>
    </aside>
    <div class="main-area">
      <header class="topbar">
        <span>管理空间 / {{ labels[section] }}</span>
        <div class="user-menu">
          <span class="avatar">{{ session.admin.username.slice(0, 1).toUpperCase() }}</span
          ><span>{{ session.admin.username }}</span
          ><el-button text :disabled="busy" @click="logout">退出登录</el-button>
        </div>
      </header>
      <main class="workspace">
        <div class="page-heading">
          <div>
            <p class="eyebrow">CONTROL CENTER</p>
            <h1>{{ labels[section] }}</h1>
            <p class="muted">
              {{
                section === 'overview'
                  ? '查看注册结果、下载进度及需要处理的问题。'
                  : section === 'config'
                    ? '设置网站、下载规则与注册方式，保存后在新执行中生效。'
                    : '所有记录来自当前中台数据库。'
              }}
            </p>
          </div>
          <span class="phase-tag">1.7 管理控制台</span>
        </div>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
        <OverviewPanel v-if="section === 'overview'" />
        <RegistrationRecords v-else-if="section === 'results'" />
        <ApkAssets v-else-if="section === 'assets'" />
        <ProxyManager v-else-if="section === 'proxies'" />
        <ServerManager v-else-if="section === 'nodes'" @changed="refresh" />
        <RunDetail v-else-if="section === 'runs' && route.id" :key="route.id" :run-id="route.id" />
        <ExecutionCenter v-else-if="section === 'runs'" />
        <section v-else-if="section === 'config'" class="surface config-form">
          <h2>任务方案设置</h2>
          <p class="muted">仅执行格式校验，不访问网站、不下载或注册。</p>
          <p class="muted">
            网页与落地页使用手机竖屏和触屏。网页 UA 留空时使用默认 Android 手机浏览器。 Agent 0.6.0
            支持入口自动识别、本地图片入口识别及循环注册；APP 画像和 UA 的采集情况不影响注册验收。
          </p>
          <label for="scheme-mode">执行模式</label
          ><select id="scheme-mode" v-model="executionMode" @change="syncMode">
            <option value="DOWNLOAD_ONLY">只下载 APK</option>
            <option value="FULL">下载并注册（需要代理）</option>
          </select>
          <label for="source-url">网站 URL</label
          ><el-input
            id="source-url"
            v-model="sourceUrl"
            placeholder="https://example.com"
            @input="syncSource"
          />
          <label for="xpath">图标 XPath</label
          ><el-input id="xpath" v-model="xpath" type="textarea" :rows="3" @input="syncSource" />
          <details class="advanced-settings">
            <summary>高级设置：完整配置 JSON</summary>
            <p class="muted">
              复杂落地页规则和设备配置在此编辑。修改后需保存新版本，运行中的任务保持原配置。
            </p>
            <label for="config-json">完整配置 JSON</label
            ><textarea
              id="config-json"
              v-model="draftText"
              class="json-editor"
              spellcheck="false"
              @input="syncFormFromJson"
            />
          </details>
          <div class="form-actions">
            <el-button type="primary" :loading="busy" @click="validate">校验配置</el-button
            ><span class="muted">草稿仅在当前页面内存中保留</span>
          </div>
          <p
            v-if="validationResult"
            class="validation-result"
            :class="{ 'validation-error': !validationOk }"
            role="status"
          >
            {{ validationResult }}
          </p>
          <ConfigManager
            :draft-text="draftText"
            @load="
              (value) => {
                draftText = value;
                syncFormFromJson();
              }
            "
          />
        </section>
        <template v-else-if="section === 'security'"
          ><ValidationRecords />
          <section class="surface security-form">
            <h2>修改管理员密码</h2>
            <p class="muted">新密码至少12位。修改后将撤销其他登录会话。</p>
            <form @submit.prevent="changePassword">
              <label for="current-password">当前密码</label
              ><el-input
                id="current-password"
                v-model="currentPassword"
                type="password"
                autocomplete="current-password"
                show-password
              /><label for="new-password">新密码</label
              ><el-input
                id="new-password"
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                show-password
                maxlength="128"
              /><label for="confirm-password">确认新密码</label
              ><el-input
                id="confirm-password"
                v-model="confirmation"
                type="password"
                autocomplete="new-password"
                show-password
                maxlength="128"
              /><el-button type="primary" native-type="submit" :loading="busy">更新密码</el-button>
            </form>
          </section>
          <section class="surface">
            <h2>账户操作记录</h2>
            <el-table :data="audit" empty-text="暂无记录"
              ><el-table-column label="操作"
                ><template #default="scope">{{
                  actionLabels[scope.row.action] ?? scope.row.action
                }}</template></el-table-column
              ><el-table-column label="时间"
                ><template #default="scope">{{
                  when(scope.row.createdAt)
                }}</template></el-table-column
              ></el-table
            ><el-button v-if="auditCursor" text @click="moreAudit">加载更早记录</el-button>
          </section>
        </template>
      </main>
      <footer class="footer">APK 部署中台 · 测试环境与执行记录统一管理</footer>
    </div>
  </div>
</template>
