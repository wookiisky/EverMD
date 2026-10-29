#!/usr/bin/env node
// 打开性能验收：真实离屏 Electron，正文可编辑与目录就绪分别计时。
// --baseline 使用实施前保留的 dist；普通运行必须先构建。串行执行，勿同时运行其他 Electron 验收。
// --profile 只诊断 10 MiB 的打开、离开与切回，记录 CPU 栈和布局计数，不混入常规基准。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'
import { timingSummary, writePerformanceReport } from './performance-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const baseline = process.argv.includes('--baseline')
const profileMode = process.argv.includes('--profile')
if (!baseline) assertBuildFresh()
else console.error('基线模式：读取实施前保留的 dist，不声称该产物包含当前源码。')
const { dir, udd } = verifyWorkdir('opening-performance')
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const source = "document.getElementById('source-editor')"
const sampleCount = 5, warmupCount = 1
const anchorPath = join(dir, 'anchor.md')
const anchorText = '# 打开基准锚点\n\n用于切换回小文档。\n'
writeFileSync(anchorPath, anchorText)
const original = new Map()

// 固定 ASCII 文本使磁盘字节数和 UTF-16 大小明确；CRLF 单独记录文本框规范化后的长度。
function largeText(bytes, crlf) {
  const newline = crlf ? '\r\n' : '\n'
  const prefix = '# Opening benchmark' + newline + newline
  const seed = 'Stable text for opening measurement, number 12345.' + newline + newline
  const suffix = newline + 'END-OPENING-FIXTURE' + newline
  const available = bytes - prefix.length - suffix.length
  return prefix + seed.repeat(Math.ceil(available / seed.length)).slice(0, available) + suffix
}

// 所有测量只读取临时文件，结束核对字节与 mtime 均未改变。
function fixture(path, text) {
  writeFileSync(path, text)
  original.set(path, { text, mtime: statSync(path).mtimeMs })
  return { path, text, source: text.length >= 512 * 1024,
    normalizedLength: text.replace(/\r\n/g, '\n').length }
}

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


const port = 29300 + Math.floor(Math.random() * 200)
const inspectPort = port + 1000
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child, renderer, main, launchOutput = ''
const report = { baseline, profileMode, platform: process.platform, arch: process.arch, sampleCount, warmupCount,
  buildMtime: statSync(join(root, 'dist/main/index.js')).mtime.toISOString(),
  boundary: '真实离屏 Electron：打开到正文可编辑并读取同步布局，包含 IPC、CDP 和观察开销；目录另记动画帧更新后首屏就绪时间，不代表显示器呈现',
  files: [], directories: [], profiles: [] }

// 每个采样间隔归于当前栈；self 是最深帧，inclusive 包含子调用，不能把两者相加。
function summarizeCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) for (const id of node.children ?? []) parents.set(id, node.id)
  const totals = new Map()
  const entry = id => {
    const frame = nodes.get(id).callFrame
    const key = `${frame.functionName}:${frame.url}:${frame.lineNumber}`
    if (!totals.has(key)) totals.set(key, { name: frame.functionName || '(anonymous)',
      url: frame.url, line: frame.lineNumber + 1, selfMs: 0, inclusiveMs: 0 })
    return totals.get(key)
  }
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const ms = (profile.timeDeltas?.[index] ?? 0) / 1000
    entry(id).selfMs += ms
    const visited = new Set()
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) {
      const row = entry(cursor)
      if (!visited.has(row)) row.inclusiveMs += ms
      visited.add(row)
    }
  }
  const rows = [...totals.values()]
  return { sampleCount: profile.samples?.length ?? 0,
    durationMs: (profile.endTime - profile.startTime) / 1000,
    topSelf: rows.toSorted((left, right) => right.selfMs - left.selfMs).slice(0, 15),
    topInclusive: rows.filter(row => row.url).toSorted((left, right) => right.inclusiveMs - left.inclusiveMs).slice(0, 15) }
}

