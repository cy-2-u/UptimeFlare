import type { Settings } from './types'

export const settings: Settings = {
  title: '服务状态',
  links: [],
  maintenances: [],
  notification: {
    timeZone: 'Asia/Shanghai',
    gracePeriod: 0,
    skipNotificationIds: [],
    skipErrorChangeNotification: false,
  },
}

export const push = {
  url: 'https://timelynotify.oicode.cn/Nt5RQRHQ5Vg5fNHdJF54Z9',
  icon: 'https://static.wallleap.cn/temp/nwvgnm7l2on5u6c531mo.jpg',
  group: '服务状态',
  ttl: '600',
  sound: 'multiwayinvitation',
}
