<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue';
import type { MaintenanceItem, MaintenanceInput, MaintenanceList } from '@apk/contracts';
import { api, mutation } from './api';
const props = defineProps<{ configId?: string }>(),
  emit = defineEmits<{ chooseVersion: [id: string] }>();
const kind = ref<MaintenanceInput['items'][number]['kind']>(
    props.configId ? 'CONFIG_VERSION' : 'RELEASE',
  ),
  archived = ref('ACTIVE'),
  items = ref<MaintenanceItem[]>([]),
  next = ref<string | null>(null),
  selected = ref<string[]>([]),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  pending = ref<{ action: MaintenanceInput['action']; rows: MaintenanceItem[] } | null>(null);
const blockedSelected = computed(
  () => items.value.filter((r) => selected.value.includes(r.id) && !r.canArchive).length,
);
async function load(append = false) {
  busy.value = true;
  error.value = '';
  try {
    const q = new URLSearchParams({
      kind: kind.value,
      archived: archived.value,
      limit: '30',
      ...(props.configId && kind.value === 'CONFIG_VERSION' ? { configId: props.configId } : {}),
      ...(append && next.value ? { cursor: next.value } : {}),
    });
    const p = await api<MaintenanceList>('/maintenance/items?' + q);
    items.value = append ? [...items.value, ...p.items] : p.items;
    next.value = p.nextCursor;
    selected.value = [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '历史加载失败';
  } finally {
    busy.value = false;
  }
}
function ask(action: MaintenanceInput['action'], rows: MaintenanceItem[]) {
  if (!rows.length) return;
  pending.value = { action, rows };
}
async function confirm() {
  if (!pending.value) return;
  busy.value = true;
  error.value = '';
  try {
    const { action, rows } = pending.value;
    const result = await mutation<{ affected: number }>('/maintenance/actions', {
      action,
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind as MaintenanceInput['items'][number]['kind'],
        revision: r.revision,
      })),
    });
    notice.value = `已${action === 'DELETE' ? '删除' : action === 'ARCHIVE' ? '归档' : '恢复'} ${result.affected} 项记录`;
    pending.value = null;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.configId,
  () => {
    kind.value = props.configId ? 'CONFIG_VERSION' : 'RELEASE';
    void load();
  },
);
onMounted(() => void load());
</script>
<template>
  <section class="surface history-manager">
    <h2>{{ configId ? '本任务配置历史' : '历史与版本管理' }}</h2>
    <p class="muted">
      归档后从常用列表隐藏，历史记录保留，可恢复。永久删除只适用于没有引用的登记记录。
    </p>
    <div class="filter-grid">
      <label v-if="!configId"
        >管理对象<select v-model="kind" aria-label="管理对象" :disabled="busy" @change="load()">
          <option value="RELEASE">程序发布版本</option>
          <option value="CONFIGURATION">任务方案</option>
          <option value="CONFIG_VERSION">配置历史版本</option>
        </select></label
      ><label
        >显示范围<select
          v-model="archived"
          aria-label="历史显示范围"
          :disabled="busy"
          @change="load()"
        >
          <option value="ACTIVE">未归档</option>
          <option value="ARCHIVED">已归档</option>
          <option value="ALL">全部</option>
        </select></label
      >
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="pending" class="confirmation-box" role="alert">
      <strong>{{
        pending.action === 'DELETE'
          ? '确认永久删除登记记录？'
          : pending.action === 'ARCHIVE'
            ? '确认归档所选记录？'
            : '确认恢复所选记录？'
      }}</strong>
      <p>{{ pending.rows.map((r) => r.title).join('；') }}</p>
      <p v-if="pending.action === 'DELETE'">
        不能撤销。不删除服务器上的程序、账户或证据；发布安装包文件保留，后续单独清理。
      </p>
      <el-button :disabled="busy" @click="confirm"
        >确认{{
          pending.action === 'DELETE' ? '删除' : pending.action === 'ARCHIVE' ? '归档' : '恢复'
        }}</el-button
      ><el-button :disabled="busy" @click="pending = null">取消</el-button>
    </div>
    <div class="form-actions">
      <el-button
        :disabled="busy || !selected.length || blockedSelected > 0"
        @click="
          ask(
            'ARCHIVE',
            items.filter((r) => selected.includes(r.id)),
          )
        "
        >批量归档所选</el-button
      ><el-button
        :disabled="busy || !selected.length"
        @click="
          ask(
            'RESTORE',
            items.filter((r) => selected.includes(r.id)),
          )
        "
        >批量恢复所选</el-button
      ><el-button :disabled="busy" @click="load()">刷新历史</el-button>
    </div>
    <p v-if="blockedSelected" class="muted">
      所选 {{ blockedSelected }} 项正在使用，需先解除当前绑定后才能归档。
    </p>
    <div class="table-scroll">
      <table class="console-table">
        <thead>
          <tr>
            <th>选择</th>
            <th>名称</th>
            <th>引用情况</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id">
            <td>
              <input
                v-model="selected"
                type="checkbox"
                :value="r.id"
                :aria-label="'选择 ' + r.title"
                :disabled="busy"
              />
            </td>
            <td>{{ r.title }}<small v-if="r.archivedAt"> · 已归档</small></td>
            <td>
              {{
                r.references.length
                  ? r.references.map((x) => x.label + ' ' + x.count).join('，')
                  : '没有引用，可永久删除'
              }}<small v-if="!r.canArchive && !r.archivedAt"> · 正在使用</small>
            </td>
            <td>
              <div class="form-actions">
                <el-button
                  v-if="configId"
                  text
                  :disabled="busy"
                  @click="emit('chooseVersion', r.id)"
                  >用此版本编辑</el-button
                ><el-button
                  v-if="!r.archivedAt"
                  text
                  :disabled="busy || !r.canArchive"
                  @click="ask('ARCHIVE', [r])"
                  >归档</el-button
                ><el-button v-else text :disabled="busy" @click="ask('RESTORE', [r])"
                  >恢复</el-button
                ><el-button text :disabled="busy || !r.canDelete" @click="ask('DELETE', [r])"
                  >删除</el-button
                >
              </div>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="4">没有符合条件的记录</td>
          </tr>
        </tbody>
      </table>
    </div>
    <el-button v-if="next" :disabled="busy" @click="load(true)">加载更多历史</el-button>
  </section>
</template>