// 布局指标是 Chrome 累计量之差；源码位置有助于区分首次安装和文末离开时的镜像成本。
async function diagnose(name, action) {
  const snapshot = async () => evaluate(renderer, `(() => {
    const source = ${source}
    return { sourceMode: source.classList.contains('visible'), length: source.value.length,
      selectionStart: source.selectionStart, selectionEnd: source.selectionEnd }
  })()`)
  const beforeSelection = await snapshot()
  const before = new Map((await renderer.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]))
  await renderer.send('Profiler.start')
  let observedMs, cpu
  try { observedMs = await action() } finally { cpu = (await renderer.send('Profiler.stop')).profile }
  const after = (await renderer.send('Performance.getMetrics')).metrics
  const metrics = Object.fromEntries(after.filter(metric => [
    'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize'
  ].includes(metric.name)).map(metric => [metric.name, metric.value - (before.get(metric.name) ?? 0)]))
  const outputIndex = process.argv.indexOf('--output')
  const rawPath = outputIndex >= 0 ? `${process.argv[outputIndex + 1]}.${name}.cpuprofile` : null
  if (rawPath) writeFileSync(rawPath, JSON.stringify(cpu))
  report.profiles.push({ name, observedMs, beforeSelection, afterSelection: await snapshot(),
    metricUnits: 'Duration 为秒，Count 为次数，JSHeapUsedSize 为字节差；CPU 采样时间为毫秒',
    metrics, rawPath, ...summarizeCpuProfile(cpu) })
  console.error(`完成诊断：${name}，观察耗时 ${Math.round(observedMs)} ms，布局 ${Math.round(metrics.LayoutDuration * 1000)} ms`)
}

// 轮询只等待当前文档可观察状态，不用固定等待代替内容和可编辑断言。
async function waitFor(expression, message) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await evaluate(renderer, expression)) return
    await pause(10)
  }
  throw new Error(message)
}

