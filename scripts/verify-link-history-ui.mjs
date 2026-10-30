#!/usr/bin/env node
// 真实点击跨文件链接后回退，分别核对历史步数、阅读位置与文档字节。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { dir, udd } = verifyWorkdir('link-history')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const documentsIndex = process.argv.indexOf('--documents-dir')
const documentsDir = documentsIndex < 0 ? null : resolve(process.argv[documentsIndex + 1])
const files = [], originals = [], cases = []
let source

// 原件只读；测试始终在隔离目录中的副本上运行。
function snapshot(file) {
  return { file, bytes: readFileSync(file), mtime: statSync(file).mtimeMs }
}

if (documentsDir) {
  for (const name of ['02_场景与任务梳理.md', '05_技能与进行中表达梳理.md']) {
    const original = join(documentsDir, name)
    originals.push(snapshot(original))
    const copy = join(dir, name)
    copyFileSync(original, copy)
    files.push(copy)
  }
  source = files[0]
  for (const table of [false, true]) cases.push({
    name: `实际文档${table ? '表格' : '正文'}链接`, label: 'follow_person', table,
    target: files[1], heading: 'follow_person',
  })
} else {
  source = join(dir, '阅读原文.md')
  const filler = name => Array.from({ length: 65 }, (_, i) => `${name}第 ${i + 1} 段，滚动阅读时光标仍在文首。\n`).join('\n')
  const plainTarget = join(dir, '正文技能.md'), tableTarget = join(dir, '表格技能.md')
  writeFileSync(source, '# 阅读原文\n\n' + filler('前半部分') +
    '[正文技能链接](正文技能.md#技能标题)\n\n' + filler('中间部分') +
    '\n| 场景 | 技能 | 说明 |\n| --- | --- | --- |\n' +
    '| 正在跟随 | [表格技能链接](表格技能.md#技能标题) | 返回时这一行仍应在原来的屏幕位置。 |\n\n' + filler('末尾部分'))
  for (const file of [plainTarget, tableTarget]) writeFileSync(file, '# 技能文件\n\n' + filler('技能说明') + '## 技能标题\n\n' + filler('后续说明'))
  files.push(source, plainTarget, tableTarget)
  for (const table of [false, true]) for (const existing of [false, true]) cases.push({
    name: `${table ? '表格' : '正文'}链接${existing ? '复用标签' : '新建标签'}`,
    label: table ? '表格技能链接' : '正文技能链接', table,
    target: table ? tableTarget : plainTarget, heading: '技能标题', existing,
  })
}
const copies = files.map(snapshot)
const port = 24700 + Math.floor(Math.random() * 150)
const inspectPort = port + 1000
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child, renderer, main, passed = 0

// 调试连接有界等待，页面异常或提前关闭都明确失败。
async function connect(portNumber, type) {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json()).find(item => item.type === type) }
    catch { /* Electron 尚未开始监听。 */ }
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
    const message = JSON.parse(event.data), request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('调试目标提前关闭')) }
    pending.clear()
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`调试请求超时：${method}`)) }, 15000)
        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close(),
  }
}

// 调试协议仅用于观察真实编辑器，不替换应用导航实现。
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 等待可观察状态，失败时保留具体行为描述。
async function waitFor(expression, message) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(renderer, expression)) return
    await pause(100)
  }
  throw new Error(message)
}

// 断言直接描述用户可见的结果。
function check(name, ok, detail = '') {
  assert(ok, detail ? `${name}：${detail}` : name)
  passed++
  console.log(`通过：${name}${detail ? `；${detail}` : ''}`)
}

// 菜单点击覆盖真实的主进程、IPC 与文档切换队列。
async function clickMenu(id) {
  await evaluate(main, `(() => {
    const { Menu, BrowserWindow } = require('electron')
    const item = Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)})
    if (!item?.enabled) throw new Error('菜单不可用：' + ${JSON.stringify(id)})
    item.click(item, BrowserWindow.getAllWindows()[0])
  })()`)
}

// 以所在表格行或段落区分同文档中重复的同名技能链接。
function linkMetric(testCase, context = null) {
  return `(() => {
    const scroller = ${view}.scrollDOM, bounds = scroller.getBoundingClientRect()
    for (const element of document.querySelectorAll('#editor [data-href], #editor a[href]')) {
      if (element.textContent !== ${JSON.stringify(testCase.label)} || !!element.closest('table') !== ${testCase.table}) continue
      const context = (element.closest('tr') ?? element.closest('.cm-line'))?.textContent ?? element.textContent
      if (${JSON.stringify(context)} !== null && context !== ${JSON.stringify(context)}) continue
      const rect = [...element.getClientRects()].find(r => r.width > 2 && r.height > 2 && r.top >= bounds.top + 5 && r.bottom <= bounds.bottom - 5)
      if (!rect) continue
      const x = Math.min(rect.right - 1, bounds.right - 5), y = rect.top + rect.height / 2
      if (x < Math.max(rect.left, bounds.left + 5)) continue
      return { x, y, relativeY: y - bounds.top, context, scrollTop: scroller.scrollTop, head: ${view}.state.selection.main.head }
    }
    return null
  })()`
}

