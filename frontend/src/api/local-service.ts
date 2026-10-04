import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import { useSessionStore } from '@/stores/session'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 气象观测站点现场核查待办在本地数据层里的集合名，瞭望台维修完成时往这里加一项。
export const WEATHER_CHECK_KEY = 'weathercheck'

// 核查结论只有这两种；一张核查单无论从哪个入口提交，都只接受一个结论。
export const CHECK_CONCLUSIONS = ['核查通过', '核查不通过']

// 瞭望台运行状态的单向轨迹：只能沿链向前（允许向前跳格），禁止回退；
// 唯一回环是「维修完成」让维修中回到正常值守，以及它的撤回。
const LOOKOUT_FLOW = ['正常值守', '临时关闭', '设备故障', '维修中']

function sessionContext(): { operator: string; forestFarm: string } {
  try {
    const session = useSessionStore()
    return { operator: session.operator, forestFarm: session.forestFarm }
  } catch {
    // 没有激活的 pinia（比如脚本直调）时退化成无归属上下文，不做林场拦截。
    return { operator: '系统', forestFarm: '' }
  }
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === 'lookout') {
    return runLookoutAction(id, action, target)
  }
  return transact<ActionResult>((data) => {
    const rows = data[key] ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { data, result: { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` } }
    }
    const current = String(rows[index].status)
    if (current === target) {
      return { data, result: { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` } }
    }
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    const updated: EntryRow = {
      ...rows[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    const next = [...rows]
    next[index] = updated
    return {
      data: { ...data, [key]: next },
      result: { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` },
    }
  })
}

// 瞭望台单向轨迹校验：返回 null 表示放行，否则是拒绝原因。
function guardLookoutFlow(action: string, current: string, target: string): string | null {
  if (action === '维修完成') {
    if (current === '临时关闭') {
      return '瞭望台关闭后不可直接恢复值守，须先登记故障并走完维修流程'
    }
    return current === '维修中' ? null : `只有「维修中」的瞭望台才能登记维修完成，当前是「${current}」`
  }
  if (action === '撤回维修完成') {
    // 能不能撤还取决于气象核查是否已出结论，那一半在事务里判。
    return current === '正常值守'
      ? null
      : `只有「正常值守」且气象核查未办结的瞭望台才能撤回维修完成，当前是「${current}」`
  }
  if (action === '安排维修') {
    return current === '设备故障' ? null : `只有「设备故障」的瞭望台才能安排维修，当前是「${current}」`
  }
  const from = LOOKOUT_FLOW.indexOf(current)
  const to = LOOKOUT_FLOW.indexOf(target)
  if (from < 0 || to < 0 || to <= from) {
    return `瞭望台运行状态按「${LOOKOUT_FLOW.join('→')}」单向流转，不能由「${current}」回到「${target}」`
  }
  return null
}

// 维修完成时给气象观测站点的现场核查待办加一项。
// 历史故障记录缺「维修人员」的一律留空（页面显示「—」），不回填原瞭望员，避免篡改历史。
function buildWeatherCheck(tower: EntryRow, existing: EntryRow[]): EntryRow {
  const nextId = existing.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  return {
    id: nextId,
    status: '待核查',
    pending: true,
    abnormal: false,
    核查单号: `CHK-${String(nextId).padStart(4, '0')}`,
    lookoutId: Number(tower.id),
    来源瞭望台: String(tower['瞭望台编号'] ?? ''),
    所在山头: String(tower['所在山头'] ?? ''),
    所属林场: String(tower['所属林场'] ?? ''),
    维修人员: String(tower['维修人员'] ?? ''),
    生成时间: nowText(),
    结论提交人: '',
    结论时间: '',
  }
}

function latestPendingCheck(checks: EntryRow[], lookoutId: number): EntryRow | undefined {
  return checks
    .filter((item) => Number(item.lookoutId) === lookoutId && item.status === '待核查')
    .sort((a, b) => Number(b.id) - Number(a.id))[0]
}

// 瞭望台专用流转：单向轨迹 + 非本林场只能查看 + 维修完成联动气象核查待办，全在一个事务里落库。
function runLookoutAction(id: number, action: string, target: string): ActionResult {
  return transact<ActionResult>((data) => {
    const rows = data.lookout ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { data, result: { ok: false, message: `没有找到编号为 ${id} 的瞭望台` } }
    }
    const row = rows[index]
    const { operator, forestFarm } = sessionContext()
    const rowFarm = String(row['所属林场'] ?? '')
    if (forestFarm && rowFarm && rowFarm !== forestFarm) {
      return { data, result: { ok: false, message: `非本林场人员只能查看，不能对瞭望台执行「${action}」` } }
    }
    const current = String(row.status)
    if (current === target) {
      return { data, result: { ok: false, message: `瞭望台已经是「${target}」，不用重复操作` } }
    }
    const rejected = guardLookoutFlow(action, current, target)
    if (rejected) {
      return { data, result: { ok: false, message: rejected } }
    }
    let checks = data[WEATHER_CHECK_KEY] ?? []
    let extra = ''
    if (action === '撤回维修完成') {
      const mine = checks.filter((item) => Number(item.lookoutId) === id)
      const pendingTodo = latestPendingCheck(checks, id)
      if (mine.length === 0) {
        return { data, result: { ok: false, message: '该瞭望台没有维修完成记录，无可撤回' } }
      }
      if (!pendingTodo) {
        return { data, result: { ok: false, message: '气象核查已出结论，维修完成不能撤回，核查结论只接受一个' } }
      }
      // 撤回中间操作不得残留：未办结的核查待办随撤回一并删除。
      checks = checks.filter((item) => Number(item.id) !== Number(pendingTodo.id))
      extra = `，已同步撤回气象核查待办 ${pendingTodo['核查单号']}，不留残留`
    }
    const updated: EntryRow = { ...row, status: target }
    // 安排维修时登记维修人员；历史故障记录原本缺这个字段的保持留空，等流转到这里再补。
    if (action === '安排维修') {
      updated['维修人员'] = operator
    }
    updated.pending = target !== '正常值守'
    updated.abnormal = target === '设备故障' || target === '维修中'
    if (action === '维修完成') {
      const todo = buildWeatherCheck(updated, checks)
      checks = [...checks, todo]
      extra = `，气象观测站点现场核查待办已新增 ${todo['核查单号']}`
    }
    const nextRows = [...rows]
    nextRows[index] = updated
    return {
      data: { ...data, lookout: nextRows, [WEATHER_CHECK_KEY]: checks },
      result: { ok: true, message: `瞭望台已${action}，当前状态「${target}」${extra}` },
    }
  })
}

// 现场核查待办：待核查的排前面，其余按单号倒序。
export function listWeatherChecks(): EntryRow[] {
  return [...listRows(WEATHER_CHECK_KEY)].sort((a, b) => {
    const pendingA = a.status === '待核查' ? 0 : 1
    const pendingB = b.status === '待核查' ? 0 : 1
    return pendingA - pendingB || Number(b.id) - Number(a.id)
  })
}

// 核查结论的唯一写入口：瞭望台页和气象页两个入口都走这里。
// 事务内重读状态，已办结的一律拒绝，两个入口同时提交也只接受一个结论。
export function submitWeatherCheckConclusion(id: number, conclusion: string): ActionResult {
  if (!CHECK_CONCLUSIONS.includes(conclusion)) {
    return { ok: false, message: '核查结论只能是「核查通过」或「核查不通过」' }
  }
  return transact<ActionResult>((data) => {
    const rows = data[WEATHER_CHECK_KEY] ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { data, result: { ok: false, message: `没有找到编号为 ${id} 的现场核查待办` } }
    }
    const row = rows[index]
    const { operator, forestFarm } = sessionContext()
    const rowFarm = String(row['所属林场'] ?? '')
    if (forestFarm && rowFarm && rowFarm !== forestFarm) {
      return { data, result: { ok: false, message: '非本林场人员只能查看，不能提交核查结论' } }
    }
    if (String(row.status) !== '待核查') {
      return {
        data,
        result: { ok: false, message: `该核查单已是「${row.status}」，两个入口同时提交也只接受一个结论` },
      }
    }
    const updated: EntryRow = {
      ...row,
      status: conclusion,
      pending: false,
      结论提交人: operator,
      结论时间: nowText(),
    }
    const next = [...rows]
    next[index] = updated
    return {
      data: { ...data, [WEATHER_CHECK_KEY]: next },
      result: { ok: true, message: `现场核查已办结，结论「${conclusion}」` },
    }
  })
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
