import { defineStore } from 'pinia'

// 身份只有两类：本林场人员可以走业务动作；外单位（非本林场）人员全程只读。
export type OperatorRole = '本林场' | '外单位'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    forestFarm: '青山林场',
    role: '本林场' as OperatorRole,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    // 非本林场人员只能查看，任何写操作都在服务层再拦一道，不只靠界面隐藏。
    readonly: (state) => state.role !== '本林场',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: OperatorRole) {
      this.role = role
      this.operator = role === '本林场' ? '值班管理员' : '外单位观摩员'
    },
  },
})