// 只滚动文档让链接进入视口；不移动源码光标或调用导航函数。
async function revealLink(testCase) {
  const sourceFrom = await evaluate(renderer, `(() => {
    const v = ${view}, needle = '[' + ${JSON.stringify(testCase.label)} + ']('
    let from = 0
    for (const line of v.state.doc.toString().split('\\n')) {
      if (line.includes(needle) && /^\\s*\\|/.test(line) === ${testCase.table}) break
      from += line.length + 1
    }
    if (from > v.state.doc.length) throw new Error('源码中没有目标链接')
    // 只滚动到对应源码块，再按真实链接的 DOM 位置微调，光标保持原位。
    v.scrollDOM.scrollTop += v.lineBlockAt(from).top + v.documentTop
      - v.scrollDOM.getBoundingClientRect().top - v.scrollDOM.clientHeight * 0.4
    return from
  })()`)
  await pause(200)
  let metric
  const candidates = []
  for (let i = 0; i < 150 && !metric; i++) {
    const revealed = await evaluate(renderer, `(() => {
      const element = [...document.querySelectorAll('#editor [data-href], #editor a[href]')]
        .find(element => element.textContent === ${JSON.stringify(testCase.label)} && !!element.closest('table') === ${testCase.table})
      if (!element) return false
      element.scrollIntoView({ block: 'center', behavior: 'instant' })
      return true
    })()`)
    if (revealed) await pause(200)
    metric = await evaluate(renderer, linkMetric(testCase))
    const observed = await evaluate(renderer, `(() => {
      const v = ${view}
      return {
        step: ${i}, scrollTop: v.scrollDOM.scrollTop,
        links: [...document.querySelectorAll('#editor [data-href], #editor a[href]')]
          .filter(element => element.textContent.includes(${JSON.stringify(testCase.label)}))
          .slice(0, 8).map(element => {
            const r = element.getBoundingClientRect()
            return { text: element.textContent, table: !!element.closest('table'), href: element.getAttribute('data-href') ?? element.getAttribute('href'),
              rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } }
          }),
      }
    })()`)
    // 保留每一步的滚动进度和最近候选，只有失败时输出，正常验收保持安静。
    candidates.push(observed)
    if (!metric) {
      if (!revealed) await evaluate(renderer, `(() => {
        const v = ${view}
        v.scrollDOM.scrollTop += v.lineBlockAt(${sourceFrom}).top + v.documentTop
          - v.scrollDOM.getBoundingClientRect().top - v.scrollDOM.clientHeight * 0.4
      })()`)
      await pause(100)
    }
  }
  if (!metric) console.error(`${testCase.name}查找链接失败：`, JSON.stringify({
    sourceContainsLabel: await evaluate(renderer, `${view}.state.doc.toString().includes(${JSON.stringify(testCase.label)})`),
    recentSteps: candidates.slice(-10), recentCandidates: candidates.filter(step => step.links.length > 0).slice(-12),
  }, null, 2))
  assert(metric, `${testCase.name}没有进入视口`)
  // 避开视口边缘，使位置误差不会被“刚好仍然可见”掩盖。
  await evaluate(renderer, `(() => { const v = ${view}; v.scrollDOM.scrollTop += ${metric.relativeY} - v.scrollDOM.clientHeight * 0.4 })()`)
  await pause(250)
  metric = await evaluate(renderer, linkMetric(testCase, metric.context))
  assert(metric, `${testCase.name}居中后不可见`)
  return metric
}

// 目标标题必须真实显示在编辑区内，不能只检查文件或选区。
function headingMetric(testCase) {
  return `(() => {
    const bounds = ${view}.scrollDOM.getBoundingClientRect()
    for (const line of document.querySelectorAll('#editor .cm-line')) {
      if (line.textContent.replace(/^#+\\s*/, '').trim() !== ${JSON.stringify(testCase.heading)}) continue
      // 标题行包含上下排版留白；可见性按文字本身判断。
      const range = document.createRange(); range.selectNodeContents(line)
      const rect = range.getBoundingClientRect()
      if (rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1) return { relativeY: rect.top - bounds.top }
    }
    return null
  })()`
}

// 等布局连续三次稳定，避免把渲染中间帧当成导航恢复结果。
async function stableMetric(expression, label, expectedY) {
  let previous, stable = 0
  for (let i = 0; i < 100; i++) {
    const metric = await evaluate(renderer, expression)
    if (metric && previous && Math.abs(metric.relativeY - previous.relativeY) < 0.25
      && (expectedY === undefined || Math.abs(metric.relativeY - expectedY) <= 4)) stable++
    else stable = 0
    if (stable >= 3) return metric
    previous = metric
    await pause(100)
  }
  throw new Error(`${label}未形成稳定的可见位置：${JSON.stringify({ expectedY, actual: previous })}`)
}

