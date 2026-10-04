<template>
  <section class="page" data-module="lookout">
    <header class="page-head">
      <div>
        <h2>瞭望台管理管理</h2>
        <p class="page-desc">维护瞭望台，围绕瞭望台编号、所在山头、海拔高度、视野覆盖面积做登记、筛选与状态流转。运行状态沿 正常值守→临时关闭→设备故障→维修中 单向流转，关闭后不可直接恢复值守。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="readonly" @click="openCreate">登记瞭望台</button>
        <button class="btn" type="button" @click="exportRows">导出瞭望台管理清单</button>
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
    <p v-if="readonly" class="readonly-tip">当前为非本林场人员身份，仅可查看，不能执行任何状态操作。</p>

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
          <th>维修后核查</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ siteCheckState(row) }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="readonly"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无瞭望台管理数据，可先登记瞭望台</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条瞭望台管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  checkRecordCode,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('lookout')
const columns = ["瞭望台编号", "所在山头", "海拔高度", "视野覆盖面积", "瞭望员", "通讯方式", "设备配置", "维修人员", "运行状态"]
const statuses = ["正常值守", "临时关闭", "设备故障", "维修中"]
const stats = [{ label: "瞭望台总数", value: 0 }, { label: "正常值守数", value: 0 }, { label: "故障台数", value: 0 }]

// 每个状态只放行状态机白名单里的下一步动作，撤回是运维动作，单独按是否有上一状态显示。
const NEXT_ACTION: Record<string, string> = {
  正常值守: '关闭瞭望台',
  临时关闭: '登记故障',
  设备故障: '送修',
  维修中: '维修完成',
}

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

// 旧记录（历史故障/维修数据）可能没有「维修人员」，这里保持原样展示「—」，不回填成原瞭望员。
function availableActions(row: EntryRow): string[] {
  if (readonly.value) {
    return []
  }
  const actions: string[] = []
  const next = NEXT_ACTION[String(row.status)]
  if (next) {
    actions.push(next)
  }
  // 状态轨迹超过一格，说明至少做过一次中间操作，允许逐格撤回。
  const trail = row['状态轨迹'] ? String(row['状态轨迹']).split(',').filter(Boolean) : []
  if (trail.length >= 2) {
    actions.push('撤回上一步')
  }
  return actions
}

// 沿「值守→气象」的调用链展示联动结果：维修完成会在气象观测挂一条 CHK 编号的现场核查待办。
function siteCheckState(row: EntryRow): string {
  if (String(row.status) !== '正常值守') {
    return '—'
  }
  const round = Number(row['维修轮次']) || 0
  if (!round) {
    return '—'
  }
  const code = checkRecordCode(Number(row.id), round)
  const linked = listRows('weather').find((item) => String(item['记录编号']) === code)
  if (!linked) {
    return '—'
  }
  if (linked['核查结论']) {
    return String(linked['核查结论'])
  }
  return '待现场核查'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '瞭望台登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  let payload: Record<string, string> = {}
  if (action === '送修') {
    // 历史记录缺维修人员允许留空；新送修的必须现场登记责任人。
    const repairer = window.prompt('请输入维修人员姓名（必填）', String(row['维修人员'] ?? ''))
    if (repairer === null) {
      return
    }
    if (!repairer.trim()) {
      errorMessage.value = '送修必须登记维修人员。'
      return
    }
    payload = { repairer: repairer.trim() }
  }
  if (action === '撤回上一步' && !window.confirm('撤回后该瞭望台退回到上一状态；若是撤回「维修完成」，关联的气象现场核查待办会一并删除。确认撤回？')) {
    return
  }
  const result = applyAction(meta.key, Number(row.id), action, payload)
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
    stats[1].value = payload.items.filter((row) => String(row.status) === '正常值守').length
    stats[2].value = payload.items.filter((row) => ['设备故障', '维修中'].includes(String(row.status))).length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '瞭望台管理列表读取失败'
  }
}

onMounted(reload)
</script>
