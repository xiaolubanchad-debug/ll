<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { configurationIssues, loginIssues, passwordChangeIssues } from '@apk/contracts';
import example from '../../../contracts/fixtures/config.valid.json';
import { api, RequestError, useSession } from './api';
import type { SessionView, Row, Page } from './api';

type Section = 'overview' | 'nodes' | 'runs' | 'config' | 'security';
const session = ref<SessionView | null>(null),
  loading = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const section = ref<Section>('overview'),
  username = ref(''),
  password = ref('');
const nodes = ref<Row[]>([]),
  runs = ref<Row[]>([]),
  audit = ref<Row[]>([]),
  auditCursor = ref<string | null>(null);
const currentPassword = ref(''),
  newPassword = ref(''),
  confirmation = ref('');
const sourceUrl = ref(''),
  xpath = ref(example.source.xpath),
  validationResult = ref('');
const validationOk = ref(false);
const sample = structuredClone(example);
sample.source.url = '';
sample.execution.mode = 'DOWNLOAD_ONLY';
sample.registrationFlows = [];
const draftText = ref(JSON.stringify(sample, null, 2));
const labels: Record<Section, string> = {
  overview: '工作台',
  nodes: '服务器',
  runs: '测试任务',
  config: '配置校验',
  security: '账户安全',
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
    const [n, r, a] = await Promise.all([
      api<Page>('/nodes'),
      api<Page>('/runs'),
      api<Page>('/audit-events'),
    ]);
    nodes.value = n.items;
    runs.value = r.items;
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
    nodes.value = [];
    runs.value = [];
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
    validationResult.value = '前端与服务端校验通过。当前仅校验草稿，尚未保存或下发。';
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
        <span class="status-dot"></span> 工程基础已就绪
        <p>P0 · 部署与执行待后续阶段接入</p>
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
                  ? '管理基础已建立，后续从这里接入服务器与测试流程。'
                  : section === 'config'
                    ? '使用统一规则检查测试配置，避免无效内容进入执行节点。'
                    : '所有记录来自当前中台数据库。'
              }}
            </p>
          </div>
          <span class="phase-tag">P0 工程基础</span>
        </div>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
        <template v-if="section === 'overview'">
          <div class="stats">
            <article>
              <span>服务器</span><strong>{{ nodes.length }}</strong
              ><small>已接入节点</small>
            </article>
            <article>
              <span>测试任务</span><strong>{{ runs.length }}</strong
              ><small>最近任务记录</small>
            </article>
            <article>
              <span>管理身份</span><strong class="text-stat">超级管理员</strong
              ><small>账户与基础权限已启用</small>
            </article>
          </div>
          <section class="surface next-step">
            <div>
              <span class="phase-tag">接下来的阶段</span>
              <h2>连接你的第一台执行服务器</h2>
              <p>
                服务器接入与一键部署将在 P1 提供。当前可检查配置格式、管理登录安全，并查看操作记录。
              </p>
            </div>
            <el-button @click="section = 'config'">检查测试配置 →</el-button>
          </section>
          <section class="surface">
            <h2>最近操作</h2>
            <el-table :data="audit.slice(0, 8)" empty-text="暂无操作记录"
              ><el-table-column label="操作"
                ><template #default="scope">{{
                  actionLabels[scope.row.action] ?? scope.row.action
                }}</template></el-table-column
              ><el-table-column label="时间（北京时间）"
                ><template #default="scope">{{
                  when(scope.row.createdAt)
                }}</template></el-table-column
              ></el-table
            >
          </section>
        </template>
        <section v-else-if="section === 'nodes'" class="surface">
          <h2>服务器列表</h2>
          <p class="muted">服务器录入、SSH 连接和部署将在 P1 接入。</p>
          <el-table :data="nodes" empty-text="尚未接入服务器"
            ><el-table-column prop="name" label="名称" /><el-table-column prop="host" label="地址"
          /></el-table>
        </section>
        <section v-else-if="section === 'runs'" class="surface">
          <h2>测试任务列表</h2>
          <p class="muted">任务创建和执行将在后续阶段开放。</p>
          <el-table :data="runs" empty-text="暂无测试任务"
            ><el-table-column prop="id" label="任务编号" /><el-table-column
              prop="status"
              label="状态"
          /></el-table>
        </section>
        <section v-else-if="section === 'config'" class="surface config-form">
          <h2>测试配置草稿</h2>
          <p class="muted">仅执行格式校验，不访问网站、不下载或注册。</p>
          <label for="source-url">网站 URL</label
          ><el-input
            id="source-url"
            v-model="sourceUrl"
            placeholder="https://example.com"
            @input="syncSource"
          />
          <label for="xpath">图标 XPath</label
          ><el-input id="xpath" v-model="xpath" type="textarea" :rows="3" @input="syncSource" />
          <label for="config-json">完整配置 JSON</label
          ><textarea
            id="config-json"
            v-model="draftText"
            class="json-editor"
            spellcheck="false"
            @input="syncFormFromJson"
          />
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
        </section>
        <template v-else-if="section === 'security'">
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
