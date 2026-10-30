// 原生 .app 保持原入口：在入口执行前接入隔离与离屏壳，再恢复原有主模块。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const wrapperPath = fileURLToPath(new URL('./startup-performance-window.cjs', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// child 必须已用 --inspect-brk 启动；连接暂停本身会增加观察耗时，应单独记录。
export async function preparePackagedStartup(child, inspectPort) {
  const started = performance.now()
  let target
  for (let attempt = 0; attempt < 1500 && !target; attempt++) {
    assert(child.exitCode === null, '原生应用在连接主进程调试器前退出')
    try {
      const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
      target = targets.find(item => item.type === 'node')
    } catch { /* Node inspector 尚未就绪。 */ }
    if (!target) await pause(10)
  }
  assert(target, '未找到原生应用主进程调试目标')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 0, resolvePaused, rejectPaused
  const paused = new Promise((resolve, reject) => { resolvePaused = resolve; rejectPaused = reject })
  paused.catch(() => {})
  // 先注册事件，再让 Node 继续加载脚本，防止漏掉首条暂停事件。
  const pausedTimer = setTimeout(() => rejectPaused(new Error('原生应用没有停在主模块入口')), 15000)
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data)
    if (response.method === 'Debugger.paused') {
      clearTimeout(pausedTimer)
      resolvePaused(response.params)
    }
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result)
  })
  ws.addEventListener('close', () => {
    clearTimeout(pausedTimer)
    rejectPaused(new Error('主模块暂停前调试连接已关闭'))
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('主进程调试连接提前关闭'))
    }
    pending.clear()
  })
  // 发送协议请求，目标关闭或超时都属于失败。
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`主进程调试请求超时：${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
  // 即使打开连接失败，暂停 Promise 也已有拒绝处理，不产生孤立的 rejection。
  const opening = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  try {
    await opening
    await send('Debugger.enable')
    await send('Runtime.runIfWaitingForDebugger')
    const stop = await paused
    const frame = stop.callFrames[0]
    assert(frame, '主模块暂停没有可求值的调用帧')
    const prepared = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: `(() => {
        const { app } = require('electron');
        if (!app.isPackaged) throw new Error('启动目标不是打包应用');
        const { resolve } = require('node:path');
        const entry = require.resolve(resolve(process.env.EVERMD_STARTUP_DIST, 'main', 'index.js'));
        if (!require.cache[entry] || require.cache[entry].loaded) {
          throw new Error('主模块尚未进入缓存，或已经执行，不能安全接入离屏壳');
        }
        require(${JSON.stringify(wrapperPath)});
        return { isPackaged: app.isPackaged, entry };
      })()`,
      returnByValue: true
    })
    assert(!prepared.exceptionDetails, `接入离屏壳失败：${JSON.stringify(prepared.exceptionDetails)}`)
    assert(prepared.result.value?.isPackaged, '原生应用没有保持打包模式')
    await send('Debugger.resume')
    return {
      inspectorPreparationMs: performance.now() - started,
      inspectorBoundary: '包含连接主进程、等待入口暂停、安装隔离及离屏壳和恢复执行；不能从总耗时简单相减得到无调试启动耗时。',
      pausedUrl: frame.url,
      pausedLine: frame.location.lineNumber + 1,
      ...prepared.result.value
    }
  } finally {
    clearTimeout(pausedTimer)
    // 若其它协议调用先失败，消费尚未结束的暂停 Promise，避免未处理拒绝。
    paused.catch(() => {})
    ws.close()
  }
}
