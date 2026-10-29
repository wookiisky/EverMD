#!/usr/bin/env node
// 真实 Electron 性能记录：先 npm run build；窗口离屏，测试文件和 profile 用完清理。
// --output /tmp/before-ui.json 保存报告；请串行运行，verifyWorkdir 会结束其他验收进程。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'
import { performanceDocument, timingSummary, writePerformanceReport } from './performance-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const source = "document.getElementById('source-editor')"
// macOS 完全隐藏窗口即使关闭后台节流，合成器仍可能只给每秒一帧。
// 性能边界因此限定为事件处理、微任务及同步布局；这里不伪造动画帧或声称已呈现。
const settleLayout = `await new Promise(resolve => setTimeout(resolve, 0));
  document.querySelector('#editor .cm-content')?.getBoundingClientRect();
  document.getElementById('source-editor').getBoundingClientRect()`
const sampleCount = 12, warmupCount = 3
assertBuildFresh()
const { dir, udd } = verifyWorkdir('performance-ui')
const fixtures = [100, 1000, 4000].map(paragraphs => {
  const text = performanceDocument(paragraphs)
  const path = join(dir, `${paragraphs}.md`)
  writeFileSync(path, text)
  return { paragraphs, path, text }
})
const outlineText = Array.from({ length: 200 }, (_, index) => `## 标题 ${index}\n\n第 ${index} 段正文。\n`).join('\n')
const outlinePath = join(dir, 'outline.md')
writeFileSync(outlinePath, outlineText)

/** 建立有超时和断线错误的调试连接，不能在目标关闭时静默成功。 */
async function connect(port, type) {
  let target
  for (let attempt = 0; attempt < 300 && !target; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === type) } catch {}
    if (!target) await pause(100)
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
    const message = JSON.parse(event.data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('调试连接已关闭'))
    }
    pending.clear()
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`调试请求超时：${method}`)) }, 30000)
        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close()
  }
}

/** 表达式错误必须向上传递，避免把未完成的输入测成零耗时。 */
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

const port = 27000 + Math.floor(Math.random() * 400)
const inspectPort = port + 1000
const env = { ...process.env, COLAMD_STARTUP_TRACE: '1' }
delete env.ELECTRON_RUN_AS_NODE
let renderer, main, child, launchOutput = ''
const report = { boundary: '离屏 Electron：动作后一个事件循环及强制布局读取；包含 CDP 往返开销，不测动画帧完成或显示器呈现',
  scrollRenderingMeasured: false,
  platform: process.platform, arch: process.arch, sampleCount, warmupCount, results: [] }

/** 等待应用实际状态而非固定延迟，超时属于失败。 */
async function waitFor(expression, message) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await evaluate(renderer, expression)) return
    await pause(50)
  }
  throw new Error(message)
}

/** 通过现有主进程到渲染层的 IPC 入口设置偏好，保持测试窗口不抢焦点。 */
async function setHidden(enabled) {
  await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('set-hide-blank-lines', ${enabled})`)
  await waitFor(`localStorage.getItem('colamd-hide-blank-lines') === '${enabled ? '1' : '0'}'`, '隐藏空行偏好未更新')
  await evaluate(renderer, `(async () => { ${settleLayout}; return true })()`)
}

/** 文件打开走应用 IPC，计时到目标正文可编辑并完成同步布局读取。 */
async function openFixture(fixture) {
  const started = performance.now()
  await evaluate(renderer, `window.electronAPI.openFilePath(${JSON.stringify(fixture.path)})`)
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(fixture.text)} && !${source}.classList.contains('visible')`, '目标文档没有载入')
  await evaluate(renderer, `(async () => { ${view}.focus(); ${settleLayout}; return true })()`)
  return performance.now() - started
}

/** 每次动作均等待事件处理与布局读取，预热样本不计入汇总。 */
async function measure(action) {
  const values = []
  for (let index = 0; index < sampleCount + warmupCount; index++) {
    const elapsed = await action(index)
    if (index >= warmupCount) values.push(elapsed)
  }
  return timingSummary(values)
}

