import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 「撤回上一步」是瞭望台专用的运维动作，不属于正向流转，也不算异常数据。
const UNDO_ACTION = '撤回上一步'

// 维修完成后在气象观测模块生成的「站点现场核查」待办约定：
//  - 待办编号 CHK-{瞭望台id}-R{维修轮次}，同一瞭望台每完成一轮维修生成一条，轮次递增互不撞号；
//  - 同一轮次重复提交维修完成只保留一条（幂等）；
//  - 撤回「维修完成」时轮次回退，并按编号把这一轮的待办清掉，不留残留。
const CHECK_RECORD_PREFIX = 'CHK-'

export function checkRecordCode(lookoutId: number, round: number): string {
  return `${CHECK_RECORD_PREFIX}${String(lookoutId).padStart(4, '0')}-R${round}`
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

function ensureLocalStaff(meta: ModuleMeta, action: string): ActionResult | null {
  const session = useSessionStore()
  if (session.readonly) {
    return { ok: false, message: `当前为外单位（非本林场）身份，只能查看，不能执行「${action}」；${meta.entity}的操作请联系本林场值班人员。` }
  }
  return null
}

export function runAction(key: string, id: number, action: string, payload: Record<string, string> = {}): ActionResult {
  const meta = moduleMeta(key)
  const denied = ensureLocalStaff(meta, action)
  if (denied) {
    return denied
  }
  const target = meta.actionTargets[action]
  if (action !== UNDO_ACTION && !target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  if (action === UNDO_ACTION) {
    return undoLastStep(meta, rows, index)
  }

  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态机白名单：配置了 transitions 的模块只允许沿既定轨迹单向流转。
  if (meta.transitions) {
    const allowed = meta.transitions[current] ?? []
    if (!allowed.includes(target)) {
      return {
        ok: false,
        message: `瞭望台当前为「${current}」，不能直接${action}到「${target}」。请按正常值守→临时关闭→设备故障→维修中→正常值守的轨迹办理。`,
      }
    }
  }

  // 瞭望台只有正常值守是稳态，其余三种状态都算待处理。
  const pending = key === 'lookout' ? target !== '正常值守' : target !== meta.statuses[meta.statuses.length - 1]
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  let extra: { ok: boolean; message: string } | null = null
  if (key === 'lookout') {
    const step = applyLookoutStep(updated, action, payload)
    // 业务校验不通过（如送修没填维修人员）时直接返回，不允许任何字段落库。
    if (step.result && !step.result.ok) {
      return step.result
    }
    updated = step.row
    extra = step.result
    // 维护单向轨迹：旧记录没有轨迹时从当前状态起步，之后每步追加；撤回时回退一格。
    // 用逗号字符串存，兼容 EntryRow 的标量字段约定。
    const seedTrail = rows[index]['状态轨迹']
      ? String(rows[index]['状态轨迹']).split(',').filter(Boolean)
      : [current]
    updated['状态轨迹'] = [...seedTrail, target].join(',')
  }
  if (key === 'weather' && String(rows[index]['记录编号'] ?? '').startsWith(CHECK_RECORD_PREFIX)) {
    return { ok: false, message: '这是瞭望台维修后的站点现场核查待办，请通过「提交核查结论」给出唯一结论，不能走普通审核动作。' }
  }

  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return extra ?? { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 记录本次维修的维修人员；历史故障记录没有这个字段时保持留空（见 data/modules 字段说明），
// 不回填成原瞭望员，避免把无关人员记成维修责任人。
function applyLookoutStep(
  row: EntryRow,
  action: string,
  payload: Record<string, string>,
): { row: EntryRow; result: { ok: boolean; message: string } | null } {
  if (action === '送修') {
    const repairer = (payload.repairer ?? '').trim()
    if (!repairer) {
      return { row, result: { ok: false, message: '送修必须登记维修人员，请填写后再提交。' } }
    }
    return { row: { ...row, 维修人员: repairer }, result: null }
  }
  if (action === '维修完成') {
    const lookoutId = Number(row.id)
    const siteName = String(row['所在山头'] || row['瞭望台编号'] || `瞭望台${lookoutId}`)
    // 每完成一轮维修轮次加一：上一轮核查已出结论的记录保留在气象侧，新一轮待办另起编号，不互相覆盖。
    const round = (Number(row['维修轮次']) || 0) + 1
    const code = checkRecordCode(lookoutId, round)
    const weatherRows = listRows('weather')
    const existing = weatherRows.find(
      (item) => String(item['记录编号']) === code,
    )
    if (existing && String(existing.status) === '已录入' && !existing['核查结论']) {
      // 同一轮重复/并发提交维修完成：现场核查待办已经挂着，只接受一次，不再多挂一条。
      return {
        row,
        result: {
          ok: true,
          message: `瞭望台已维修完成、恢复正常值守；气象观测站点「${siteName}」的现场核查待办此前已生成，无需重复提交。`,
        },
      }
    }
    const now = new Date().toISOString().slice(0, 16)
    const todo: EntryRow = {
      id: nextWeatherId(weatherRows),
      status: '已录入',
      pending: true,
      abnormal: false,
      记录编号: code,
      观测站点: siteName,
      观测时间: now,
      气温: '',
      相对湿度: '',
      风速风向: '',
      降水量: '',
      记录状态: '待现场核查',
      来源: `瞭望台${row['瞭望台编号'] ?? lookoutId}第${round}轮维修完成`,
      核查事项: `瞭望台维修后现场核查（第${round}轮）`,
    }
    saveRows('weather', [...weatherRows, todo])
    return {
      row: { ...row, 维修轮次: round },
      result: {
        ok: true,
        message: `瞭望台已维修完成、恢复正常值守；气象观测站点「${siteName}」新增 1 项现场核查待办。`,
      },
    }
  }
  return { row, result: null }
}

function nextWeatherId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 撤回上一步：把瞭望台退回到轨迹上的前一个状态，并同步清理这一步在气象侧产生的待办。
// 撤回沿轨迹逐格回退，可以连续撤回多步，但每一步在气象侧产生的数据都必须一起回滚干净。
function undoLastStep(meta: ModuleMeta, rows: EntryRow[], index: number): ActionResult {
  const row = rows[index]
  const trail = row['状态轨迹']
    ? String(row['状态轨迹']).split(',').filter(Boolean)
    : []
  if (trail.length < 2) {
    return { ok: false, message: '这条瞭望台记录还没有可撤回的中间操作。' }
  }
  const current = trail[trail.length - 1]
  const prev = trail[trail.length - 2]
  const lookoutId = Number(row.id)
  const round = Number(row['维修轮次']) || 0
  const code = checkRecordCode(lookoutId, round)
  const weatherRows = listRows('weather')
  const linked = weatherRows.find((item) => String(item['记录编号']) === code)
  let cleanedTodo = false

  // 当前这一步是「维修完成」时，气象侧挂着的是本轮的核查待办；
  // 若现场核查已经给出结论，则说明这一步已被下游采信，不允许撤回，避免结论悬空。
  if (current === '正常值守' && prev === '维修中') {
    if (linked && (String(linked.status) !== '已录入' || linked['核查结论'])) {
      return {
        ok: false,
        message: '站点现场核查已提交结论，维修完成这一步已被气象侧采信，不能撤回；如需处理请重新登记故障。',
      }
    }
    if (linked) {
      // 撤回中间操作：本轮待办一并删除，不允许残留；历史轮次已出结论的记录保留。
      saveRows('weather', weatherRows.filter((item) => String(item['记录编号']) !== code))
      cleanedTodo = true
    }
  }

  const restoredTrail = trail.slice(0, -1)
  const restored: EntryRow = {
    ...rows[index],
    status: prev,
    pending: prev !== '正常值守',
    状态轨迹: restoredTrail.join(','),
  }
  if (current === '正常值守' && prev === '维修中' && round > 0) {
    // 撤回维修完成，轮次回退：重新维修完成时还能生成同编号待办，不会出现空轮或跳号。
    restored['维修轮次'] = round - 1
  }
  if (prev !== '维修中') {
    // 退回到关闭/故障阶段，本次登记的维修人员不再代表当前状态。
    delete restored['维修人员']
    restored.abnormal = false
  }
  const next = [...rows]
  next[index] = restored
  saveRows(meta.key, next)
  const cleaned = cleanedTodo ? '，关联的现场核查待办已一并撤回' : ''
  return { ok: true, message: `已撤回上一步，瞭望台退回到「${prev}」${cleaned}。` }
}

// 气象侧现场核查结论入口：瞭望台页和气象页两个入口都走这一个函数，
// 同一条待办只接受第一个结论，重复提交（含两边同时提交）直接拒绝。
export function submitSiteCheck(weatherId: number, conclusion: 'pass' | 'fail', remark: string): ActionResult {
  const meta = moduleMeta('weather')
  const denied = ensureLocalStaff(meta, '提交现场核查结论')
  if (denied) {
    return denied
  }
  const rows = listRows('weather')
  const index = rows.findIndex((row) => Number(row.id) === weatherId)
  if (index < 0) {
    return { ok: false, message: '没有找到对应的气象观测记录。' }
  }
  const target = rows[index]
  if (!String(target['记录编号'] ?? '').startsWith(CHECK_RECORD_PREFIX)) {
    return { ok: false, message: '该记录不是瞭望台维修后的站点现场核查待办。' }
  }
  if (target['核查结论']) {
    return {
      ok: false,
      message: `该站点现场核查已有结论「${target['核查结论']}」，两个入口只接受一个结论，不能重复提交。`,
    }
  }
  const session = useSessionStore()
  const passed = conclusion === 'pass'
  const updated: EntryRow = {
    ...target,
    status: passed ? '已审核' : '异常值',
    pending: false,
    abnormal: !passed,
    记录状态: passed ? '核查通过' : '核查不通过',
    核查结论: passed ? '核查通过' : '核查不通过',
    核查人: session.operator,
    核查时间: new Date().toISOString().slice(0, 16),
    核查备注: remark,
  }
  const next = [...rows]
  next[index] = updated
  saveRows('weather', next)
  return {
    ok: true,
    message: `站点「${target['观测站点']}」现场核查结论已记录：${updated['核查结论']}。`,
  }
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
