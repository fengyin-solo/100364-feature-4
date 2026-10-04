/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 状态机：键为当前状态，值为该状态允许直接流转到的目标状态白名单。
  // 缺省时沿用旧行为（任意动作都能改状态）；瞭望台必须严格走单向轨迹。
  transitions?: Record<string, string[]>
  // 是否提供「撤回上一步」：撤回是运维操作，不属于正向流转，也不算异常。
  undoable?: boolean
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
