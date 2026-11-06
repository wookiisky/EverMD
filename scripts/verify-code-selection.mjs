// 先 npm run build，再 node scripts/verify-code-selection.mjs [--theme light]。
// 使用真实离屏 Electron，在文字内部逐点比较选中与未选中的截图。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'evermd-code-selection-'))
const udd = join(dir, 'udd-main'), home = join(dir, 'home'), file = join(dir, '选区.md')
mkdirSync(home)
const longInline = `WrappedInlineStart ${'payload '.repeat(30)} WrappedInlineEnd`
const fixture = [
  '正文选择反馈。', '', '```ts', 'interface InputEnvelope { payload: string }', '```', '',
  '> ```ts', '> type QuoteEnvelope = { value: number }', '> ```', '',
  '```text', 'wrapped_payload '.repeat(35) + 'LongEnvelope', '```', '',
  '正文与行内 `InlineEnvelope` 继续正文，另一个 `InputEnvelope`。', '',
  `长行内代码：\`${longInline}\`。`, ''
].join('\n')
writeFileSync(file, fixture)
const original = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs }
const env = { ...process.env, EVERMD_STARTUP_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
const port = 29500 + Math.floor(Math.random() * 200)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, renderer, passed = 0

// 每个调试请求有期限，断连时拒绝所有未完成请求。
async function connect() {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json())
        .find(item => item.type === 'page')
    } catch { /* 等待调试端口就绪。 */ }
    if (!target) await pause(100)
  }
  assert(target, '未找到页面调试目标')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('调试连接超时')), 10000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = pending.get(response.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(response.id)
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('调试连接提前关闭')) }
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
    close: () => ws.close()
  }
}

// 页面异常必须使验收失败。
async function evaluate(expression) {
  const result = await renderer.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 按实际状态等待，不把固定延时当作成功。
async function waitFor(expression, message) {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await pause(50) }
  throw new Error(message)
}

// 每项输出都对应已执行的断言。
function check(name, value) { assert(value, name); passed++; console.log(`通过：${name}`) }

// 运行在真实页面中，采样只取目标文字内部，不把选区两侧露出的色带当作成功。
function installProbe() {
  const v = document.querySelector('#editor .cm-content').cmTile.root.view
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame) }
  const range = text => { const anchor = v.state.doc.toString().indexOf(text); if (anchor < 0) throw new Error('缺少夹具文字'); return { anchor, head: anchor + text.length } }
  async function place(text, collapsed = false) {
    const selection = range(text)
    v.dispatch({ selection: { anchor: selection.anchor, head: collapsed ? selection.anchor : selection.head }, scrollIntoView: true })
    v.focus()
    await settle()
    return selection
  }
  function inspect(text) {
    const selected = v.state.selection.main, target = range(text)
    if (selected.from !== target.anchor || selected.to !== target.head) throw new Error('实际选区与目标不符')
    const sample = text.includes('InlineEnvelope') ? v.state.doc.toString().indexOf('InlineEnvelope') : selected.from
    const caret = v.coordsAtPos(sample + 1)
    if (!caret) throw new Error('选中文字没有屏幕坐标')
    const node = v.domAtPos(sample + 1).node
    const line = (node.nodeType === 1 ? node : node.parentElement).closest('.cm-line')
    const offsets = text.startsWith('WrappedInlineStart') ? [2, Math.floor(text.length / 2), text.length - 3] : [2, 5, 8]
    const rects = offsets.map(offset => v.coordsAtPos(sample + Math.min(offset, text.length - 1)))
    const points = rects.flatMap(r => {
      return [{ x: Math.floor(r.left + 1), y: Math.ceil(r.top + 1) }, { x: Math.floor(r.left + 1), y: Math.floor(r.bottom - 1) }]
    })
    return { points, rows: new Set(rects.map(r => Math.round(r.top))).size, line: line.className,
      wrapped: line.getBoundingClientRect().height > parseFloat(getComputedStyle(line).lineHeight) * 2 }
  }
  function copy() {
    const before = JSON.stringify(v.state.selection.toJSON()), source = v.state.doc.toString(), data = new DataTransfer()
    v.contentDOM.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
    return { text: data.getData('text/plain'), unchanged: source === v.state.doc.toString() && before === JSON.stringify(v.state.selection.toJSON()) }
  }
  window.selectionProbe = { v, settle, range, place, inspect, copy }
}

