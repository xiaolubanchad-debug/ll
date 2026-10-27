<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { configurationIssues } from '@apk/contracts';
import { api, mutation } from './api';
const props = defineProps<{ draftText: string }>();
const emit = defineEmits<{ load: [value: string] }>();
interface Config {
  id: string;
  name: string;
  version: number;
  versions?: Version[];
}
interface Version {
  id: string;
  version: number;
  configHash: string;
  body?: unknown;
  createdAt: string;
}
const configs = ref<Config[]>([]),
  selected = ref<Config | null>(null),
  versions = ref<Version[]>([]),
  name = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  cursor = ref<string | null>(null);
async function action(work: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
async function refresh(append = false) {
  const p = await api<{ items: Config[]; nextCursor: string | null }>(
    '/configs' + (append && cursor.value ? '?cursor=' + cursor.value : ''),
  );
  configs.value = append ? [...configs.value, ...p.items] : p.items;
  cursor.value = p.nextCursor;
}
async function select(c: Config) {
  await action(async () => {
    selected.value = await api<Config>('/configs/' + c.id);
    versions.value = (
      await api<{ items: Version[] }>('/configs/' + c.id + '/versions?limit=100')
    ).items;
  });
}
async function create() {
  await action(async () => {
    const c = await mutation<Config>('/configs', { name: name.value });
    selected.value = c;
    versions.value = [];
    await refresh();
    notice.value = '配置已建立，可保存当前草稿为第一个版本';
  });
}
async function save() {
  if (!selected.value) return;
  await action(async () => {
    let body: unknown;
    try {
      body = JSON.parse(props.draftText);
    } catch {
      throw Error('配置 JSON 格式无效');
    }
    if (configurationIssues(body).length) throw Error('请先修正配置校验问题');
    await mutation('/configs/' + selected.value!.id + '/versions', body, {
      'If-Match': String(selected.value!.version),
    });
    selected.value = await api<Config>('/configs/' + selected.value!.id);
    versions.value = (
      await api<{ items: Version[] }>('/configs/' + selected.value.id + '/versions?limit=100')
    ).items;
    await refresh();
    notice.value = '已保存不可变版本，运行中的任务不会改变';
  });
}
async function load(v: Version) {
  if (!selected.value) return;
  await action(async () => {
    const full = await api<Version>('/configs/' + selected.value!.id + '/versions/' + v.id);
    emit('load', JSON.stringify(full.body, null, 2));
    notice.value = '历史版本已载入草稿，编辑后需另存新版本';
  });
}
onMounted(() => void action(() => refresh()));
</script>
<template>
  <div class="version-manager">
    <h2>配置版本管理</h2>
    <p class="muted">保存后版本不可修改。下载任务使用指定版本；安装注册模式暂不可执行。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
    />
    <label for="config-name">配置名称</label
    ><el-input id="config-name" v-model="name" maxlength="100" />
    <div class="form-actions">
      <el-button :disabled="busy || !name" @click="create">新建配置</el-button
      ><el-button type="primary" :disabled="busy || !selected" @click="save"
        >保存草稿为新版本</el-button
      >
    </div>
    <el-table :data="configs" empty-text="尚无保存的配置"
      ><el-table-column prop="name" label="名称" /><el-table-column label="操作"
        ><template #default="s"
          ><el-button text @click="select(s.row)">选择配置</el-button></template
        ></el-table-column
      ></el-table
    ><el-button v-if="cursor" text @click="action(() => refresh(true))">加载更多配置</el-button>
    <template v-if="selected"
      ><h3>当前配置：{{ selected.name }}</h3>
      <el-table :data="versions" empty-text="尚未保存版本"
        ><el-table-column prop="version" label="版本" /><el-table-column label="摘要"
          ><template #default="s"
            ><span class="fingerprint">{{ s.row.configHash.slice(0, 16) }}</span></template
          ></el-table-column
        ><el-table-column label="操作"
          ><template #default="s"
            ><el-button text @click="load(s.row)">载入版本</el-button></template
          ></el-table-column
        ></el-table
      ></template
    >
  </div>
</template>
