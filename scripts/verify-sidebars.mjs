#!/usr/bin/env node
// 左右侧栏的真实 Electron 验收；先构建，窗口始终离屏且不抢焦点。
// --screenshots 额外保存主题截图；部分 macOS 隐藏窗口不能完成截图，功能断言不依赖它。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { dir, udd } = verifyWorkdir('sidebars')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const preference = 'colamd-sidebars'
const prefs = `JSON.parse(localStorage.getItem('${preference}'))`
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const fixture = '# 侧栏验收\n\n```sh\n# 不该进入大纲\n```\n\n' +
  Array.from({ length: 30 }, (_, i) => `## 章节 ${i + 1}\n\n${'正文内容。'.repeat(25)}\n\n`).join('')
const second = '# 第二个文档\r\n\r\n保留原始行尾。\r\n'
const files = [join(dir, '侧栏.md'), join(dir, '第二个文档.md')]
writeFileSync(files[0], fixture)
writeFileSync(files[1], second)
const original = files.map(file => ({ bytes: readFileSync(file), mtime: statSync(file).mtimeMs }))
const port = 22700 + Math.floor(Math.random() * 200)
const inspectPort = port + 1000
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child, renderer, main, passed = 0

// 调试目标提前关闭或请求超时都必须明确失败。
async function connect(portNumber, type) {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json()).find(item => item.type === type)
    } catch { /* 进程尚未开始监听。 */ }
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

// 只返回可序列化结果，页面异常不可当成 undefined 继续验收。
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true
  })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 等可观察状态，不把某一帧的动画中间值误判成最终布局。
async function waitFor(expression, message, client = renderer) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(client, expression)) return
    await pause(100)
  }
  throw new Error(message)
}

// 每条断言都说明用户能观察到的行为。
function check(name, ok, detail = '') {
  assert(ok, detail ? `${name}；${detail}` : name)
  passed++
  console.log(`通过：${name}`)
}

// 通过原生菜单的点击路径覆盖菜单、IPC 与页面接线。
async function clickMenu(id) {
  await evaluate(main, `(() => {
    const { Menu, BrowserWindow } = require('electron')
    const item = Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)})
    if (!item) throw new Error('菜单不存在：' + ${JSON.stringify(id)})
    item.click(item, BrowserWindow.getAllWindows()[0])
  })()`)
  await pause(100)
}

// 显隐以持久化状态为准，避免闭合动画尚未结束时再按一次。
async function setVisible(side, visible) {
  if (await evaluate(renderer, `${prefs}.${side}.visible`) !== visible) await clickMenu(`sidebar-${side}-visible`)
  await waitFor(`${prefs}.${side}.visible === ${visible}`, `${side} 侧栏显隐未更新`)
  await waitFor(`document.getElementById('${side}-sidebar').hidden === ${!visible}`, `${side} 侧栏显隐动画未完成`)
  await pause(240)
}

// 内容选择无需自动开启侧栏，保留各侧自己的显隐偏好。
async function setContent(side, content) {
  await clickMenu(`sidebar-${side}-${content}`)
  await waitFor(`${prefs}.${side}.content === '${content}'`, `${side} 侧栏内容未更新`)
}

// 量真实几何，侧栏开启时正文必须在剩余空间内居中。
async function geometry() {
  await pause(240)
  return evaluate(renderer, `(() => {
    const state = ${prefs}
    const rect = id => document.getElementById(id).getBoundingClientRect()
    const left = state.left.visible ? rect('left-sidebar').right : 0
    const right = state.right.visible ? rect('right-sidebar').left : innerWidth
    const editor = rect('editor-region')
    const content = document.querySelector('#editor .cm-content').getBoundingClientRect()
    const scroller = document.querySelector('#editor .cm-scroller')
    const readingLeft = scroller.getBoundingClientRect().left + scroller.clientLeft
    return { left, right, regionLeft: editor.left, regionRight: editor.right,
      readingLeft, readingRight: readingLeft + scroller.clientWidth,
      contentLeft: content.left, contentRight: content.right, width: editor.width }
  })()`)
}