try {
  const started = performance.now()
  child = spawn(require('electron'), ['scripts/offscreen-window.cjs', fixtures[0].path,
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { launchOutput += data.toString() })
  child.stderr.on('data', data => { launchOutput += data.toString() })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  // app.hide() 保证不抢用户焦点，但 Electron 的后台节流会把 rAF 限为约一秒。
  // 仅测试窗口关闭节流；不改变不可见、透明度和离屏位置。
  await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)`)
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false })
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(fixtures[0].text)}`, '启动文档未载入')
  await evaluate(renderer, `(async () => { ${view}.focus(); ${settleLayout}; return true })()`)
  report.firstDocumentObservedMs = performance.now() - started
  report.startupObservation = '从 spawn 到调试端观察到启动正文并读取布局，包含调试连接及轮询开销'
  report.firstContentfulPaintMs = await evaluate(renderer, "performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null")
  report.electron = await evaluate(main, 'process.versions.electron')
  await renderer.send('HeapProfiler.collectGarbage')
  report.initialHeap = await renderer.send('Runtime.getHeapUsage')

  for (const fixture of fixtures) {
    // 每种偏好使用不同文件，避免已经输入过的旧标签影响下一组文档基线。
    for (const hideBlankLines of [false, true]) {
      const variant = { ...fixture, path: join(dir, `${fixture.paragraphs}-${hideBlankLines}.md`) }
      writeFileSync(variant.path, variant.text)
      await setHidden(hideBlankLines)
      const openMs = await openFixture(variant)
      const selection = await measure(index => evaluate(renderer, `(async () => {
        const view = ${view}, started = performance.now()
        view.dispatch({selection:{anchor:${10 + index % 8}}})
        ${settleLayout}
        return performance.now() - started
      })()`))
      await evaluate(renderer, `${view}.dispatch({selection:{anchor:10}}); ${view}.focus(); true`)
      const beforeTyping = await evaluate(renderer, `${view}.state.doc.toString()`)
      const typing = await measure(async () => {
        await evaluate(renderer, 'window.performanceInputStarted = performance.now()')
        await renderer.send('Input.insertText', { text: '字' })
        return evaluate(renderer, `(async () => { ${settleLayout}; return performance.now() - window.performanceInputStarted })()`)
      })
      const afterTyping = await evaluate(renderer, `${view}.state.doc.toString()`)
      assert.equal(afterTyping, beforeTyping.slice(0, 10) + '字'.repeat(sampleCount + warmupCount) + beforeTyping.slice(10), '真实输入必须落在预期位置')
      const scrollLayout = await measure(index => evaluate(renderer, `(async () => {
        const view = ${view}, started = performance.now()
        view.scrollDOM.scrollTop = ${index % 2 ? '0' : 'view.scrollDOM.scrollHeight'}
        ${settleLayout}
        return performance.now() - started
      })()`))
      // 源码选择不依赖隐藏空行；每种文档只测一次，避免重复扩张运行时间。
      let sourceSelection = null
      if (!hideBlankLines) {
        await evaluate(renderer, `document.getElementById('source-toggle-btn').click(); true`)
        await waitFor(`${source}.classList.contains('visible')`, '未切换源码模式')
        sourceSelection = await measure(index => evaluate(renderer, `(async () => {
          const source = ${source}, started = performance.now()
          source.setSelectionRange(${10 + index % 8}, ${10 + index % 8})
          source.dispatchEvent(new Event('select'))
          ${settleLayout}
          return performance.now() - started
        })()`))
      }
      report.results.push({ paragraphs: fixture.paragraphs, characters: fixture.text.length, hideBlankLines,
        openMs, selection, typing, scrollLayout, sourceSelection })
      console.error(`完成：${fixture.paragraphs} 段，隐藏空行 ${hideBlankLines}`)
    }
  }

  await setHidden(false)
  await openFixture({ path: outlinePath, text: outlineText })
  await evaluate(main, `(() => {
    const win = require('electron').BrowserWindow.getAllWindows()[0]
    win.webContents.send('set-sidebar-content', 'left', 'outline')
    win.webContents.send('set-sidebar-content', 'right', 'outline')
  })()`)
  for (const side of ['left', 'right']) {
    if (await evaluate(renderer, `document.getElementById('${side}-sidebar').getAttribute('aria-hidden') === 'true'`)) {
      await evaluate(renderer, `document.getElementById('${side}-sidebar-toggle').click(); true`)
    }
  }
  await waitFor(`document.querySelectorAll('.outline-list button').length === 400`, '双侧大纲未渲染')
  await evaluate(renderer, `(() => {
    window.performanceOutlineMutations = { addedButtons: 0, removedButtons: 0 }
    const count = nodes => [...nodes].reduce((sum, node) => sum + (node.matches?.('button') ? 1 : 0) + (node.querySelectorAll?.('button').length ?? 0), 0)
    window.performanceOutlineObserver = new MutationObserver(records => {
      for (const record of records) {
        performanceOutlineMutations.addedButtons += count(record.addedNodes)
        performanceOutlineMutations.removedButtons += count(record.removedNodes)
      }
    })
    document.querySelectorAll('.outline-list').forEach(list => performanceOutlineObserver.observe(list, { childList: true, subtree: true }))
    const view = ${view}
    view.dispatch({selection:{anchor:view.state.doc.toString().indexOf('正文')}})
    view.focus()
  })()`)
  report.outlineTyping = await measure(async () => {
    await evaluate(renderer, 'window.performanceInputStarted = performance.now()')
    await renderer.send('Input.insertText', { text: '字' })
    return evaluate(renderer, `(async () => { ${settleLayout}; return performance.now() - performanceInputStarted })()`)
  })
  // 大纲用 rAF 合并刷新，因此只在整组动作后等两帧，让最后一次刷新及观察器都完成。
  await evaluate(renderer, '(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return true })()')
  report.outlineMutations = await evaluate(renderer, 'performanceOutlineObserver.disconnect(); performanceOutlineMutations')
  await renderer.send('HeapProfiler.collectGarbage')
  report.finalHeap = await renderer.send('Runtime.getHeapUsage')
  report.memoryObservation = '强制 GC 后的起止堆大小；结束时保留本轮打开的多个标签，不能单凭差值判定泄漏'
  writePerformanceReport(report)
} catch (error) {
  console.error(launchOutput.slice(-6000))
  throw error
} finally {
  renderer?.close()
  main?.close()
  stopVerifyApp(udd)
  child?.kill()
}
