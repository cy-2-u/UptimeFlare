import type { MaintenanceConfig, PageConfig, WorkerConfig } from './types'

const pageConfig: PageConfig = {
  title: '服务状态',
  links: [],
  favicon: '/favicon.svg',
}

const workerConfig: WorkerConfig = {
  notification: {
    timeZone: 'Asia/Shanghai',
  },
}

const maintenances: MaintenanceConfig[] = []

export { maintenances, pageConfig, workerConfig }