// 截图失败直接失败；对每个内部字符分别要求上沿或下沿出现可辨的颜色变化。
async function expectPixels(text, name) {
  const probe = await evaluate(`selectionProbe.inspect(${JSON.stringify(text)})`)
  const selected = (await renderer.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data
  let clear
  // 保留原生及编辑器选区，只隐藏绘制；失焦时 CM 不会同步程序化清空的选区。
  try {
    await evaluate(`(() => {
      const style = document.createElement('style'); style.id = 'selection-pixel-baseline'
      style.textContent = 'body:not(.exporting) #editor .cm-content ::selection {background:transparent !important} #editor .cm-selectionBackground {visibility:hidden !important}'
      document.head.appendChild(style); return selectionProbe.settle()
    })()`)
    clear = (await renderer.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data
  } finally { await evaluate('document.getElementById("selection-pixel-baseline")?.remove(); selectionProbe.settle()') }
  const differences = await evaluate(`(async () => {
    const points = ${JSON.stringify(probe.points)}, images = ${JSON.stringify([selected, clear])}
    const pixels = await Promise.all(images.map(async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
      return points.map(p => [...context.getImageData(p.x, p.y, 1, 1).data])
    }))
    return points.map((_,i) => Math.max(...pixels[0][i].slice(0,3).map((v,c) => Math.abs(v-pixels[1][i][c]))))
  })()`)
  check(`${name}：文字内部显示选区，像素差=${differences}`, [0, 2, 4].every(i => Math.max(differences[i], differences[i + 1]) >= 6))
  return probe
}

// 只关闭本脚本创建的进程和临时目录，避免干扰其他验收。
function cleanup() {
  renderer?.close()
  if (child && child.exitCode === null) child.kill('SIGTERM')
  stopVerifyApp(udd)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(1) })

try {
  const bundle = await build({ stdin: { contents: "export {applyThemeToDocument} from './src/renderer/themes/theme-document'; export {BUILTIN_THEMES} from './src/shared/theme-definition'", resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SelectionThemes', logLevel: 'silent' })
  child = spawn(require('electron'), ['scripts/offscreen-window.cjs', file, `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect()
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false })
  await waitFor(`document.querySelector('#editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(fixture)}`, '夹具未加载')
  await evaluate(bundle.outputFiles[0].text)
  await evaluate(`(${installProbe.toString()})()`)
  await evaluate('document.fonts.ready')
  const themeIndex = process.argv.indexOf('--theme'), requested = themeIndex < 0 ? null : process.argv[themeIndex + 1]
  assert(themeIndex < 0 || requested, '--theme 缺少主题 id')
  const themes = await evaluate('SelectionThemes.BUILTIN_THEMES.map(theme => theme.id)')
  assert(!requested || themes.includes(requested), `未知主题：${requested}`)
  for (const theme of requested ? [requested] : process.argv.includes('--all-themes') ? themes : ['elegant', 'light', 'dark', 'bear']) {
    await evaluate(`SelectionThemes.applyThemeToDocument(document, SelectionThemes.BUILTIN_THEMES.find(theme => theme.id === ${JSON.stringify(theme)})); selectionProbe.settle()`)
    check(`${theme}：实际主题样式已加载`, await evaluate(`document.body.dataset.themeId === ${JSON.stringify(theme)} && !!document.getElementById('colamd-active-theme')`))
    for (const text of ['正文选择反馈', 'InputEnvelope', 'QuoteEnvelope', 'LongEnvelope', 'InlineEnvelope', '正文与行内 `InlineEnvelope` 继续正文', longInline]) {
      await evaluate(`selectionProbe.place(${JSON.stringify(text)})`)
      const result = await expectPixels(text, `${theme}/${text}`)
      if (text === 'LongEnvelope') check(`${theme}：长代码行确实软换行`, result.wrapped)
      if (text === longInline) check(`${theme}：长行内代码在至少两行内部取样`, result.rows >= 2)
      const copied = await evaluate('selectionProbe.copy()')
      check(`${theme}/${text}：复制原文且不改选区或文档`, copied.text === text && copied.unchanged)
    }
    const token = 'InlineEnvelope'
    await evaluate(`selectionProbe.place(${JSON.stringify(token)}, true)`)
    for (let i = 0; i < token.length; i++) {
      await renderer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8 })
      await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8 })
    }
    await evaluate('selectionProbe.settle()')
    await expectPixels(token, `${theme}：键盘选择`)
    const points = await evaluate(`(() => {const p=selectionProbe.range(${JSON.stringify(token)});return [p.anchor,p.head].map(pos=>{const r=selectionProbe.v.coordsAtPos(pos);return {x:r.left,y:(r.top+r.bottom)/2}})})()`)
    await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...points[0] })
    await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...points[1] })
    await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...points[1] })
    await evaluate('selectionProbe.settle()')
    await expectPixels(token, `${theme}：鼠标选择`)
    await evaluate('selectionProbe.v.contentDOM.blur(); selectionProbe.settle()')
    check(`${theme}：编辑器已失焦`, await evaluate('!selectionProbe.v.hasFocus'))
    await expectPixels(token, `${theme}：失焦选择`)
    await evaluate('document.body.classList.add("exporting")')
    check(`${theme}：导出时原生选区透明`, await evaluate('getComputedStyle(document.querySelector(".cm-md-inlinecode"),"::selection").backgroundColor === "rgba(0, 0, 0, 0)"'))
    await evaluate('document.body.classList.remove("exporting")')
    await renderer.send('Emulation.setEmulatedMedia', { media: 'print' })
    check(`${theme}：打印时原生选区透明`, await evaluate('getComputedStyle(document.querySelector(".cm-md-inlinecode"),"::selection").backgroundColor === "rgba(0, 0, 0, 0)"'))
    await renderer.send('Emulation.setEmulatedMedia', { media: 'screen' })
    check(`${theme}：编辑器文档保持原字节`, await evaluate('selectionProbe.v.state.doc.toString()') === fixture)
  }
  check('磁盘文件字节与修改时间不变', readFileSync(file).equals(original.bytes) && statSync(file).mtimeMs === original.mtime)
  console.log(`代码选区验收通过，共 ${passed} 项。`)
} finally { cleanup() }
