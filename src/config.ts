import type { Settings } from './types'

// Factory defaults: the live values live in the DO (editable from /manage);
// these only seed a fresh installation.
export const settings: Settings = {
  title: '服务状态',
  timeZone: 'Asia/Shanghai',
  webhook: 'https://timelynotify.oicode.cn/Nt5RQRHQ5Vg5fNHdJF54Z9',
}
export const pushParams = { icon: 'https://static.wallleap.cn/temp/nwvgnm7l2on5u6c531mo.jpg', group: '服务状态', ttl: '600', sound: 'multiwayinvitation' }
