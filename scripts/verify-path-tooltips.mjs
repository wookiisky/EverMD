// 在离屏 Electron 中验证完整路径、提示速度、长路径布局及关闭行为。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { dir, udd } = verifyWorkdir('path-tooltips')
const folder = join(dir, ...Array.from({ length: 4 }, (_, i) => `${i}-${'long-path-'.repeat(8)}`))
mkdirSync(join(folder, '子目录'), { recursive: true })
const files = [join(folder, 'a.md'), join(folder, '子目录', 'a.md'), join(folder, '路径<&>.md')]
for (const file of files) writeFileSync(file, '# 提示路径\n\n正文保持不变。\n')
const original = files.map(file => ({ bytes: readFileSync(file), mtime: statSync(file).mtimeMs }))
const port = 29100 + Math.floor(Math.random() * 200)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, renderer, main, hoverAnchor, passed = 0

// 调试请求失败或断连时终止验收。
async function connect(portNumber, type) {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json()).find(item => item.type === type) } catch {}
    if (!target) await pause(100)
  }
  assert(target, `未找到 ${type} 调试目标`)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('调试连接提前关闭')) }
    pending.clear()
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`调试超时：${method}`)) }, 15000)
        pending.set(requestId, { resolve, reject, timer })
        socket.send(JSON.stringify({ id: requestId, method, params }))
      })
    },
    close: () => socket.close()
  }
}

// 页面异常必须使测试失败。
async function evaluate(expression, client = renderer) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 按实际状态等待，提示超过半秒仍未出现就判定失败。
async function waitFor(expression, message, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return
    await pause(25)
  }
  throw new Error(message)
}

