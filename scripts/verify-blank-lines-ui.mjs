#!/usr/bin/env node
// 先 npm run build，再 npm run verify:blank-lines-ui；真实 Electron 离屏验收。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
assertBuildFresh()
const { dir, udd } = verifyWorkdir('blank-lines-ui')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const source = "document.getElementById('source-editor')"
const content = `${view}.state.doc.toString()`
const hidden = "[...document.querySelectorAll('#editor .cm-md-blank-line-hidden')]"
const preference = 'colamd-hide-blank-lines'
const fixture = [
  '---', 'title: 隐藏空行验收', '', '', 'note: 保留属性区', '---', '',
  '# 隐藏空行', '', '第一段内容。', '', '', '第二段内容。', '',
  '> **重点验证：** 引用第一段。', '>', '> **CES 产品需求** 引用第二段。',
  '>', '> > # 嵌套标题', '> >', '> > 嵌套正文。', '',
  '```js', 'const a = 1', '', '', 'const b = 2', '```', '',
  '$$', 'x=1', '', '', '+y', '$$', '',
  '<pre>', 'HTML 内容', '', '', 'HTML 尾段', '</pre>', '',
  '最后正文。', ''
].join('\n')
const crlf = '# 第二个文件\r\n\r\n甲\r\n\r\n> 引用甲\r\n>\r\n> 引用乙\r\n'
const files = [join(dir, '视图.md'), join(dir, '第二个文件.md')]
writeFileSync(files[0], fixture)
writeFileSync(files[1], crlf)
const originalTimes = files.map(file => statSync(file).mtimeMs)

// CDP 请求必须有超时，目标提前关闭时不能静默退出成功。
async function connect(port, type) {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === type)
    } catch { /* Electron 尚未启动。 */ }
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

// 主进程与页面表达式都只返回可序列化结果。
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true
  })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

const port = 22300 + Math.floor(Math.random() * 200)
const inspectPort = port + 1000
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child, renderer, main, passed = 0