try {
  child = spawn(require('electron'), [
    'scripts/offscreen-window.cjs', source, `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`document.title === ${JSON.stringify(basename(source))} && !!${view}`, '原文档没有载入')
  for (const testCase of cases) {
    const before = await revealLink(testCase)
    check(`${testCase.name}点击前只滚动，光标仍在文首`, before.head === 0 && before.scrollTop > 0, JSON.stringify(before))
    const tabCount = await evaluate(renderer, "document.querySelectorAll('.tab-entry').length")
    for (const type of ['mousePressed', 'mouseReleased']) await renderer.send('Input.dispatchMouseEvent', {
      type, x: before.x, y: before.y, button: 'left', clickCount: 1,
    })
    await waitFor(`document.title === ${JSON.stringify(basename(testCase.target))} && !!${headingMetric(testCase)}`, `${testCase.name}没有跳到目标标题`)
    await pause(650)
    const target = await stableMetric(headingMetric(testCase), `${testCase.name}目标标题`)
    const openedTabCount = await evaluate(renderer, "document.querySelectorAll('.tab-entry').length")
    if (testCase.existing !== undefined) check(`${testCase.name}遵循标签复用规则`, openedTabCount === tabCount + (testCase.existing ? 0 : 1))
    await clickMenu('navigation-back')
    // 等待一次菜单动作的最终结果，不能再点击第二次替测试纠错。
    await waitFor(`document.title === ${JSON.stringify(basename(source))}`, `${testCase.name}一次回退仍留在技能文件`)
    const returned = await stableMetric(linkMetric(testCase, before.context), `${testCase.name}回退位置`, before.relativeY)
    check(`${testCase.name}一次回退恢复原链接的屏幕位置`, Math.abs(returned.relativeY - before.relativeY) <= 4,
      JSON.stringify({ before: before.relativeY, after: returned.relativeY, delta: returned.relativeY - before.relativeY }))
    check(`${testCase.name}恢复阅读位置时保留原光标`, returned.head === before.head)
    await clickMenu('navigation-forward')
    await waitFor(`document.title === ${JSON.stringify(basename(testCase.target))}`, `${testCase.name}前进没有返回技能文件`)
    const forwarded = await stableMetric(headingMetric(testCase), `${testCase.name}前进位置`, target.relativeY)
    check(`${testCase.name}前进仍定位同一标题`, Math.abs(forwarded.relativeY - target.relativeY) <= 4,
      JSON.stringify({ before: target.relativeY, after: forwarded.relativeY }))
    await clickMenu('navigation-back')
    await waitFor(`document.title === ${JSON.stringify(basename(source))}`, `${testCase.name}第二轮回退没有返回原文档`)
    const repeated = await stableMetric(linkMetric(testCase, before.context), `${testCase.name}再次回退位置`, before.relativeY)
    check(`${testCase.name}连续回放不增加中间历史`, Math.abs(repeated.relativeY - before.relativeY) <= 4)
    await evaluate(main, `(() => {
      const { Menu, BrowserWindow } = require('electron'), menu = Menu.getApplicationMenu(), win = BrowserWindow.getAllWindows()[0]
      for (const id of ['navigation-forward', 'navigation-back', 'navigation-forward', 'navigation-back', 'navigation-back']) {
        const item = menu.getMenuItemById(id); item.click(item, win)
      }
    })()`)
    await pause(650)
    await waitFor(`document.title === ${JSON.stringify(basename(source))}`, `${testCase.name}快速回放没有返回原文档`)
    const rapid = await stableMetric(linkMetric(testCase, before.context), `${testCase.name}快速回放位置`, before.relativeY)
    check(`${testCase.name}快速回放与到边界后再次后退均保留阅读位置`, Math.abs(rapid.relativeY - before.relativeY) <= 4,
      JSON.stringify({ before: before.relativeY, after: rapid.relativeY }))
  }
  for (const saved of [...copies, ...originals]) check(`导航未改写 ${originals.some(item => item.file === saved.file) ? '原件' : '副本'} ${basename(saved.file)}`,
    readFileSync(saved.file).equals(saved.bytes) && statSync(saved.file).mtimeMs === saved.mtime)
  console.log(`链接回退真机验收通过，共 ${passed} 项。`)
} catch (error) {
  console.error(error)
  if (renderer) console.error('失败时编辑器状态：', JSON.stringify(await evaluate(renderer, `(() => {
    const v = ${view}
    if (!v) return { title: document.title, editor: null }
    const bounds = v.scrollDOM.getBoundingClientRect(), head = v.state.selection.main.head
    const rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } }
    return {
      title: document.title, head, scrollTop: v.scrollDOM.scrollTop,
      editor: rect(v.scrollDOM), headCoords: v.coordsAtPos(head), headLine: v.state.doc.lineAt(head).text,
      visibleLines: [...document.querySelectorAll('#editor .cm-line')]
        .filter(element => { const r = element.getBoundingClientRect(); return r.bottom > bounds.top && r.top < bounds.bottom })
        .slice(0, 20).map(element => ({ text: element.textContent, rect: rect(element) })),
    }
  })()`).catch(() => null), null, 2))
  process.exitCode = 1
} finally {
  renderer?.close()
  main?.close()
  child?.kill('SIGTERM')
  stopVerifyApp(udd)
}
