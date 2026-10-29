// 只在启动验收中阻塞目录请求；正文交付必须独立于这条请求。
const { ipcMain, app } = require('electron')
const { join } = require('node:path')

let releaseDirectory
const directoryGate = new Promise(resolve => { releaseDirectory = resolve })
globalThis.startupProbe = { directoryRequested: false, directoryReleased: false, deliveries: [] }
globalThis.startupProbe.release = () => {
  globalThis.startupProbe.directoryReleased = true
  releaseDirectory()
}
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  if (channel === 'list-siblings') {
    globalThis.startupProbe.directoryRequested = true
    await directoryGate
  }
  return listener(...args)
})
app.on('web-contents-created', (_event, contents) => {
  const originalSend = contents.send.bind(contents)
  contents.send = (channel, ...args) => {
    if (channel === 'file-opened') globalThis.startupProbe.deliveries.push(args[0].path)
    return originalSend(channel, ...args)
  }
})
require(join(__dirname, 'offscreen-window.cjs'))