// 使用真实鼠标输入，覆盖标题栏事件接线与命中区域。
async function hover(selector) {
  hoverAnchor = selector
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400 })
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    const rect = element.getBoundingClientRect()
    return { x: rect.left + Math.min(rect.width / 2, 30), y: rect.top + rect.height / 2 }
  })()`)
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  return point
}

// 每项断言对应可以观察到的行为。
function check(name, ok) {
  assert(ok, name)
  passed++
  console.log(`通过：${name}`)
}

// 同时检验完整文本、窗口边界与未截断的排版。
async function expectTip(path) {
  await waitFor('!document.getElementById("hover-tip").hidden', '悬停提示应在半秒内出现', 500)
  const result = await evaluate(`(() => {
    const tip = document.getElementById('hover-tip'), rect = tip.getBoundingClientRect()
    const anchor = document.querySelector(${JSON.stringify(hoverAnchor)}).getBoundingClientRect()
    return { text: tip.textContent, elements: tip.children.length, fits: rect.left >= 7 && rect.right <= innerWidth - 7
      && rect.top >= 7 && rect.bottom <= innerHeight - 7, wraps: tip.scrollWidth <= tip.clientWidth + 1,
      beside: rect.right <= anchor.left || rect.left >= anchor.right || rect.bottom <= anchor.top || rect.top >= anchor.bottom,
      pointer: getComputedStyle(tip).pointerEvents, opacity: getComputedStyle(tip).opacity }
  })()`)
  check('提示包含完整路径，路径按纯文本显示', result.text.includes(path) && result.elements === 0)
  check('长路径换行且浮层完整留在窗口内', result.fits && result.wraps)
  check('路径浮层不遮住所描述的条目', result.beside)
  check('浮层不挡鼠标且没有淡入', result.pointer === 'none' && result.opacity === '1')
}

try {
  child = spawn(require('electron'), ['scripts/offscreen-window.cjs', files[0], `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, `--inspect=${port + 1000}`, '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(port + 1000, 'node')
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const fileButton = path => `.sidebar[aria-hidden="false"] .file-list button[data-path=${JSON.stringify(path)}]`
  await waitFor('!!document.querySelector(".tab-entry.active")', '标签页未就绪')
  await evaluate('if (document.getElementById("left-sidebar").getAttribute("aria-hidden") === "true") document.getElementById("left-sidebar-toggle").click()')
  await waitFor(`!!document.querySelector(${JSON.stringify(fileButton(files[0]))})`, '文件列表未就绪')
  await pause(500)
  check('短文件名未被截断，仍需提示路径', await evaluate(`(() => {
    const label = document.querySelector(${JSON.stringify(fileButton(files[0]))}).querySelector('.file-entry-name')
    return label.scrollWidth <= label.clientWidth + 1
  })()`))
  await hover('.tab-entry.active')
  await expectTip(files[0])
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400 })
  check('移开标签后立即隐藏提示', await evaluate('document.getElementById("hover-tip").hidden'))

  for (const theme of ['elegant', 'dark']) {
    await evaluate(`require('electron').BrowserWindow.getAllWindows()[0].webContents.send('set-theme', ${JSON.stringify(theme)})`, main)
    await waitFor(`localStorage.getItem('colamd-theme') === ${JSON.stringify(theme)}`, '主题未切换')
    await pause(200)
    for (const path of [files[0], files[2], join(folder, '子目录'), dirname(folder)]) {
      await hover(fileButton(path))
      await expectTip(path)
      check(`${theme} 主题不弹出重复的系统提示`, await evaluate(`!document.querySelector(${JSON.stringify(fileButton(path))}).hasAttribute('title')`))
    }
    if (process.argv.includes('--screenshots')) {
      try {
        const shot = await renderer.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        writeFileSync(`/tmp/evermd-path-tooltips-${theme}.png`, Buffer.from(shot.data, 'base64'))
        console.log(`截图：/tmp/evermd-path-tooltips-${theme}.png`)
      } catch (error) { console.error('截图未完成：', error.message) }
    }
  }

  await evaluate(`(() => {
    const { Menu, BrowserWindow } = require('electron')
    const item = Menu.getApplicationMenu().getMenuItemById('sidebar-right-files')
    item.click(item, BrowserWindow.getAllWindows()[0])
  })()`, main)
  await evaluate('if (document.getElementById("right-sidebar").getAttribute("aria-hidden") === "true") document.getElementById("right-sidebar-toggle").click()')
  const rightButton = fileButton(files[0]).replace('.sidebar', '#right-sidebar')
  await waitFor(`!!document.querySelector(${JSON.stringify(rightButton)})`, '右侧文件列表未就绪')
  await pause(250)
  await hover(rightButton)
  await expectTip(files[0])
  await evaluate("require('electron').BrowserWindow.getAllWindows()[0].setSize(720, 600)", main)
  await waitFor('innerWidth === 720', '窗口未缩窄')
  check('窗口缩放关闭旧位置的提示', await evaluate('document.getElementById("hover-tip").hidden'))
  await pause(250)
  await hover(rightButton)
  await expectTip(files[0])

  await hover(fileButton(files[0]))
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pause(350)
  check('Escape 取消尚未出现的提示', await evaluate('document.getElementById("hover-tip").hidden'))
  await hover(fileButton(files[0]))
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 350, y: 400 })
  await pause(350)
  check('快速移开取消等待中的提示', await evaluate('document.getElementById("hover-tip").hidden'))
  const point = await hover('.tab-entry.active')
  await expectTip(files[0])
  await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  check('按下鼠标关闭提示', await evaluate('document.getElementById("hover-tip").hidden'))
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await hover(fileButton(files[0]))
  await expectTip(files[0])
  await evaluate('document.querySelector(".sidebar[aria-hidden=false]").dispatchEvent(new Event("scroll"))')
  check('滚动关闭路径提示', await evaluate('document.getElementById("hover-tip").hidden'))

  // 同名文件分别打开，背景标签必须保留自己的路径。
  await evaluate(`require('electron').BrowserWindow.getAllWindows()[0].webContents.send('open-in-new-tab', ${JSON.stringify(files[1])})`, main)
  await waitFor('document.querySelectorAll(".tab-entry").length === 2', '同名文件未在新标签打开')
  await hover('.tab-entry:not(.active)')
  await expectTip(files[0])
  await hover('.tab-entry.active')
  await expectTip(files[1])
  await evaluate('document.querySelector(".tab-new-btn").click()')
  await waitFor('document.querySelectorAll(".tab-entry").length === 3', '未命名标签未创建')
  await hover('.tab-entry.active')
  await waitFor('!document.getElementById("hover-tip").hidden', '未命名标签缺少提示', 500)
  check('未保存标签不虚构路径，保留关闭快捷键', await evaluate('!document.getElementById("hover-tip").textContent.includes("/") && document.getElementById("hover-tip").textContent.includes("⌘W")'))
  await evaluate('document.querySelector(".tab-entry.active .tab-entry-close").click()')
  await pause(350)
  check('标签关闭后不残留提示', await evaluate('document.getElementById("hover-tip").hidden'))
  check('所有文件字节与修改时间保持不变', files.every((file, i) => readFileSync(file).equals(original[i].bytes) && statSync(file).mtimeMs === original[i].mtime))
  console.log(`路径提示真机验收通过，共 ${passed} 项。`)
} catch (error) {
  if (renderer) console.error('失败时界面状态：', await evaluate(`({ tabs: [...document.querySelectorAll('.tab-entry')].map(el => el.dataset.fullName),
    panels: [...document.querySelectorAll('.sidebar')].map(el => ({ id: el.id, hidden: el.getAttribute('aria-hidden'), text: el.textContent.slice(0, 300) })),
    paths: [...document.querySelectorAll('.file-list button')].map(el => el.dataset.path) })`))
  throw error
} finally {
  renderer?.close()
  main?.close()
  if (child && child.exitCode === null) child.kill('SIGTERM')
  stopVerifyApp(udd)
}