const waitFor = async (expression, message) => {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(renderer, expression)) return
    await pause(100)
  }
  throw new Error(message)
}
const check = (name, ok) => {
  assert(ok, name)
  passed++
  console.log(`通过：${name}`)
}
const checked = () => evaluate(main, "require('electron').Menu.getApplicationMenu().getMenuItemById('hide-blank-lines').checked")
// MenuItem.click 自行切换 checkbox，覆盖真实菜单与整个 IPC 接线。
const setHidden = async enabled => {
  await evaluate(main, `(() => {
    const { Menu, BrowserWindow } = require('electron')
    const item = Menu.getApplicationMenu().getMenuItemById('hide-blank-lines')
    if (!item || item.type !== 'checkbox') throw new Error('隐藏空行勾选菜单缺失')
    if (item.checked !== ${enabled}) item.click(item, BrowserWindow.getAllWindows()[0])
  })()`)
  await waitFor(`localStorage.getItem(${JSON.stringify(preference)}) === '${enabled ? '1' : '0'}'`, '偏好未更新')
}
const clickMenu = accelerator => evaluate(main, `(() => {
  const { Menu, BrowserWindow } = require('electron')
  const flatten = menu => menu.items.flatMap(item => [item, ...(item.submenu ? flatten(item.submenu) : [])])
  const item = flatten(Menu.getApplicationMenu()).find(item => item.accelerator === ${JSON.stringify(accelerator)})
  if (!item) throw new Error('菜单不存在')
  item.click(item, BrowserWindow.getAllWindows()[0])
})()`)
const moveCaret = async position => {
  await evaluate(renderer, `${view}.dispatch({selection:{anchor:${position}}}); ${view}.focus()`)
  await pause(80)
}
const activate = async id => {
  await evaluate(renderer, `document.querySelector('[data-tab-id="${id}"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId === ${JSON.stringify(id)}`, '标签未激活')
  await pause(100)
}
const launch = async file => {
  child = spawn(require('electron'), [
    'scripts/offscreen-window.cjs', file, `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'
  ], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))}`, '夹具未载入')
}
const closeApp = async () => {
  const exited = new Promise(resolve => child.once('exit', resolve))
  const snapshot = await evaluate(main, `(async () => {
    const { ipcMain, BrowserWindow } = require('electron')
    const win = BrowserWindow.getAllWindows()[0]
    return await new Promise(resolve => {
      const timer = setTimeout(() => { ipcMain.removeListener('document-state-response', listener); resolve({timeout:true}) }, 3000)
      const listener = (_event, id, state) => {
        if (id !== 'visibility-quit-probe') return
        clearTimeout(timer); ipcMain.removeListener('document-state-response', listener)
        resolve({dirty:state.dirty, dirtyTabs:state.tabs?.length, windows:BrowserWindow.getAllWindows().length})
      }
      ipcMain.on('document-state-response', listener)
      win.webContents.send('request-document-state', 'visibility-quit-probe')
    })
  })()`)
  check('关闭前所有文档均无未保存修改', snapshot.dirty === false && snapshot.dirtyTabs === 0)
  await evaluate(main, "(() => { const app = require('electron').app; setImmediate(() => app.quit()); return true })()")
  // Node inspector 连接未断开时，进程可能等待调试器而不退出。
  renderer.close(); main.close()
  renderer = main = null
  await Promise.race([exited, pause(10000).then(() => { throw new Error('测试应用未正常退出') })])
}

try {
  await launch(files[0])
  await moveCaret(fixture.indexOf('# 隐藏空行'))
  check('默认关闭且没有破坏性删除菜单', !await checked() && await evaluate(main,
    "!require('electron').Menu.getApplicationMenu().getMenuItemById('remove-blank-lines')"))
  check('默认空白行正常显示', await evaluate(renderer, `${hidden}.length === 0`))
  const firstTab = await evaluate(renderer, "document.querySelector('.tab-entry.active').dataset.tabId")
  await setHidden(true)
  await waitFor(`${hidden}.length > 0`, '空白行没有隐藏')
  check('正文及引用空白行高度归零', await evaluate(renderer,
    `${hidden}.every(line => line.getBoundingClientRect().height === 0) && ${hidden}.some(line => line.classList.contains('cm-md-blockquote'))`))
  check('只隐藏无正文的行', await evaluate(renderer, `${hidden}.every(line => /^[\\s>]*$/.test(line.textContent))`))
  for (const theme of ['dark', 'light']) {
    await evaluate(main, `(() => {
      const { Menu, BrowserWindow } = require('electron')
      const item = Menu.getApplicationMenu().getMenuItemById('theme-${theme}')
      item.click(item, BrowserWindow.getAllWindows()[0])
    })()`)
    await waitFor(`document.body.classList.contains('theme-${theme}')`, '主题未切换')
    check(`${theme === 'dark' ? '深色' : '浅色'}主题下隐藏行也为零高`, await evaluate(renderer,
      `${hidden}.length > 0 && ${hidden}.every(line => line.getBoundingClientRect().height === 0)`))
  }
  check('隐藏后源码不变且不标记已编辑', await evaluate(renderer,
    `${content} === ${JSON.stringify(fixture)} && !document.querySelector('.tab-entry.active').classList.contains('dirty')`))
  await pause(1200)
  check('开启设置不自动保存任一文件', files.every((file, index) => statSync(file).mtimeMs === originalTimes[index]) && readFileSync(files[0], 'utf8') === fixture)
  check('代码中的空行仍占原有高度', await evaluate(renderer,
    "[...document.querySelectorAll('#editor .cm-line.cm-md-codeblock')].some(line => line.textContent.trim() === '' && line.getBoundingClientRect().height > 0)"))

  const emptyPosition = fixture.indexOf('第一段内容。') + '第一段内容。\n'.length
  await moveCaret(emptyPosition)
  check('正在编辑的空白行临时显示', await evaluate(renderer,
    `(() => { const node = ${view}.domAtPos(${emptyPosition}).node; const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement; const line = element.closest('.cm-line'); return line && !line.classList.contains('cm-md-blank-line-hidden') && line.getBoundingClientRect().height > 0 })()`))
  await moveCaret(fixture.indexOf('第二段内容。'))
  await waitFor(`${hidden}.length > 0`, '离开空白行后未隐藏')
  check('离开后原文仍保留所有空行', await evaluate(renderer, `${content} === ${JSON.stringify(fixture)}`))

  // 文本编辑才允许触发保存；保存必须只包含这一个文字改动，所有隐藏空行仍逐字保留。
  const editPosition = fixture.indexOf('第一段内容。')
  const edited = fixture.replace('第一段内容。', '第一段修改内容。')
  await evaluate(renderer, `${view}.dispatch({changes:{from:${editPosition},to:${editPosition + '第一段内容。'.length},insert:'第一段修改内容。'},userEvent:'input.type'})`)
  await setHidden(false)
  await setHidden(true)
  await evaluate(renderer, `${view}.focus()`)
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers })
  await waitFor(`${content} === ${JSON.stringify(fixture)}`, '视图开关污染撤销历史')
  check('切换开关不占用正文撤销步骤', true)
  await evaluate(renderer, `${view}.dispatch({changes:{from:${editPosition},to:${editPosition + '第一段内容。'.length},insert:'第一段修改内容。'},userEvent:'input.type'})`)
  await clickMenu('CmdOrCtrl+S')
  for (let i = 0; i < 100 && readFileSync(files[0], 'utf8') !== edited; i++) await pause(100)
  check('编辑并保存仍保留全部原始空行', readFileSync(files[0], 'utf8') === edited)
  check('编辑目标文档不改其他文件', readFileSync(files[1], 'utf8') === crlf && statSync(files[1]).mtimeMs === originalTimes[1])

  await clickMenu('CmdOrCtrl+T')
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId !== ${JSON.stringify(firstTab)}`, '未新建标签')
  await evaluate(renderer, `window.electronAPI.openSibling(${JSON.stringify(files[1])})`)
  await waitFor(`${content} === ${JSON.stringify(crlf.replace(/\r\n/g, '\n'))}`, '第二个文件未载入')
  await moveCaret(0)
  await waitFor(`${hidden}.length > 0`, '新打开文件没有自动按偏好隐藏')
  const secondTab = await evaluate(renderer, "document.querySelector('.tab-entry.active').dataset.tabId")
  check('新打开文件自动应用开关且不标脏', !await evaluate(renderer, "document.querySelector('.tab-entry.active').classList.contains('dirty')"))
  await setHidden(false)
  await activate(firstTab)
  await waitFor(`${hidden}.length === 0`, '标签快照恢复了过时的隐藏状态')
  check('恢复旧标签采用当前关闭状态', await evaluate(renderer, `${content} === ${JSON.stringify(edited)}`))
  await setHidden(true)
  await activate(secondTab)
  await moveCaret(0)
  await waitFor(`${hidden}.length > 0`, '旧标签未应用当前开启状态')
  check('恢复另一个标签采用当前开启状态', true)

  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await waitFor(`${source}.classList.contains('visible')`, '未进入源码模式')
  check('源码模式完整显示原文', await evaluate(renderer, `${source}.value === ${JSON.stringify(crlf.replace(/\r\n/g, '\n'))}`))
  await setHidden(false)
  await setHidden(true)
  check('源码模式切换偏好也不改内容', await evaluate(renderer, `${source}.value === ${JSON.stringify(crlf.replace(/\r\n/g, '\n'))}`))
  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await waitFor(`!${source}.classList.contains('visible') && ${hidden}.length > 0`, '切回渲染未恢复隐藏')
  await pause(1200)
  check('打开与切换视图不重写CRLF文件', readFileSync(files[1], 'utf8') === crlf && statSync(files[1]).mtimeMs === originalTimes[1])

  const beforeRestart = files.map(file => ({ content: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs }))
  await closeApp()
  await pause(200)
  await launch(files[1])
  await moveCaret(0)
  await waitFor(`${hidden}.length > 0`, '重启未恢复隐藏偏好')
  check('重启恢复偏好及原生菜单勾选', await checked())
  await pause(1200)
  check('重启自动应用但不自动保存', files.every((file, index) => readFileSync(file, 'utf8') === beforeRestart[index].content && statSync(file).mtimeMs === beforeRestart[index].mtime))
  await setHidden(false)
  await waitFor(`${hidden}.length === 0`, '关闭开关未恢复完整显示')
  check('关闭后恢复完整显示且字节不变', await evaluate(renderer, `${content} === ${JSON.stringify(crlf.replace(/\r\n/g, '\n'))}`))
  console.log(`隐藏空行真机验收通过，共 ${passed} 项。`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  renderer?.close(); main?.close()
  child?.kill('SIGTERM')
  stopVerifyApp(udd)
}
