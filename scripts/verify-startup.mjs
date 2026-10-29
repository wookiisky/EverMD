#!/usr/bin/env node
// 真实 Electron：目录请求未完成时，启动正文和排队标签也必须能够交付。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { dir, udd } = verifyWorkdir('startup')
const files = [join(dir, 'first.md'), join(dir, 'second.md')]
const texts = ['# 第一篇\n\n启动正文。', '# 第二篇\n\n排队正文。']
files.forEach((file, i) => writeFileSync(file, texts[i]))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const port = 28400 + Math.floor(Math.random() * 200)
const inspectPort = port + 1000
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, renderer, main
// 调试请求有超时，目标提前销毁不能被当作通过。
async function connect(number, type) {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${number}/json/list`)).json()).find(item => item.type === type)
    } catch { /* 应用尚未就绪。 */ }
    if (!target) await pause(250)
  }
  assert(target, `未找到 ${type} 调试目标`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('调试目标提前关闭'))
    }
    pending.clear()
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`调试请求超时：${method}`))
        }, 15000)
        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close()
  }
}

// 页面和主进程都只取可序列化结果；异常直接使验收失败。
async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true
  })
  assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails))
  return response.result.value
}

// 等待真实可观察状态，避免将异步操作中间帧误判为完成。
async function waitFor(expression, message, client = renderer) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(client, expression)) return
    await pause(100)
  }
  throw new Error(message)
}


try {
  child = spawn(require('electron'), ['scripts/startup-test-window.cjs', ...files,
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor('startupProbe.directoryRequested', '未触发目录读取', main)
  assert.equal(await evaluate(main, 'startupProbe.directoryReleased'), false)
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(texts[1])} && document.querySelectorAll('.tab-entry').length === 2`,
    '目录请求未完成时，启动正文或排队标签被阻塞')
  assert.deepEqual(await evaluate(main, 'startupProbe.deliveries'), [files[0]], '首篇文件只交付一次，第二篇走标签打开通道')
  await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].webContents.send('set-sidebar-content', 'left', 'files')")
  await evaluate(renderer, "if (document.getElementById('left-sidebar').getAttribute('aria-hidden') === 'true') document.getElementById('left-sidebar-toggle').click(); true")
  await evaluate(main, 'startupProbe.release(); true')
  await waitFor("document.querySelectorAll('.file-list button[data-path]').length > 0", '目录释放后文件列表未更新')
  await pause(150)
  assert.equal(await evaluate(renderer, "document.querySelectorAll('.tab-entry').length"), 2, '迟到目录结果不重复创建标签')
  assert.equal(await evaluate(renderer, `${view}.state.doc.toString()`), texts[1], '迟到目录结果不覆盖活动正文')
  console.log('通过：目录读取独立于正文交付、多个启动文件顺序正确、首文档只交付一次、迟到目录响应不改正文')
} finally {
  renderer?.close()
  main?.close()
  stopVerifyApp(udd)
  child?.kill()
}
