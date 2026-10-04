<template>
  <section class="page" data-module="weather">
    <header class="page-head">
      <div>
        <h2>气象观测管理</h2>
        <p class="page-desc">维护气象观测记录，围绕记录编号、观测站点、观测时间、气温做登记、筛选与状态流转。瞭望台维修完成后，这里会新增对应站点的现场核查待办。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="readonly" @click="openCreate">登记气象观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出气象观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>
    <p v-if="readonly" class="readonly-tip">当前为非本林场人员身份，仅可查看，不能执行审核、异常标记或核查结论提交。</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>现场核查</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'check-row': isCheckTodo(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <template v-if="isCheckRecord(row)">
              <span v-if="row['核查结论']">{{ row['核查结论'] }}（{{ row['核查人'] || '—' }}）</span>
              <span v-else class="todo-tag">待现场核查</span>
            </template>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <template v-for="action in actionsFor(row)" :key="action">
              <button class="link" type="button" :disabled="readonly" @click="runAction(action, row)">
                {{ action }}
              </button>
            </template>
            <span v-if="!actionsFor(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无气象观测数据，可先登记气象观测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条气象观测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitSiteCheck,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('weather')
const columns = ["记录编号", "观测站点", "观测时间", "气温", "相对湿度", "风速风向", "降水量", "记录状态"]
const regularActions = ["提交审核", "确认数据", "标记异常"]
const statuses = ["已录入", "已审核", "已修正", "异常值"]
const stats = [{ label: "今日观测数", value: 0 }, { label: "待审核记录", value: 0 }, { label: "异常记录数", value: 0 }]

const store = useSessionStore()
const readonly = computed(() => store.readonly)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 由瞭望台维修完成联动生成的记录：编号 CHK- 开头。
function isCheckRecord(row: EntryRow): boolean {
  return String(row['记录编号'] ?? '').startsWith('CHK-')
}

function isCheckTodo(row: EntryRow): boolean {
  return isCheckRecord(row) && !row['核查结论']
}

// 核查待办只暴露核查结论动作（通过/不通过共用一个结论入口），
// 不允许再走普通审核动作；与瞭望台页的入口共用 submitSiteCheck，只接受一个结论。
function actionsFor(row: EntryRow): string[] {
  if (readonly.value) {
    return []
  }
  if (isCheckRecord(row)) {
    return row['核查结论'] ? [] : ['提交核查结论']
  }
  return regularActions
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '气象观测记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '提交核查结论') {
    const input = window.prompt('请输入现场核查结论：输入「通过」或「不通过」（可在冒号后附备注，如：不通过:通讯设备仍异常）', '通过')
    if (input === null) {
      return
    }
    const text = input.trim()
    const matched = text.match(/^(通过|不通过)\s*[:：]?\s*(.*)$/)
    if (!matched) {
      errorMessage.value = '结论无法识别，请以「通过」或「不通过」开头。'
      return
    }
    const result = submitSiteCheck(Number(row.id), matched[1] === '通过' ? 'pass' : 'fail', matched[2] ?? '')
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats[0].value = payload.total
    stats[1].value = payload.items.filter((row) => row.pending).length
    stats[2].value = payload.items.filter((row) => String(row.status) === '异常值' || row.abnormal).length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '气象观测列表读取失败'
  }
}

onMounted(reload)
</script>