// 真实指针按下、移动、抬起，覆盖捕获和持久化，而非直接改 CSS 变量。
async function drag(side, width) {
  const box = await evaluate(renderer, `(() => {
    const rect = document.getElementById('${side}-sidebar-resizer').getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const distance = ${width} - ${prefs}.${side}.width
    return { x: rect.left + rect.width / 2, y: rect.top + 70,
      target: x + ('${side}' === 'left' ? distance : -distance) }
  })()`)
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.target, y: box.y, button: 'left', buttons: 1 })
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.target, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
  await waitFor(`Math.abs(${prefs}.${side}.width - ${width}) <= 1`, `${side} 拖宽没有保存`)
}

// 先在所属侧栏内把目标移到可点击处，再以真实指针点击，避免 scrollIntoView 干扰正文。
async function clickOutline(side, index) {
  const point = await evaluate(renderer, `(() => {
    const panel = document.getElementById('${side}-sidebar')
    const button = panel.querySelectorAll('.outline-list button')[${index}]
    panel.scrollTop += button.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientHeight / 2
    const rect = button.getBoundingClientRect()
    return { x: rect.left + Math.min(40, rect.width / 2), y: rect.top + rect.height / 2 }
  })()`)
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
}

// 页面重载也必须重新取得编辑器，不能只看到持久化项存在就当恢复成功。
async function reload() {
  await renderer.send('Page.reload')
  // reload 返回时旧执行上下文可能仍存在，先等导航提交再读取新模块的状态。
  await pause(600)
  await waitFor(`${view} && document.getElementById('left-sidebar') && ${prefs}`, '重载后页面未就绪')
  await pause(300)
}