// 隐藏窗口的动画帧节流是运行时事实，单独记录目录调度时间，不替换 requestAnimationFrame。
async function setPanels(count) {
  for (const [index, side] of ['left', 'right'].entries()) {
    await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('set-sidebar-content', '${side}', 'files')`)
    const visible = index < count
    await evaluate(renderer, `(() => {
      const panel = document.getElementById('${side}-sidebar')
      if ((panel.getAttribute('aria-hidden') === 'false') !== ${visible}) document.getElementById('${side}-sidebar-toggle').click()
    })()`)
    await waitFor(`document.getElementById('${side}-sidebar').getAttribute('aria-hidden') === '${!visible}'`, '侧栏显隐未应用')
  }
}

// 判断真实编辑区和活动标签，源码模式的 CRLF 按 textarea 规范化规则检查。
function loaded(item) {
  const label = basename(item.path).replace(/\.(md|markdown|mdown|mkd)$/i, '')
  const textCheck = item.source
    ? `${source}.classList.contains('visible') && !${source}.readOnly && ${source}.value.length === ${item.normalizedLength} && ${source}.value.startsWith('# Opening benchmark') && ${source}.value.endsWith('END-OPENING-FIXTURE\\n')`
    : `!${source}.classList.contains('visible') && ${view}?.contentDOM.isContentEditable && ${view}.state.doc.toString() === ${JSON.stringify(item.text)}`
  return `(${textCheck}) && document.querySelector('.tab-entry.active')?.dataset.fullName === ${JSON.stringify(label)} && !document.querySelector('.tab-entry.active.dirty')`
}

// 记录完成同步布局的外部观察时间；正文统计完成不作为正文就绪条件。
async function open(item) {
  const started = performance.now()
  await evaluate(renderer, `window.electronAPI.openFilePath(${JSON.stringify(item.path)})`)
  await waitFor(loaded(item), '目标文档未就绪：' + item.path)
  await evaluate(renderer, `${item.source ? source : view + '.contentDOM'}.getBoundingClientRect().height`)
  return performance.now() - started
}

// 关闭刚测的干净标签，限制 10MB 文本在后台标签中的保留数量。
async function closeActive() {
  const before = await evaluate(renderer, 'document.querySelectorAll(".tab-entry").length')
  assert(before > 1, '保留锚点标签以免关闭测试窗口')
  await evaluate(renderer, 'document.querySelector(".tab-entry.active .tab-entry-close").click()')
  await waitFor(`document.querySelectorAll('.tab-entry').length === ${before - 1}`, '标签未关闭')
}

// 切到已打开标签仍走真实文件校验和恢复，不把首次打开混入这一指标。
async function activate(item) {
  const label = basename(item.path).replace(/\.(md|markdown|mdown|mkd)$/i, '')
  const started = performance.now()
  await evaluate(renderer, `[...document.querySelectorAll('.tab-entry')].find(tab => tab.dataset.fullName === ${JSON.stringify(label)}).click()`)
  await waitFor(loaded(item), '已有标签未恢复')
  await evaluate(renderer, `${item.source ? source : view + '.contentDOM'}.getBoundingClientRect().height`)
  return performance.now() - started
}

try {
  child = spawn(require('electron'), ['scripts/offscreen-window.cjs', anchorPath,
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { launchOutput += data.toString() })
  child.stderr.on('data', data => { launchOutput += data.toString() })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)")
  const anchor = { path: anchorPath, text: anchorText, source: false }
  await waitFor(loaded(anchor), '锚点文档未载入')
  report.electron = await evaluate(main, 'process.versions.electron')
  await setPanels(0)

  if (profileMode) {
    await renderer.send('Performance.enable')
    await renderer.send('Profiler.enable')
    await renderer.send('Profiler.setSamplingInterval', { interval: 1000 })
    for (const crlf of [false, true]) {
      const suffix = crlf ? 'CRLF' : 'LF'
      const item = fixture(join(dir, `profile-${suffix}.md`), largeText(10 * 1024 * 1024, crlf))
      await diagnose(`first-open-${suffix}`, () => open(item))
      await diagnose(`leave-to-small-${suffix}`, () => activate(anchor))
      await diagnose(`restore-tab-${suffix}`, () => activate(item))
      await closeActive()
    }
    await renderer.send('Profiler.disable')
    await renderer.send('Performance.disable')
  } else {
    for (const bytes of [1024 * 1024, 10 * 1024 * 1024]) {
      for (const crlf of [false, true]) {
        const text = largeText(bytes, crlf)
        const first = [], switching = []
        for (let index = 0; index < warmupCount + sampleCount; index++) {
          const item = fixture(join(dir, `large-${bytes}-${crlf}-${index}.md`), text)
          const opened = await open(item)
          await activate(anchor)
          const restored = await activate(item)
          if (index >= warmupCount) { first.push(opened); switching.push(restored) }
          await closeActive()
        }
        report.files.push({ bytes, lineEnding: crlf ? 'CRLF' : 'LF', firstOpen: timingSummary(first), existingTab: timingSummary(switching) })
        console.error(`完成：${bytes} 字节 ${crlf ? 'CRLF' : 'LF'} 首次打开与标签切换`)
      }
    }

    for (const entries of [1000, 10000]) {
      const folder = join(dir, `directory-${entries}`)
      mkdirSync(folder)
      for (let index = 0; index < entries; index++) writeFileSync(join(folder, `document-${String(index).padStart(5, '0')}.md`), '# Directory benchmark\n')
      for (const panels of [1, 2]) {
        await setPanels(panels)
        const documentTimes = [], panelTimes = [], elements = [], buttons = []
        for (let index = 0; index < warmupCount + sampleCount; index++) {
          // 新文件路径保证首次打开；回到锚点目录并等它显示，避免把旧列表当成本次结果。
          await activate(anchor)
          await waitFor(`[...document.querySelectorAll('#left-sidebar .file-list button')].some(button => button.dataset.path === ${JSON.stringify(anchorPath)})`, '锚点目录未恢复')
          const path = join(folder, `document-${String(index).padStart(5, '0')}.md`)
          const text = readFileSync(path, 'utf8')
          original.set(path, { text, mtime: statSync(path).mtimeMs })
          const started = performance.now()
          const documentMs = await open({ path, text, source: false })
          await waitFor(`['left','right'].slice(0, ${panels}).every(side => [...document.querySelectorAll('#' + side + '-sidebar .file-list button')].some(button => button.dataset.path?.startsWith(${JSON.stringify(folder + '/')})))`, '目录首屏未刷新')
          const sizes = await evaluate(renderer, `(() => {
            const lists = ['left','right'].slice(0, ${panels}).map(side => document.querySelector('#' + side + '-sidebar .file-list'))
            lists.forEach(list => list.getBoundingClientRect())
            return { elements: lists.reduce((n,list) => n + list.querySelectorAll('*').length, 0), buttons: lists.reduce((n,list) => n + list.querySelectorAll('button').length, 0) }
          })()`)
          if (index >= warmupCount) {
            documentTimes.push(documentMs); panelTimes.push(performance.now() - started)
            elements.push(sizes.elements); buttons.push(sizes.buttons)
          }
          await closeActive()
        }
        report.directories.push({ entries, panels, documentReady: timingSummary(documentTimes), directoryReady: timingSummary(panelTimes), elementCounts: elements, buttonCounts: buttons })
        console.error(`完成：${entries} 个目录条目，${panels} 侧文件面板`)
      }
    }
  }
  for (const [path, expected] of original) {
    assert.equal(readFileSync(path, 'utf8'), expected.text, '打开/切换不得改写字节')
    assert.equal(statSync(path).mtimeMs, expected.mtime, '打开/切换不得落盘')
  }
  assert.equal(await evaluate(renderer, 'document.querySelectorAll(".tab-entry.dirty").length'), 0, '程序化打开不标记已编辑')
  writePerformanceReport(report)
} catch (error) {
  console.error(launchOutput.slice(-3000))
  throw error
} finally {
  renderer?.close()
  main?.close()
  stopVerifyApp(udd)
  child?.kill()
}
