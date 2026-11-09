// 先构建，再用离屏 Electron 验证渲染编辑器中的代码折叠。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const workdir = mkdtempSync(join(tmpdir(), 'evermd-fold-ui-'))
const profile = join(workdir, 'profile')
const files = ['折叠甲.md', '折叠乙.md'].map(name => join(workdir, name))
const code = [
  '{',
  '  "outsideFold": true,',
  '  "items": [',
  '    {',
  '      "name": "HiddenFoldMarker",',
  '      "literal": "a } bracket in a string"',
  '    }',
  '  ]',
  '}',
].join('\n')
const fixture = [
  '代码折叠验收', '', '```json', code, '```', '',
  '```text', 'PlainFoldLine1', 'PlainFoldLine2', '```', '', '正文仍然可见', '',
].join('\n')
for (const file of files) writeFileSync(file, fixture)
const originals = files.map(file => ({ bytes: readFileSync(file), mtime: statSync(file).mtimeMs }))
const port = 29800 + Math.floor(Math.random() * 250)
const env = { ...process.env, EVERMD_STARTUP_HOME: join(workdir, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [
  'scripts/offscreen-window.cjs', files[0], `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] })
let launchError = ''
child.stderr.on('data', chunk => { launchError += chunk })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws

// 仅结束本次验收的窗口与进程，保留其他正在运行的验收。
function cleanup() {
  ws?.close()
  if (child.exitCode === null) child.kill('SIGTERM')
  stopVerifyApp(profile)
  rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(1) })

// CDP 请求和启动轮询均有超时，避免测试窗口退出后挂起。
async function connect() {
  let page
  for (let i = 0; i < 120 && !page && child.exitCode === null; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })
      page = (await response.json()).find(target => target.type === 'page')
    } catch { /* 等待调试端口监听。 */ }
    if (!page) await pause(100)
  }
  assert(page, `没有 Electron 页面，进程退出码 ${child.exitCode}\n${launchError}`)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('调试连接超时')), 10000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('调试页面已关闭'))
    }
    pending.clear()
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`调试请求超时 ${method}`)) }, 15000)
    pending.set(requestId, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
}

// 以下辅助方法在真实渲染进程中查询界面，避免依赖折叠模块内部实现。
function installProbe() {
  const content = () => document.querySelector('#editor .cm-content')
  const view = () => content().cmTile.root.view
  const buttons = kind => [...content().querySelectorAll(`.code-fold-btn.code-fold-${kind}`)]
  const button = (kind, line) => buttons(kind).find(element => element.closest('.cm-line')?.textContent.includes(line))
  const visible = text => content().textContent.includes(text)
  const expanded = (kind, line) => button(kind, line)?.getAttribute('aria-expanded')
  const activeTab = () => document.querySelector('.tab-entry.active')?.dataset.filePath
  const waitForPaint = async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
  }
  const position = element => {
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) throw new Error('控件没有可点击区域')
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  const copySelection = () => {
    const editor = view()
    const { length } = editor.state.doc
    editor.dispatch({ selection: { anchor: 0, head: length } })
    const clipboard = new DataTransfer()
    editor.contentDOM.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    return { text: clipboard.getData('text/plain'), html: clipboard.getData('text/html') }
  }
  window.foldProbe = { view, buttons, button, visible, expanded, activeTab, waitForPaint, position, copySelection }
}

try {
  const send = await connect()
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async (expression, message) => {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(expression)) return
      await pause(50)
    }
    throw new Error(message)
  }
  const check = async (expression, message) => {
    assert(await evaluate(expression), message)
    console.log(`通过：${message}`)
  }
  const key = async (value, keyCode, code = value, modifiers = 0) => {
    const params = { key: value, code, windowsVirtualKeyCode: keyCode, modifiers }
    if (value === 'Enter') await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...params })
    else await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  const click = async element => {
    const point = await evaluate(`foldProbe.position(${element})`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await check(`(${element}).contains(document.elementFromPoint(${point.x}, ${point.y}))`, '鼠标能命中目标控件')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await evaluate('foldProbe.waitForPaint()')
  }
  const block = 'foldProbe.button("block", "json")'
  const item = `foldProbe.button("section", ${JSON.stringify('"items"')})`
  const outer = 'foldProbe.buttons("section")[0]'
  const collapsedBlock = 'foldProbe.expanded("block", "json") === "false"'
  const sentinel = 'foldProbe.visible("HiddenFoldMarker")'
  const themeBundle = await build({
    stdin: {
      contents: "export { applyThemeToDocument } from './src/renderer/themes/theme-document'; export { BUILTIN_THEMES } from './src/shared/theme-definition'",
      resolveDir: root,
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'FoldingThemes', logLevel: 'silent',
  })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false })
  await waitFor(`document.querySelector('#editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(fixture)}`, '夹具未加载')
  await evaluate(`(${installProbe.toString()})()`)
  await evaluate(themeBundle.outputFiles[0].text)
  await waitFor(`!!${item} && !!${block}`, 'JSON 的折叠入口未随语言解析出现')

  for (const theme of ['light', 'dark']) {
    await evaluate(`FoldingThemes.applyThemeToDocument(document, FoldingThemes.BUILTIN_THEMES.find(theme => theme.id === "${theme}")); foldProbe.waitForPaint()`)
    await check(`document.body.dataset.themeId === "${theme}" && ${block}.title && ${block}.getAttribute("aria-label") && ${block}.querySelector("svg")`,
      `${theme} 主题中整块入口使用带说明的图标`)
    await click(block)
    await check(`${collapsedBlock} && !${sentinel} && ${block}.closest(".cm-line").querySelector(".code-copy-btn") && foldProbe.visible("正文仍然可见")`,
      `${theme} 主题中整块折叠保留语言、复制入口和后续正文`)
    await evaluate('foldProbe.view().focus()')
    // CodeMirror 在 Esc 后暂时让 Tab 按浏览器顺序移动焦点。
    await key('Escape', 27)
    await key('Tab', 9)
    await check(`document.activeElement === ${block}`, `${theme} 主题中可用键盘移到折叠入口`)
    await key('Enter', 13)
    const keyboardResult = await evaluate(`({ expanded: foldProbe.expanded("block", "json"), visible: ${sentinel},
      focus: document.activeElement === ${block}, activeClass: document.activeElement?.className })`)
    assert(keyboardResult.expanded === 'true' && keyboardResult.visible && keyboardResult.focus,
      `${theme} 主题中键盘展开后焦点仍停在同一入口：${JSON.stringify(keyboardResult)}`)
    console.log(`通过：${theme} 主题中键盘展开后焦点仍停在同一入口`)
  }

  await click(item)
  await check(`!${sentinel} && foldProbe.visible("outsideFold")`, '折叠 JSON 数组时保留同级字段')
  await click(outer)
  await check('!foldProbe.visible("outsideFold")', '可以继续折叠包含数组的外层对象')
  await click(outer)
  await check(`foldProbe.visible("outsideFold") && !${sentinel} && ${item}.getAttribute("aria-expanded") === "false"`,
    '展开外层对象后保留数组的折叠状态')
  await check(`foldProbe.button("block", "text") && foldProbe.buttons("section").every(button => !button.closest(".cm-line").textContent.includes("PlainFold"))`,
    '纯文本块提供整块入口')

  await click(block)
  const copy = await evaluate('foldProbe.copySelection()')
  assert.equal(copy.text, fixture, '跨折叠区域复制应获得完整原文')
  assert(!copy.html || copy.html.includes('HiddenFoldMarker'), '富文本剪贴板不能省略隐藏代码')
  await check(collapsedBlock, '复制选区后保持代码块折叠')
  await evaluate(`Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async text => { window.foldCopied = text } })`)
  try {
    await click(`${block}.closest(".cm-line").querySelector(".code-copy-btn")`)
    await waitFor(`window.foldCopied === ${JSON.stringify(code)}`, '折叠时复制按钮没有提供完整代码')
    console.log('通过：折叠时复制按钮仍复制完整代码')
  } finally {
    await evaluate('delete navigator.clipboard.writeText; delete window.foldCopied')
  }

  const completeExport = `${sentinel} && window.__colamdExportDocumentHTML().includes("HiddenFoldMarker") && !${block}`
  try {
    await evaluate('window.__colamdPrintExport.enter()')
    await check(completeExport, '干净导出布局显示完整代码且去掉折叠控件')
  } finally {
    await evaluate('window.__colamdPrintExport.exit()')
  }
  await check(`${collapsedBlock} && !${sentinel}`, '干净导出结束恢复原来的折叠状态')
  try {
    await evaluate('window.__colamdSlidesExport.enter()')
    await check(completeExport, '幻灯片打印分页时能看到完整代码')
    try {
      await evaluate('window.__colamdPrintExport.enter()')
      await check(completeExport, '幻灯片进入打印布局后仍保留完整代码')
    } finally {
      await evaluate('window.__colamdPrintExport.exit()')
    }
    await check(completeExport, '退出打印布局时幻灯片仍保持展开')
  } finally {
    await evaluate('window.__colamdSlidesExport.exit()')
  }
  await check(`${collapsedBlock} && !${sentinel}`, '幻灯片导出结束恢复原来的折叠状态')

  const searchModifier = process.platform === 'darwin' ? 4 : 2
  await key('f', 70, 'KeyF', searchModifier)
  await waitFor('document.activeElement?.matches(".search-panel > .search-input")', '没有打开查找面板')
  await evaluate(`(() => {
    const input = document.activeElement
    input.value = "HiddenFoldMarker"
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  await waitFor(`document.querySelector(".search-match-current")?.textContent === "HiddenFoldMarker" && ${sentinel}`, '查找没有展开命中内容所在的各层')
  await key('Escape', 27)
  console.log('通过：查找展开命中内容所在的各层')

  await click(block)
  await evaluate('document.getElementById("source-toggle-btn").click()')
  await check(`document.getElementById("source-editor").classList.contains("visible") && document.getElementById("source-editor").value === ${JSON.stringify(fixture)}`,
    '源码模式显示包含折叠内容的完整原文')
  await evaluate('document.getElementById("source-toggle-btn").click()')
  await waitFor(`foldProbe.expanded("block", "json") === "true" && ${sentinel}`, '切回渲染后应展开代码块')
  console.log('通过：切回渲染后展开代码块')

  await click(block)
  const toggle = 'document.getElementById("left-sidebar-toggle")'
  const fileButton = `[...document.querySelectorAll(".file-list button[data-kind=file]")].find(button => button.dataset.path === ${JSON.stringify(files[1])})`
  await evaluate(`if (!(${fileButton})) ${toggle}?.click()`)
  await waitFor(`!!(${fileButton})`, '文件列表未显示相同正文的第二个文件')
  await evaluate(`(${fileButton}).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }))`)
  await waitFor(`foldProbe.activeTab() === ${JSON.stringify(files[1])} && ${sentinel}`, '同样内容的新标签不应继承折叠')
  const tab = file => `[...document.querySelectorAll(".tab-entry")].find(tab => tab.dataset.filePath === ${JSON.stringify(file)})`
  await evaluate(`${tab(files[0])}.click()`)
  await waitFor(`foldProbe.activeTab() === ${JSON.stringify(files[0])} && ${collapsedBlock}`, '切回原标签没有恢复折叠')
  console.log('通过：相同正文的两个标签分别保留折叠状态')

  try {
    await evaluate('window.__colamdPrintExport.enter()')
    await check(completeExport, '切换标签前，打印布局已经展开折叠')
    await click(tab(files[1]))
    await waitFor(`foldProbe.activeTab() === ${JSON.stringify(files[1])}`, '打印期间无法切换标签')
  } finally {
    await evaluate('window.__colamdPrintExport.exit()')
  }
  await click(tab(files[0]))
  await waitFor(`foldProbe.activeTab() === ${JSON.stringify(files[0])} && ${collapsedBlock} && !${sentinel}`, '返回原标签后应恢复折叠')
  console.log('通过：打印期间切换标签，退出后返回原标签仍保持折叠')

  await evaluate(`(() => {
    const editor = foldProbe.view()
    const fence = editor.state.doc.line(3)
    editor.dispatch({ selection: { anchor: fence.to } })
    editor.focus()
  })()`)
  await key('Delete', 46)
  await check(`foldProbe.view().state.doc.toString() === ${JSON.stringify(fixture)} && ${sentinel}`,
    '在折叠边界删除时先展开，保留隐藏内容')
  for (const [index, file] of files.entries()) {
    const { bytes, mtime } = originals[index]
    assert(readFileSync(file).equals(bytes) && statSync(file).mtimeMs === mtime, `折叠操作改变了磁盘文件 ${file}`)
  }
  console.log('通过：两份文件的字节和修改时间保持不变')
} finally {
  cleanup()
}
