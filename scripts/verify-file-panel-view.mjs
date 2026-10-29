#!/usr/bin/env node
// 在离屏 Electron 的真实侧栏样式中验证大目录 DOM、滚动、焦点和事件委托。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { udd } = verifyWorkdir('file-panel-view')
const port = 28700 + Math.floor(Math.random() * 200)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const bundle = await build({ entryPoints: ['src/renderer/file-panel-view.ts'], bundle: true, write: false,
  platform: 'browser', format: 'iife', globalName: 'FilePanelModule', logLevel: 'silent' })
let child, socket
let nextId = 0
const pending = new Map()

// 调试请求失败和超时都使验收失败。
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`调试超时：${method}`)) }, 20000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

// 页面异常必须向上传递，不能把未完成动作当成成功。
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 等待实际 DOM 状态，避免依赖隐藏窗口的固定帧间隔。
async function waitFor(expression, message) {
  for (let i = 0; i < 120; i++) {
    if (await evaluate(expression)) return
    await pause(100)
  }
  throw new Error(message)
}

// 用真实键盘派发验证原生焦点顺序与自定义跨范围交接。
async function tab(backward = false) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: backward ? 8 : 0 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: backward ? 8 : 0 })
}

try {
  child = spawn(require('electron'), ['scripts/offscreen-window.cjs', `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  { cwd: root, env, stdio: 'ignore' })
  let target
  for (let i = 0; i < 160 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page') } catch {}
    if (!target) await pause(100)
  }
  assert(target, '未找到页面')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('页面调试连接提前关闭')) }
    pending.clear()
  })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor("!!document.querySelector('#editor .cm-content')", '编辑器未就绪')
  await evaluate(bundle.outputFiles[0].text)
  await evaluate(`(() => {
    window.panels = ['left', 'right'].map(side => {
      const panel = document.createElement('aside')
      panel.className = 'sidebar'
      panel.id = 'test-' + side + '-sidebar'
      panel.setAttribute('aria-hidden', 'false')
      Object.assign(panel.style, { width: '220px', height: '500px', top: '80px', bottom: 'auto', opacity: '1',
        pointerEvents: 'auto', transform: 'none', [side]: '0px' })
      const before = document.createElement('button'); before.textContent = 'before'; before.className = 'test-before'
      const list = document.createElement('ul'); list.className = 'file-list'
      const after = document.createElement('button'); after.textContent = 'after'; after.className = 'test-after'
      before.style.flexShrink = after.style.flexShrink = '0'
      panel.append(before, list, after); document.body.append(panel)
      return panel
    })
    window.lists = panels.map(panel => panel.querySelector('.file-list'))
    window.rows = Array.from({ length: 10000 }, (_, index) => ({ file: { path: '/fixture/' + index + '.md',
      name: index + '.md', kind: 'file' }, depth: 0, expandable: false, expanded: false, empty: false }))
    rows.unshift({ ...rows[0], file: { path: '/', name: '..', kind: 'parent' } })
    rows.splice(4, 0, { ...rows[3], empty: true })
    rows.splice(6, 0, { ...rows[5], file: { path: '/deep', name: 'deep', kind: 'directory' }, empty: true, depth: 10 })
    window.fileView = new FilePanelModule.FilePanelView(() => {}, () => {})
    window.renderFiles = () => fileView.render(lists, rows, '/fixture/5000.md', 'zh')
    window.events = []
    for (const list of lists) for (const type of ['click', 'contextmenu']) list.addEventListener(type,
      event => { const path = event.target.closest('button')?.dataset.path; if (path) events.push({ type, path }) })
    renderFiles()
    return true
  })()`)
  const initial = await evaluate("lists.map(list => ({ elements: list.querySelectorAll('*').length, buttons: list.querySelectorAll('button').length, height: list.offsetHeight }))")
  assert(initial.every(result => result.elements < 1000 && result.buttons < 120), JSON.stringify(initial))
  assert(initial.every(result => result.height > 250000), '完整列表的滚动高度必须保留')
  console.log('通过：两侧一万条目均只挂载视口附近节点，完整滚动范围保留')

  await evaluate('panels[0].scrollTop = panels[0].scrollHeight; true')
  await waitFor("[...lists[0].querySelectorAll('button')].some(button => button.dataset.path === '/fixture/9998.md')", '底部范围未挂载')
  assert.equal(await evaluate('panels[1].scrollTop'), 0, '两侧独立滚动')
  await evaluate("lists[0].querySelector('button[data-path=\"/fixture/9999.md\"]').click(); lists[0].querySelector('button[data-path=\"/fixture/9999.md\"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); true")
  assert.deepEqual(await evaluate('events'), [{ type: 'click', path: '/fixture/9999.md' }, { type: 'contextmenu', path: '/fixture/9999.md' }])
  console.log('通过：滚到最后仍能点击和右键最后一个文件，两侧滚动互不影响')

  await evaluate("panels[0].scrollTop = 0; lists[0].querySelector('button[data-path=\"/\"]').focus(); true")
  await waitFor("!!lists[0].querySelector('button[data-path=\"/fixture/0.md\"]')", '顶部范围未恢复')
  const boundary = await evaluate(`(() => {
    const buttons = [...lists[0].querySelectorAll('button')].filter(button => button.dataset.path !== '/fixture/9999.md')
    const button = buttons.at(-1); button.focus({ preventScroll: true }); return Number(button.dataset.path.split('/').at(-1).slice(0, -3))
  })()`)
  await tab()
  assert.equal(await evaluate('document.activeElement.dataset.path'), '/fixture/' + (boundary + 1) + '.md')
  await tab(true)
  assert.equal(await evaluate('document.activeElement.dataset.path'), '/fixture/' + boundary + '.md')
  await evaluate('panels[0].scrollTop = panels[0].scrollHeight; true')
  await waitFor("!!lists[0].querySelector('button[data-path=\"/fixture/9998.md\"]')", '鼠标滚动后末尾范围未更新')
  assert.equal(await evaluate('document.activeElement.dataset.path'), '/fixture/' + boundary + '.md', '滚出视口的焦点节点必须保留')
  await tab()
  assert.equal(await evaluate('document.activeElement.dataset.path'), '/fixture/' + (boundary + 1) + '.md')
  console.log('通过：Tab 和 Shift+Tab 跨挂载边界，鼠标滚动后继续操作原焦点')

  const reordered = await evaluate(`(() => {
    const focused = document.activeElement
    const index = rows.findIndex(row => row.file.path === focused.dataset.path)
    const [moved] = rows.splice(index, 1); rows.splice(index + 2, 0, moved); renderFiles()
    return document.activeElement === focused
  })()`)
  assert(reordered, '刷新重新排序必须保留同一文件按钮的焦点')

  await evaluate("rows = rows.filter(row => row.file.path !== document.activeElement.dataset.path); renderFiles(); true")
  assert(await evaluate("document.activeElement.matches('.file-list button')"), '删除焦点条目后应回到相邻文件')
  await evaluate("lists[0].querySelector('button[data-path=\"/fixture/9999.md\"]').focus(); true")
  await tab()
  assert(await evaluate("document.activeElement === panels[0].querySelector('.test-after')"), '最后一个文件的 Tab 应离开列表')
  await tab(true)
  assert.equal(await evaluate('document.activeElement.dataset.path'), '/fixture/9999.md', '反向进入列表应落到最后一个文件')
  await evaluate("lists[0].querySelector('button[data-path=\"/\"]').focus(); true")
  await tab(true)
  assert(await evaluate("document.activeElement === panels[0].querySelector('.test-before')"), '第一个文件的 Shift+Tab 应离开列表')
  console.log('通过：删除焦点条目有落点，原生 Tab 可从列表两端进入和离开')

  const geometry = await evaluate(`(() => {
    const native = document.createElement('ul'); native.className = 'file-list'; panels[1].append(native)
    const small = new FilePanelModule.FilePanelView(() => {}, () => {})
    small.render([native], rows.slice(0, 8), null, 'zh')
    const top = native.getBoundingClientRect().top
    const expected = [...native.children].map(entry => entry.getBoundingClientRect().top - top)
    panels[1].scrollTop = 0; renderFiles()
    const actual = [...lists[1].children].slice(0, 8).map(entry => parseFloat(entry.style.top))
    small.dispose(); native.remove()
    return { expected, actual }
  })()`)
  assert.equal(geometry.actual.length, geometry.expected.length)
  geometry.expected.forEach((top, index) => assert(Math.abs(top - geometry.actual[index]) < 0.1, JSON.stringify(geometry)))
  const previousHeight = await evaluate('lists[1].offsetHeight')
  await evaluate(`(() => {
    window.rowStyle = document.createElement('style')
    rowStyle.textContent = '.sidebar[id^="test-"] .file-list button { padding-top: 9px; padding-bottom: 9px; }'
    document.head.append(rowStyle); return true
  })()`)
  await waitFor(`lists[1].offsetHeight > ${previousHeight + 50000}`, '仅行内边距变化时几何未失效')
  await evaluate('rowStyle.remove(); true')
  await waitFor(`Math.abs(lists[1].offsetHeight - ${previousHeight}) < 2`, '主题样式恢复后几何未恢复')
  await evaluate("panels[1].style.height = '260px'; panels[1].style.width = '300px'; true")
  await pause(1200)
  assert(await evaluate('lists[1].querySelectorAll("button").length < 80'), '缩放后挂载范围应随视口缩小')
  await evaluate("panels[1].style.width = '180px'; fileView.render(lists, rows, null, 'en'); true")
  await waitFor(`(() => {
    const index = rows.findIndex(row => row.empty && row.depth === 10)
    const entry = lists[1].querySelector('[aria-posinset="' + (index + 1) + '"]')
    const next = lists[1].querySelector('[aria-posinset="' + (index + 2) + '"]')
    return entry && next && next.getBoundingClientRect().top >= entry.getBoundingClientRect().bottom
  })()`, '窄栏或语言切换后深层空目录提示与下一行重叠')
  await evaluate('lists[1].hidden = true; true')
  assert.equal(await evaluate('getComputedStyle(lists[1]).display'), 'none', '切换大纲时虚拟文件列表仍必须隐藏')
  await evaluate('lists[1].hidden = false; rows = rows.slice(0, 8); renderFiles(); true')
  assert(await evaluate("lists.every(list => !list.classList.contains('file-list-virtual') && list.style.height === '' && list.children.length === rows.length)"), '切回小目录清除虚拟布局')
  await evaluate('fileView.dispose(); panels.forEach(panel => panel.remove()); true')
  console.log('通过：普通、返回和空目录行几何一致，调整尺寸、内容显隐和大目录转小目录正常')
} finally {
  socket?.close()
  stopVerifyApp(udd)
  child?.kill()
}
