import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { staffOnly } from './directives/staff'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.directive('staff', staffOnly)
app.mount('#app')
