// 启动基准先隔离所有持久化目录，再复用仓库的离屏窗口壳。
const { app, ipcMain } = require('electron')
const { mkdirSync } = require('node:fs')
const { resolve } = require('node:path')

const home = resolve(process.env.EVERMD_STARTUP_HOME)
const userData = resolve(process.env.EVERMD_STARTUP_UDD)
mkdirSync(home, { recursive: true })
mkdirSync(userData, { recursive: true })
app.setPath('home', home)
app.setPath('userData', userData)

// 延迟两个配置响应，证明主题请求没有串行等待它们；普通基准不加入延迟。
const concurrent = process.env.EVERMD_STARTUP_CONCURRENT === '1'
let releaseConfiguration
const configurationGate = new Promise(resolveGate => { releaseConfiguration = resolveGate })
const requests = []
let saveRequests = 0
const report = (event, details = {}) => console.log(`EVERMD_STARTUP_PROBE ${JSON.stringify({ event, ...details })}`)
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  if (channel === 'save-file' || channel === 'save-file-as') {
    // 输入验收只做编辑和撤销，任何意外保存都由父脚本判失败。
    saveRequests++
    return null
  }
  if (['get-language', 'get-file-manager-name', 'list-theme-definitions'].includes(channel)) {
    requests.push(channel)
    if (concurrent) report('configuration-request', { channel })
    if (concurrent && channel === 'list-theme-definitions') releaseConfiguration()
    if (concurrent && channel !== 'list-theme-definitions') await configurationGate
  }
  return listener(...args)
})
process.stdin.on('data', () => report('state', {
  home: app.getPath('home'), userData: app.getPath('userData'), requests, saveRequests,
  isPackaged: app.isPackaged, electron: process.versions.electron
}))
const mainLoadStartedAt = performance.now()
require('./offscreen-window.cjs')
report('isolated', { home: app.getPath('home'), userData: app.getPath('userData'),
  // 原生包此处返回正在执行的主模块缓存，不能把它当成真实模块加载耗时。
  mainLoadMs: app.isPackaged ? null : performance.now() - mainLoadStartedAt })
