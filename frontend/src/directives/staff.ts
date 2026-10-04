import type { Directive } from 'vue'

import { useSessionStore } from '@/stores/session'

// v-staff：只允许本林场人员操作。非本林场身份下元素禁用并拦截点击，
// 是界面层的只读控制；真正的写操作在 api/local-service 里还有一道服务层校验。
export const staffOnly: Directive<HTMLElement> = {
  mounted(el) {
    apply(el)
    el.addEventListener('click', guard, true)
  },
  updated(el) {
    apply(el)
  },
  unmounted(el) {
    el.removeEventListener('click', guard, true)
  },
}

function guard(event: Event) {
  const session = useSessionStore()
  if (session.readonly) {
    event.preventDefault()
    event.stopPropagation()
    window.alert('非本林场人员只能查看，不能执行该操作。')
  }
}

function apply(el: HTMLElement) {
  const session = useSessionStore()
  if (session.readonly) {
    el.setAttribute('disabled', 'disabled')
    el.classList.add('is-readonly')
  } else {
    el.removeAttribute('disabled')
    el.classList.remove('is-readonly')
  }
}