// 通过统一离屏壳启动，保持用户机器上的前台窗口和菜单不受影响。
async function launch() {
  child = spawn(require('electron'), [
    'scripts/offscreen-window.cjs', files[0], `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'
  ], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(fixture)}`, '测试文档未载入')
}

// 正常退出后复用同一个 profile，证明偏好跨进程保存。
async function closeApp() {
  const exited = new Promise(resolve => child.once('exit', resolve))
  await evaluate(main, "(() => { const app = require('electron').app; setImmediate(() => app.quit()); return true })()")
  renderer.close(); main.close()
  renderer = main = null
  await Promise.race([exited, pause(10000).then(() => { throw new Error('测试应用未正常退出') })])
  child = null
}

try {
  await launch()
  check('左右侧栏及各自开关已经挂载', await evaluate(renderer,
    "['left-sidebar','right-sidebar','left-sidebar-toggle','right-sidebar-toggle'].every(id => !!document.getElementById(id))"))
  check('默认左文件右大纲且均隐藏', await evaluate(renderer,
    `${prefs}.left.content === 'files' && ${prefs}.right.content === 'outline' && !${prefs}.left.visible && !${prefs}.right.visible`))
  check('左右菜单保留各自快捷键并移除旧位置选项', await evaluate(main, `(() => {
    const menu = require('electron').Menu.getApplicationMenu()
    return menu.getMenuItemById('sidebar-left-visible').accelerator === 'CmdOrCtrl+\\\\' &&
      menu.getMenuItemById('sidebar-right-visible').accelerator === 'CmdOrCtrl+Shift+\\\\' &&
      !menu.getMenuItemById('panel-side-left')
  })()`))
  // CDP 修饰键位：Alt=1、Ctrl=2、Meta=4、Shift=8，不能用 DOM 的键码作位值。
  const shortcutModifier = await evaluate(renderer, "/^Mac/i.test(navigator.platform) ? 4 : 2")
  await evaluate(renderer, `(() => {
    window.sidebarKeyEvents = []
    window.addEventListener('keydown', event => window.sidebarKeyEvents.push({ key: event.key, code: event.code, shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey }), true)
    window.electronAPI.onToggleSidebar(side => window.sidebarKeyEvents.push({ menuSide: side }))
  })()`)
  for (const side of ['left', 'right']) {
    const modifiers = shortcutModifier + (side === 'right' ? 8 : 0)
    const key = side === 'left' ? '\\' : '|'
    const opposite = side === 'left' ? 'right' : 'left'
    for (const visible of [true, false]) {
      await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: 'Backslash', windowsVirtualKeyCode: 220, modifiers })
      await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'Backslash', windowsVirtualKeyCode: 220, modifiers })
      await pause(200)
      check(`${side === 'left' ? '左' : '右'}侧快捷键只切换对应侧一次（${visible ? '打开' : '关闭'}）`, await evaluate(renderer,
        `${prefs}.${side}.visible === ${visible} && !${prefs}.${opposite}.visible`), await evaluate(renderer,
          `JSON.stringify({ preferences: ${prefs}, events: window.sidebarKeyEvents })`))
    }
  }

  for (const [left, right] of [[false, false], [true, false], [false, true], [true, true]]) {
    await setVisible('left', left)
    await setVisible('right', right)
    const m = await geometry()
    check(`左${left ? '开' : '关'}右${right ? '开' : '关'}时正文避开侧栏并居中`,
      Math.abs(m.regionLeft - m.left) <= 1 && Math.abs(m.regionRight - m.right) <= 1 &&
      m.contentLeft >= m.readingLeft - 1 && m.contentRight <= m.readingRight + 1 &&
      Math.abs((m.contentLeft - m.readingLeft) - (m.readingRight - m.contentRight)) <= 2, JSON.stringify(m))
  }
  await waitFor("document.querySelectorAll('#right-sidebar .outline-list button').length === 31", '大纲缺少真实标题或包含代码块注释')
  check('文件与大纲同时可读', await evaluate(renderer,
    "document.querySelectorAll('#left-sidebar .file-list button').length >= 2 && !document.querySelector('#left-sidebar .file-list').hidden && !document.querySelector('#right-sidebar .outline-list').hidden"))
  await evaluate(renderer, "(() => { const button = document.querySelector('#left-sidebar .file-list button'); button.dataset.focusProbe = 'files'; button.focus() })()")
  await setVisible('right', false)
  await setVisible('right', true)
  check('开关右栏保留左侧文件条目的焦点和DOM', await evaluate(renderer,
    "document.activeElement === document.querySelector('#left-sidebar .file-list button[data-focus-probe=files]')"))

  await setContent('left', 'outline')
  await waitFor("document.querySelectorAll('#left-sidebar .outline-list button').length === 31", '左大纲未渲染')
  check('两侧可同时配置为大纲', await evaluate(renderer,
    "!document.querySelector('#left-sidebar .outline-list').hidden && !document.querySelector('#right-sidebar .outline-list').hidden"))
  await evaluate(renderer, "(() => { const button = document.querySelector('#left-sidebar .outline-list button'); button.dataset.focusProbe = 'outline'; button.focus() })()")
  await setVisible('right', false)
  await setVisible('right', true)
  check('开关右栏保留左侧大纲条目的焦点和DOM', await evaluate(renderer,
    "document.activeElement === document.querySelector('#left-sidebar .outline-list button[data-focus-probe=outline]')"))
  const outerScroll = await evaluate(renderer, `JSON.stringify({
    window: [scrollX, scrollY], document: document.scrollingElement.scrollTop,
    editor: document.getElementById('editor').scrollTop,
    region: document.getElementById('editor-region').scrollTop,
    source: document.getElementById('source-editor').scrollTop
  })`)
  for (const [side, index] of [['left', 23], ['right', 8]]) {
    await clickOutline(side, index)
    await waitFor(`${view}.state.doc.lineAt(${view}.state.selection.main.head).text === '## 章节 ${index}'`, '渲染模式大纲点击未移动光标')
    await waitFor(`(() => {
      const view = ${view}
      const caret = view.coordsAtPos(view.state.selection.main.head)
      const viewport = view.scrollDOM.getBoundingClientRect()
      return caret && caret.top >= viewport.top - 1 && caret.bottom <= viewport.bottom + 1
    })()`, '大纲目标未进入正文视口')
    check(`点击${side === 'left' ? '左' : '右'}大纲后光标与视口均落在目标标题`, true)
    // 大纲的几何读取与滚动写入在下一帧合并，等待真实可见结果。
    await waitFor(`(() => {
      return ['left','right'].every(side => {
        const panel = document.getElementById(side + '-sidebar')
        const active = panel.querySelector('.outline-list button.active')
        if (!active || active.textContent !== '章节 ${index}') return false
        const item = active.getBoundingClientRect(), viewport = panel.getBoundingClientRect()
        return item.top >= viewport.top - 1 && item.bottom <= viewport.bottom + 1
      })
    })()`, '两侧大纲未同步高亮或未滚动到目标')
    check('两侧大纲同步高亮且各自在自己的滚动区显示目标', true)
  }
  // 等跳转锁自然释放，再手动滚动正文，验证监听接在真正的 .cm-scroller 上。
  await pause(1900)
  await evaluate(renderer, `(() => { const view = ${view}; view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight })()`)
  await waitFor("['left','right'].every(side => document.querySelector('#' + side + '-sidebar .outline-list button.active')?.textContent === '章节 30')", '滚动正文后两侧大纲未同步阅读进度')
  check('正文滚到底部时两侧大纲同步最后一节', true)
  check('大纲同步只滚动正文与所属侧栏，不滚动窗口或其他容器', await evaluate(renderer, `JSON.stringify({
    window: [scrollX, scrollY], document: document.scrollingElement.scrollTop,
    editor: document.getElementById('editor').scrollTop,
    region: document.getElementById('editor-region').scrollTop,
    source: document.getElementById('source-editor').scrollTop
  })`) === outerScroll)
  await setContent('right', 'files')
  await waitFor("document.querySelectorAll('#right-sidebar .file-list button').length >= 2", '右文件列表未渲染')
  check('文件与大纲可以交换左右位置', await evaluate(renderer,
    "document.getElementById('left-sidebar').dataset.content === 'outline' && document.getElementById('right-sidebar').dataset.content === 'files'"))
  await setContent('left', 'files')
  check('两侧可同时配置为文件列表', await evaluate(renderer,
    "!document.querySelector('#left-sidebar .file-list').hidden && !document.querySelector('#right-sidebar .file-list').hidden"))
  await setContent('right', 'outline')

  const rightWidth = await evaluate(renderer, `${prefs}.right.width`)
  await drag('left', 280)
  check('拖动左栏不改变右栏宽度', await evaluate(renderer, `${prefs}.right.width === ${rightWidth}`))
  await drag('right', 260)
  check('拖动右栏不改变左栏宽度', await evaluate(renderer, `${prefs}.left.width === 280`))
  const saved = await evaluate(renderer, `localStorage.getItem('${preference}')`)
  await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].setContentSize(600, 700)")
  const narrow = await geometry()
  check('窄窗口仍保留两栏和至少320px正文', narrow.width >= 319 && await evaluate(renderer,
    "!document.getElementById('left-sidebar').hidden && !document.getElementById('right-sidebar').hidden"))
  check('窄窗口缩宽不覆盖用户宽度偏好', await evaluate(renderer, `localStorage.getItem('${preference}') === ${JSON.stringify(saved)}`))
  const narrowLeftWidth = await evaluate(renderer, "document.getElementById('left-sidebar').getBoundingClientRect().width")
  await drag('left', 282)
  check('窄窗向外微拖不会反向缩小，也不覆盖另一侧偏好', await evaluate(renderer,
    `document.getElementById('left-sidebar').getBoundingClientRect().width >= ${narrowLeftWidth} && ${prefs}.right.width === 260`))
  await drag('left', 280)
  await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1200, 800)")
  await waitFor("Math.abs(document.getElementById('left-sidebar').getBoundingClientRect().width - 280) <= 1 && Math.abs(document.getElementById('right-sidebar').getBoundingClientRect().width - 260) <= 1", '窗口放大后未恢复两栏保存宽度')
  check('窗口放大后恢复两栏保存宽度', true)

  await evaluate(renderer, "document.querySelector('#right-sidebar .outline-list button').focus()")
  await setVisible('right', false)
  check('隐藏含焦点侧栏后焦点回到对应开关', await evaluate(renderer,
    "document.activeElement.id === 'right-sidebar-toggle' && document.getElementById('right-sidebar').hidden"))
  await evaluate(renderer, "for (let i = 0; i < 7; i++) document.getElementById('right-sidebar-toggle').click()")
  await pause(650)
  check('连续快速开关不会被旧动画再次隐藏', await evaluate(renderer,
    `${prefs}.right.visible && !document.getElementById('right-sidebar').hidden && document.getElementById('right-sidebar').getAttribute('aria-hidden') === 'false'`))
  await renderer.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await setVisible('left', false)
  check('减少动态效果时侧栏也能完整关闭', await evaluate(renderer, "document.getElementById('left-sidebar').hidden"))
  await setVisible('left', true)

  for (const theme of ['dark', 'light']) {
    await clickMenu(`theme-${theme}`)
    await waitFor(`document.body.classList.contains('theme-${theme}')`, '主题未切换')
    check(`${theme === 'dark' ? '深色' : '浅色'}主题中两栏继承背景和边缘线`, await evaluate(renderer, `(() => {
      const left = getComputedStyle(document.getElementById('left-sidebar'))
      const right = getComputedStyle(document.getElementById('right-sidebar'))
      return left.backgroundColor === right.backgroundColor && left.borderRightStyle === 'solid' && right.borderLeftStyle === 'solid'
    })()`))
    await evaluate(renderer, `(() => { const view = ${view}; view.scrollDOM.scrollTop = 0 })()`)
    await pause(200)
    if (process.argv.includes('--screenshots')) {
      const shot = await renderer.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(`/tmp/evermd-sidebars-${theme}.png`, Buffer.from(shot.data, 'base64'))
    }
  }
  const rendered = await geometry()
  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await waitFor("document.getElementById('source-editor').classList.contains('visible')", '未进入源码模式')
  const sourceGeometry = await geometry()
  check('源码与渲染模式共用正文可见区域', Math.abs(rendered.regionLeft - sourceGeometry.regionLeft) <= 1 && Math.abs(rendered.regionRight - sourceGeometry.regionRight) <= 1)
  check('大纲在源码模式也可跳到目标标题', await evaluate(renderer, `(() => {
    document.querySelectorAll('#right-sidebar .outline-list button')[20].click()
    const source = document.getElementById('source-editor')
    return source.value.slice(source.selectionStart, source.selectionEnd).includes('章节 20')
  })()`))
  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await waitFor("!document.getElementById('source-editor').classList.contains('visible')", '未回到渲染模式')

  await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('open-in-new-tab', ${JSON.stringify(files[1])})`)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`, '第二个标签未打开')
  await waitFor("document.querySelectorAll('#right-sidebar .outline-list button').length === 1", '切换文档后大纲未更新')
  check('切换标签更新大纲而不影响左右偏好', await evaluate(renderer,
    `${prefs}.left.content === 'files' && ${prefs}.right.content === 'outline' && ${prefs}.left.visible && ${prefs}.right.visible`))
  // 模式切换后的 CodeMirror 测量在后续帧提交，待正文就绪再启动演示。
  await pause(400)

  const beforePresentation = await evaluate(renderer, `localStorage.getItem('${preference}')`)
  await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].webContents.send('menu-play-slideshow')")
  await waitFor("document.body.classList.contains('presenting')", '演示未启动')
  const presentation = await evaluate(renderer, `({
    presenting: document.body.classList.contains('presenting'),
    displays: ['left-sidebar','right-sidebar','left-sidebar-resizer','right-sidebar-resizer'].map(id => getComputedStyle(document.getElementById(id)).display)
  })`)
  check('演示期间两侧栏及拖动边缘均隐藏', presentation.presenting && presentation.displays.every(display => display === 'none'), JSON.stringify(presentation))
  await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor("!document.body.classList.contains('presenting')", '演示未退出')
  check('退出演示恢复两栏且不改变内容、显隐与宽度偏好', await evaluate(renderer,
    `localStorage.getItem('${preference}') === ${JSON.stringify(beforePresentation)} && ['left','right'].every(side => !document.getElementById(side + '-sidebar').hidden && getComputedStyle(document.getElementById(side + '-sidebar')).display !== 'none')`))

  await pause(1200)
  check('两份打开文档的字节和mtime均不被视图操作改变', files.every((file, index) => readFileSync(file).equals(original[index].bytes) && statSync(file).mtimeMs === original[index].mtime))

  await setContent('left', 'outline')
  await setContent('right', 'files')
  const primaryPreferences = await evaluate(renderer, `localStorage.getItem('${preference}')`)
  const primaryWindowId = await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].id")
  await evaluate(main, `(() => {
    const { Menu, BrowserWindow } = require('electron')
    const flatten = menu => menu.items.flatMap(item => [item, ...(item.submenu ? flatten(item.submenu) : [])])
    const item = flatten(Menu.getApplicationMenu()).find(item => item.accelerator === 'CmdOrCtrl+N')
    if (!item) throw new Error('新建窗口菜单缺失')
    item.click(item, BrowserWindow.fromId(${primaryWindowId}))
  })()`)
  await waitFor("require('electron').BrowserWindow.getAllWindows().length === 2", '新窗口未创建', main)
  const secondWindowId = await evaluate(main, `require('electron').BrowserWindow.getAllWindows().find(win => win.id !== ${primaryWindowId}).id`)
  await waitFor(`require('electron').BrowserWindow.fromId(${secondWindowId}).webContents.executeJavaScript("!!document.querySelector('#editor .cm-content')?.cmTile?.root?.view && document.getElementById('left-sidebar').dataset.content === 'outline'")`, '新窗口渲染未就绪', main)
  await evaluate(main, `(() => {
    const win = require('electron').BrowserWindow.fromId(${secondWindowId})
    win.webContents.send('set-sidebar-content', 'left', 'files')
    win.webContents.send('set-sidebar-content', 'right', 'outline')
    win.webContents.send('toggle-sidebar', 'left')
  })()`)
  await waitFor(`require('electron').BrowserWindow.fromId(${secondWindowId}).webContents.executeJavaScript("JSON.parse(localStorage.getItem('${preference}')).left.content === 'files' && !JSON.parse(localStorage.getItem('${preference}')).left.visible")`, '新窗口侧栏配置未改变', main)
  const secondaryMenu = `(() => {
    const menu = require('electron').Menu.getApplicationMenu()
    return menu.getMenuItemById('sidebar-left-files').checked && menu.getMenuItemById('sidebar-right-outline').checked && !menu.getMenuItemById('sidebar-left-visible').checked
  })()`
  const windowDiagnostics = await evaluate(main, `(() => {
    const { BrowserWindow, Menu } = require('electron')
    const menu = Menu.getApplicationMenu()
    return { focused: BrowserWindow.getFocusedWindow()?.id ?? null,
      windows: BrowserWindow.getAllWindows().map(win => ({ id: win.id, focused: win.isFocused(), focusable: win.isFocusable() })),
      primary: ${primaryWindowId}, secondary: ${secondWindowId},
      menu: ['sidebar-left-visible','sidebar-right-visible','sidebar-left-files','sidebar-left-outline','sidebar-right-files','sidebar-right-outline'].map(id => ({ id, checked: menu.getMenuItemById(id).checked })) }
  })()`)
  console.log(`多窗口菜单诊断：${JSON.stringify(windowDiagnostics)}`)
  await waitFor(secondaryMenu, `菜单未跟随新窗口配置：${JSON.stringify(windowDiagnostics)}`, main)
  await evaluate(renderer, `window.electronAPI.reportSidebars(JSON.parse(${JSON.stringify(primaryPreferences)}))`)
  check('后台窗口上报不覆盖新窗口菜单勾选', await evaluate(main, secondaryMenu))
  await evaluate(main, `require('electron').BrowserWindow.fromId(${secondWindowId}).close()`)
  await waitFor("require('electron').BrowserWindow.getAllWindows().length === 1", '新窗口未关闭', main)
  const primaryMenu = `(() => {
    const menu = require('electron').Menu.getApplicationMenu()
    return ['sidebar-left-visible','sidebar-right-visible','sidebar-left-outline','sidebar-right-files'].every(id => menu.getMenuItemById(id).checked)
  })()`
  await waitFor(primaryMenu, '关闭新窗口后菜单未恢复原窗口状态', main)
  check('关闭无焦点的新窗口也恢复原窗口菜单', true)
  // 两个实例共享磁盘偏好，主窗口继续操作时以自己的内存状态保存，不强制实时同步。
  await setContent('left', 'outline')
  const beforeRestart = await evaluate(renderer, `localStorage.getItem('${preference}')`)
  await closeApp()
  await pause(200)
  await launch()
  await waitFor(`localStorage.getItem('${preference}') === ${JSON.stringify(beforeRestart)}`, '重启未恢复左右内容、显隐和宽度')
  const restartMenu = await evaluate(main, `(() => {
    const menu = require('electron').Menu.getApplicationMenu()
    return ['sidebar-left-visible','sidebar-right-visible','sidebar-left-outline','sidebar-right-files'].map(id => ({ id, checked: menu.getMenuItemById(id).checked }))
  })()`)
  await waitFor(primaryMenu, `重启菜单未恢复：${JSON.stringify(restartMenu)}`, main)
  check('重启恢复内容、显隐、宽度与菜单勾选', true)

  await evaluate(renderer, `localStorage.removeItem('${preference}'); localStorage.setItem('file-panel-hidden', '0'); localStorage.setItem('file-panel-width', '270'); localStorage.setItem('colamd-panel-side', 'right')`)
  await reload()
  check('旧版显隐和宽度迁给左栏，内容采用左文件右大纲', await evaluate(renderer,
    `${prefs}.left.visible && ${prefs}.left.width === 270 && ${prefs}.left.content === 'files' && !${prefs}.right.visible && ${prefs}.right.content === 'outline'`))
  await evaluate(renderer, `localStorage.setItem('${preference}', '{invalid')`)
  await reload()
  check('损坏的配置不阻止编辑器与侧栏初始化', await evaluate(renderer,
    `${view} && typeof ${prefs}.left.visible === 'boolean' && ['files','outline'].includes(${prefs}.right.content)`))
  check('恢复配置与重启均不重写任一文档', files.every((file, index) => readFileSync(file).equals(original[index].bytes) && statSync(file).mtimeMs === original[index].mtime))

  // 性能回归仍验证真实行为：正文变化保留大纲节点，位置数据必须同时更新。
  const performancePath = join(dir, '节点复用.md')
  const performanceText = '# 复用验收\n\n正文甲。\n\n## 第二节\n\n正文乙。\n'
  writeFileSync(performancePath, performanceText)
  await evaluate(renderer, `window.electronAPI.openFilePath(${JSON.stringify(performancePath)})`)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(performanceText)}`, '节点复用文档未打开')
  for (const side of ['left', 'right']) {
    await setContent(side, 'outline')
    await setVisible(side, true)
  }
  await waitFor("document.querySelectorAll('.outline-list button').length === 4", '双侧大纲未初始化')
  await evaluate(renderer, `(() => {
    window.outlineReuseButtons = [...document.querySelectorAll('.outline-list button')]
    const v = ${view}, position = v.state.doc.toString().indexOf('正文甲')
    v.dispatch({ changes: { from: position, insert: '新增正文\\n\\n' }, userEvent: 'input.type' })
  })()`)
  await evaluate(renderer, '(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return true })()')
  check('正文输入和换行后两侧大纲保留原按钮', await evaluate(renderer,
    "outlineReuseButtons.every((button, index) => button === document.querySelectorAll('.outline-list button')[index])"))
  await clickOutline('right', 1)
  await waitFor(`${view}.state.doc.lineAt(${view}.state.selection.main.head).text === '## 第二节'`, '复用大纲按钮使用了旧行号')
  check('复用的大纲按钮跳转到插入换行后的正确标题', true)

  // 相同根条目不能代表展开目录未变；重复刷新也不应销毁未变化的文件按钮。
  const folder = join(dir, '展开目录')
  const firstChild = join(folder, '原有.md')
  const nextChild = join(folder, '新增.md')
  mkdirSync(folder)
  writeFileSync(firstChild, '# 原有')
  for (const side of ['left', 'right']) await setContent(side, 'files')
  const publishFiles = async () => {
    const entries = await evaluate(renderer, 'window.electronAPI.listSiblings()')
    await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('siblings-changed', ${JSON.stringify(entries)})`)
  }
  await publishFiles()
  await waitFor(`[...document.querySelectorAll('#left-sidebar .file-list button')].some(button => button.dataset.path === ${JSON.stringify(folder)})`, '目录未出现在列表')
  await evaluate(renderer, `[...document.querySelectorAll('#left-sidebar .file-list button')].find(button => button.dataset.path === ${JSON.stringify(folder)}).click()`)
  await waitFor(`[...document.querySelectorAll('#left-sidebar .file-list button')].some(button => button.dataset.path === ${JSON.stringify(firstChild)})`, '展开目录未读取')
  await evaluate(renderer, "window.fileReuseButtons = [...document.querySelectorAll('.file-list button[data-path]')]")
  await publishFiles()
  await evaluate(renderer, '(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return true })()')
  check('重复目录事件保留未变化的文件按钮', await evaluate(renderer,
    "fileReuseButtons.every(button => button.isConnected)"))
  writeFileSync(nextChild, '# 新增')
  await publishFiles()
  await waitFor(`['left','right'].every(side => [...document.querySelectorAll('#' + side + '-sidebar .file-list button')].some(button => button.dataset.path === ${JSON.stringify(nextChild)}))`, '根列表相同时未刷新已展开子目录')
  check('根条目不变时，两侧仍显示展开目录内新增文件', true)
  check('子目录刷新完成后仍保留原有文件按钮', await evaluate(renderer,
    "fileReuseButtons.every(button => button.isConnected)"))
  console.log(`左右侧栏真机验收通过，共 ${passed} 项。`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  renderer?.close(); main?.close()
  child?.kill('SIGTERM')
  stopVerifyApp(udd)
}
