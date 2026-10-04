import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    // 当前值班人所属林场：非本林场的瞭望台与气象核查待办只能查看，不能操作。
    forestFarm: '青松林场',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    // 旧记录没登记所属林场时按本林场放行，保证历史数据还能继续流转。
    canManageFarm: (state) => (farm: unknown) => !farm || farm === state.forestFarm,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
