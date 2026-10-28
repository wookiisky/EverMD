#!/usr/bin/env node
// 前进后退的真实 Electron 验收；位置变化经过编辑器与原生菜单，窗口始终离屏。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { dir, udd } = verifyWorkdir('navigation')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const fixture = Array.from({ length: 130 }, (_, i) => `第${String(i + 1).padStart(3, '0')}行，导航位置验证。`).join('\n') + '\n'
const second = '# 第二个文档\r\n\r\n保留原始行尾。\r\n'
const third = '# 会被删除的文档\n\n删除后应跳过历史记录。\n'
const files = [join(dir, '导航甲.md'), join(dir, '导航乙.md'), join(dir, '待删除.md'), join(dir, '相同内容.md')]
for (const [i, text] of [fixture, second, third, second].entries()) writeFileSync(files[i], text)
const original = files.map(file => ({ bytes: readFileSync(file), mtime: statSync(file).mtimeMs }))
const port = 23200 + Math.floor(Math.random() * 200)
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

// 原生菜单状态就是用户可用的导航边界，不读取历史模块内部数据。
async function menuState() {
  return evaluate(main, `(() => {
    const menu = require('electron').Menu.getApplicationMenu()
    return ['navigation-back','navigation-forward'].map(id => {
      const item = menu.getMenuItemById(id)
      return item ? { id, enabled: item.enabled, accelerator: item.accelerator } : null
    })
  })()`)
}

// 移动真实 CodeMirror 选区，输入处理与更新监听照常执行。
async function moveTo(line, column = 0, settle = true) {
  const position = await evaluate(renderer, `(() => {
    const v = ${view}, pos = v.state.doc.line(${line}).from + ${column}
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); v.focus()
    return pos
  })()`)
  if (settle) await pause(650)
  return position
}

// 用可观察的正文与选区核对导航完成，而不是等待固定的加载时长。
async function expectPosition(position, label, content = fixture) {
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(content.replace(/\r\n/g, '\n'))} && ${view}.state.selection.main.head === ${position}`, label)
  check(label, true)
}

// 真实键盘路径验证快捷键只派发一次，不能直接调用菜单替代。
async function shortcut(direction) {
  const key = direction < 0 ? 'ArrowLeft' : 'ArrowRight'
  const modifiers = await evaluate(renderer, "/^Mac/i.test(navigator.platform) ? 5 : 1")
  const windowsVirtualKeyCode = direction < 0 ? 37 : 39
  await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode, modifiers })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers })
  await pause(150)
}

// 仅延迟真实 fs.readFile 的完成，不替换文件内容或加载结果。
async function delayRead(path) {
  await evaluate(main, `(() => {
    const fs = require('fs/promises')
    globalThis.navigationOriginalReadFile = fs.readFile
    globalThis.navigationReadBlocked = false
    const gate = new Promise(resolve => { globalThis.navigationReleaseRead = resolve })
    fs.readFile = async (...args) => {
      if (args[0] === ${JSON.stringify(path)}) { globalThis.navigationReadBlocked = true; await gate }
      return globalThis.navigationOriginalReadFile(...args)
    }
  })()`)
}

// 放行目标读取前恢复 fs，后续文件监听不受测试闸门影响。
async function releaseRead() {
  await evaluate(main, `(() => { require('fs/promises').readFile = globalThis.navigationOriginalReadFile; globalThis.navigationReleaseRead() })()`)
}

// 文件浏览通过侧栏条目点击，覆盖保存保护及文件加载接线。
async function openFile(index, newTab = false) {
  await waitFor(`Array.from(document.querySelectorAll('.file-list button[data-path]')).some(el => el.dataset.path === ${JSON.stringify(files[index])})`, '文件列表没有目标文件')
  await evaluate(renderer, `(() => {
    const button = Array.from(document.querySelectorAll('.file-list button[data-path]')).find(el => el.dataset.path === ${JSON.stringify(files[index])})
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: ${newTab}, ctrlKey: ${newTab} }))
  })()`)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(readFileSync(files[index], 'utf8').replace(/\r\n/g, '\n'))}`, '目标文件未打开')
  await pause(150)
}

try {
  child = spawn(require('electron'), [
    'scripts/offscreen-window.cjs', files[0], `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'
  ], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(fixture)}`, '测试文档未载入')
  const initial = await menuState()
  check('原生视图菜单包含后退与前进', initial.every(Boolean), JSON.stringify(initial))
  check('首次打开没有可前进或后退的位置', initial.every(item => !item.enabled), JSON.stringify(initial))
  check('菜单快捷键与平台约定一致', await evaluate(main, `(() => {
    const menu = require('electron').Menu.getApplicationMenu(), prefix = process.platform === 'darwin' ? 'Cmd+Alt+' : 'Alt+'
    return menu.getMenuItemById('navigation-back').accelerator === prefix + 'Left' && menu.getMenuItemById('navigation-forward').accelerator === prefix + 'Right'
  })()`))
  await evaluate(renderer, `(() => { const v = ${view}; v.scrollDOM.scrollTop = 900 })()`)
  await pause(650)
  check('纯滚动不产生历史记录', (await menuState()).every(item => !item.enabled))
  await moveTo(1, 2)
  check('微小光标移动不产生历史记录', (await menuState()).every(item => !item.enabled))
  const first = await moveTo(20)
  check('光标大幅跳转后可以后退', (await menuState())[0].enabled)
  const middle = await moveTo(40, 0, false)
  await pause(120)
  const last = await moveTo(60)
  await clickMenu('navigation-back')
  await expectPosition(first, '连续光标移动合并后，一次后退回到上一个停留位置')
  check('后退后保留前进分支', (await menuState())[1].enabled)
  await clickMenu('navigation-forward')
  await expectPosition(last, '前进恢复连续移动的最后落点')
  check('中间位置与最终位置不同，防抖断言有效', middle !== last)
  await shortcut(-1)
  await expectPosition(first, '快捷键只后退一次，历史回放不生成额外锚点')
  await moveTo(20, 2)
  check('后退后的微小移动不清除前进分支', (await menuState())[1].enabled)
  const branch = await moveTo(85)
  check('后退后新的有效跳转清除前进分支', !(await menuState())[1].enabled)
  await clickMenu('navigation-back')
  await expectPosition(first + 2, '微小移动刷新精确返回位置')
  await clickMenu('navigation-forward')
  await expectPosition(branch, '新的前进分支只包含有效跳转')

  await clickMenu('sidebar-left-visible')
  await openFile(1)
  await clickMenu('navigation-back')
  await expectPosition(branch, '跨文件后退恢复前一文件及光标')
  await clickMenu('navigation-forward')
  await expectPosition(0, '跨文件前进恢复目标文件', second)
  await clickMenu('navigation-back')
  await expectPosition(branch, '连续跨文件回放不污染历史')
  check('导航没有增加标签数量', await evaluate(renderer, "document.querySelectorAll('.tab-entry').length === 1"))
  check('导航不改写两个文件的内容或修改时间', files.slice(0, 2).every((file, index) => readFileSync(file).equals(original[index].bytes) && statSync(file).mtimeMs === original[index].mtime))

  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await pause(650)
  const sourceFrom = fixture.indexOf('第110行')
  const sourceTo = sourceFrom + 6
  await evaluate(renderer, `(() => { const ta = document.getElementById('source-editor'); ta.focus(); ta.setSelectionRange(${sourceFrom}, ${sourceTo}, 'backward') })()`)
  await pause(650)
  await clickMenu('navigation-back')
  await waitFor(`document.getElementById('source-editor').selectionStart === ${branch}`, '源码模式后退没有恢复原光标')
  check('源码模式同样记录光标跳转，切换模式不增加锚点', true)
  await clickMenu('navigation-forward')
  check('源码模式前进保留反向选区', await evaluate(renderer, `(() => {
    const ta = document.getElementById('source-editor')
    return ta.selectionStart === ${sourceFrom} && ta.selectionEnd === ${sourceTo} && ta.selectionDirection === 'backward'
  })()`))
  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await pause(650)

  await openFile(2)
  await openFile(1)
  unlinkSync(files[2])
  await clickMenu('navigation-back')
  await expectPosition(sourceFrom, '已删除文件不会堵塞后退，跳过后恢复可达文件')
  check('所有只读导航仍保留两个文件原始字节与修改时间', files.slice(0, 2).every((file, index) => readFileSync(file).equals(original[index].bytes) && statSync(file).mtimeMs === original[index].mtime))
  await openFile(1, true)
  check('显式新标签打开文件保留原标签', await evaluate(renderer, "document.querySelectorAll('.tab-entry').length === 2"))
  const marker = '独立编辑'
  await evaluate(renderer, `(() => {
    const v = ${view}, pos = v.state.doc.length
    v.dispatch({ changes: { from: pos, insert: ${JSON.stringify(marker)} }, selection: { anchor: pos + ${marker.length} }, userEvent: 'input.type' })
    v.focus()
  })()`)
  await pause(650)
  await clickMenu('navigation-back')
  await expectPosition(sourceFrom, '编辑不新增导航记录，后退直接回到另一文件')
  check('离开前保存只写入自己的文件', readFileSync(files[1], 'utf8').endsWith(marker) && readFileSync(files[0]).equals(original[0].bytes) && statSync(files[0]).mtimeMs === original[0].mtime)
  await clickMenu('navigation-forward')
  await waitFor(`${view}.state.doc.toString().endsWith(${JSON.stringify(marker)})`, '前进没有恢复编辑后的文件')
  await waitFor(`${view}.hasFocus`, '前进恢复文档后焦点没有回到编辑器')
  check('前进恢复后可以直接继续编辑', true)
  const modifier = await evaluate(renderer, "/^Mac/i.test(navigator.platform) ? 4 : 2")
  await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: modifier })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: modifier })
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`, '回放后的撤销没有只撤销 B 的编辑')
  check('前进后退保留各标签撤销历史且导航本身不可撤销', true)
  await clickMenu('navigation-back')
  await expectPosition(sourceFrom, '撤销后仍可返回原文件')
  await evaluate(renderer, `(() => {
    const entry = Array.from(document.querySelectorAll('.tab-entry')).find(el => el.dataset.fullName === '导航乙')
    entry.querySelector('.tab-entry-close').click()
  })()`)
  await waitFor("document.querySelectorAll('.tab-entry').length === 1", '背景标签未关闭')
  await clickMenu('navigation-forward')
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`, '关闭后历史没有重新打开文件')
  check('已关闭文件仍可通过前进重新打开', true)
  check('打开已关闭文件不额外创建标签', await evaluate(renderer, "document.querySelectorAll('.tab-entry').length === 1"))
  check('跨标签编辑和撤销始终没有修改另一个文件', readFileSync(files[0]).equals(original[0].bytes) && statSync(files[0]).mtimeMs === original[0].mtime)
  // 在真实文件权限边界制造失败；测试专用对话框回复避免离屏窗口等待人工操作。
  await evaluate(main, `(() => {
    const dialog = require('electron').dialog
    globalThis.navigationOriginalDialog = dialog.showMessageBox
    globalThis.navigationDialogs = []
    dialog.showMessageBox = async (...args) => {
      globalThis.navigationDialogs.push(args.at(-1))
      return { response: 0, checkboxChecked: false }
    }
  })()`)
  chmodSync(files[0], 0o000)
  try {
    await clickMenu('navigation-back')
    await waitFor('globalThis.navigationDialogs.length > 0', '读取失败没有反馈', main)
    check('读取权限失败保持原文件与历史指针', await evaluate(renderer, `${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`) && (await menuState())[0].enabled)
  } finally {
    chmodSync(files[0], 0o600)
    await evaluate(main, "require('electron').dialog.showMessageBox = globalThis.navigationOriginalDialog")
  }
  await clickMenu('navigation-back')
  await expectPosition(sourceFrom, '读取恢复后，同一条后退记录仍然可用')
  await evaluate(main, `(() => {
    const { Menu, BrowserWindow } = require('electron'), menu = Menu.getApplicationMenu(), win = BrowserWindow.getAllWindows()[0]
    for (const id of ['navigation-forward','navigation-back','navigation-forward']) {
      const item = menu.getMenuItemById(id); item.click(item, win)
    }
  })()`)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`, '连续导航没有按顺序完成')
  await pause(700)
  check('快速前进后退按顺序完成且没有迟到的错误恢复', await evaluate(renderer, `${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`))
  await delayRead(files[0])
  try {
    await clickMenu('navigation-back')
    await waitFor('globalThis.navigationReadBlocked', '目标读取没有进入等待', main)
    check('读取期间渲染编辑器和源码文本框都进入只读状态', await evaluate(renderer, `!${view}.contentDOM.isContentEditable && document.getElementById('source-editor').readOnly`))
    await evaluate(renderer, `(() => { const v = ${view}; v.dispatch({ changes: { from: 0, insert: '不应写入' }, userEvent: 'input.type' }) })()`)
    for (const [key, code, windowsVirtualKeyCode] of [['b','KeyB',66], ['z','KeyZ',90]]) {
      await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers: modifier })
      await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers: modifier })
    }
    check('等待跨文件读取时格式、撤销及用户事务均不能改写旧文档', await evaluate(renderer, `${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`))
  } finally { await releaseRead() }
  await expectPosition(sourceFrom, '慢读取完成后仍恢复正确文件和位置')
  await clickMenu('navigation-forward')
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`, '慢读取后不能前进')
  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: modifier })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: modifier })
  await evaluate(renderer, `(() => {
    const input = document.querySelector('.search-panel > .search-input')
    input.value = '第二个'; input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.search-replace-input').value = '不应替换'
  })()`)
  await delayRead(files[0])
  try {
    await clickMenu('navigation-back')
    await waitFor('globalThis.navigationReadBlocked', '源码模式目标读取没有进入等待', main)
    await evaluate(renderer, "document.querySelectorAll('.search-replace-row button').forEach(button => button.click())")
    check('等待跨文件读取时源码替换和全部替换不能改写旧文档', await evaluate(renderer, `document.getElementById('source-editor').value === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`))
    await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
    check('慢读取期间源码切回渲染仍保留完整正文', await evaluate(renderer, `${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`))
  } finally { await releaseRead() }
  await waitFor(`(() => { const source = document.getElementById('source-editor'); return (source.classList.contains('visible') ? source.value : ${view}.state.doc.toString()) === ${JSON.stringify(fixture)} })()`, '源码模式慢读取后未恢复目标文件')
  await evaluate(renderer, "document.querySelector('.search-close').click(); if (document.getElementById('source-editor').classList.contains('visible')) document.getElementById('source-toggle-btn').click()")
  await clickMenu('navigation-forward')
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(second.replace(/\r\n/g, '\n'))}`, '源码模式慢读取后前进失败')
  // 两个文件字节相同时仍必须清空前一文件的撤销栈，避免“内容未变”提前返回。
  const sameContentMarker = '相同内容的独立编辑'
  await evaluate(renderer, `(() => {
    const v = ${view}, pos = v.state.doc.length
    v.dispatch({ changes: { from: pos, insert: ${JSON.stringify(sameContentMarker)} }, selection: { anchor: pos + ${sameContentMarker.length} }, userEvent: 'input.type' }); v.focus()
  })()`)
  writeFileSync(files[3], second + sameContentMarker)
  await openFile(3)
  await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: modifier })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: modifier })
  await pause(650)
  check('相同内容跨文件切换仍隔离撤销栈', await evaluate(renderer, `${view}.state.doc.toString() === ${JSON.stringify((second + sameContentMarker).replace(/\r\n/g, '\n'))}`))
  check('撤销不会把另一个文件的编辑写入当前文件', readFileSync(files[3], 'utf8') === second + sameContentMarker)
  // 未命名文档需要保存后才能用同一标签打开历史文件；取消必须保留当前内容。
  await evaluate(renderer, "document.querySelector('.tab-new-btn').click()")
  await waitFor(`document.querySelectorAll('.tab-entry').length === 2 && ${view}.state.doc.length === 0`, '未命名标签没有创建')
  const unsavedText = '取消导航时必须保留的未保存内容'
  await evaluate(renderer, `(() => { const v = ${view}; v.dispatch({ changes: { from: 0, insert: ${JSON.stringify(unsavedText)} }, selection: { anchor: ${unsavedText.length} }, userEvent: 'input.type' }) })()`)
  await evaluate(renderer, `(() => {
    const tab = Array.from(document.querySelectorAll('.tab-entry')).find(el => el.dataset.fullName === '相同内容')
    tab.querySelector('.tab-entry-close').click()
  })()`)
  await waitFor("document.querySelectorAll('.tab-entry').length === 1", '用于取消测试的背景标签没有关闭')
  await evaluate(main, `(() => {
    const dialog = require('electron').dialog
    globalThis.navigationOriginalSaveDialog = dialog.showSaveDialog
    globalThis.navigationSaveCancellations = 0
    dialog.showSaveDialog = async () => { globalThis.navigationSaveCancellations++; return { canceled: true, filePath: undefined } }
  })()`)
  try {
    for (const count of [1, 2]) {
      await clickMenu('navigation-back')
      await waitFor(`globalThis.navigationSaveCancellations === ${count}`, '导航没有触发真实保存取消路径', main)
      await waitFor(`${view}.contentDOM.isContentEditable`, '取消保存后编辑器没有恢复可编辑')
      check(count === 1 ? '保存取消保留未命名文档、文字和后退入口' : '再次后退仍请求同一保存，取消不会推进历史指针',
        await evaluate(renderer, `${view}.state.doc.toString() === ${JSON.stringify(unsavedText)} && document.querySelectorAll('.tab-entry').length === 1 && document.querySelector('.tab-entry.active').dataset.fullName !== '相同内容'`) && (await menuState())[0].enabled)
    }
  } finally {
    await evaluate(main, "require('electron').dialog.showSaveDialog = globalThis.navigationOriginalSaveDialog")
  }
  // 已打开标签的内存副本不能因为文件被移走而无法查看、保存或关闭相邻标签。
  await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('open-in-new-tab', ${JSON.stringify(files[0])})`)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(fixture)}`, '恢复测试未打开甲文件')
  await openFile(3, true)
  const untouched = { bytes: readFileSync(files[3]), mtime: statSync(files[3]).mtimeMs }
  unlinkSync(files[0])
  check('普通文件打开不会把缺失路径当作可恢复的内存标签', await evaluate(renderer,
    `(async () => (await window.electronAPI.navigateToFile(${JSON.stringify(files[0])})).status === 'missing')()`))
  await evaluate(renderer, "Array.from(document.querySelectorAll('.tab-entry')).find(el => el.dataset.fullName === '导航甲').click()")
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(fixture)}`, '磁盘删除后无法激活已有标签的内存副本')
  check('磁盘删除后仍可激活已有标签并读取完整内存内容', true)
  await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].webContents.send('menu-save')")
  await waitFor(`require('fs').existsSync(${JSON.stringify(files[0])})`, '内存副本无法保存回原路径', main)
  check('恢复标签的普通保存只重建自己的文件', readFileSync(files[0], 'utf8') === fixture && readFileSync(files[3]).equals(untouched.bytes) && statSync(files[3]).mtimeMs === untouched.mtime)
  // 已确认缺失的基线与“尚不知道修改时间”不同；监听抑制期内也不能覆盖外部重建。
  unlinkSync(files[0])
  check('自动保存保护用例进入已有标签的缺失文件分支', await evaluate(renderer,
    `(async () => (await window.electronAPI.navigateToFile(${JSON.stringify(files[0])}, true)).status === 'cached')()`))
  const externallyRecreated = fixture + '\n外部进程重建的内容，不得被自动保存覆盖。\n'
  writeFileSync(files[0], externallyRecreated)
  const recreatedMtime = statSync(files[0]).mtimeMs
  const blockedAutosave = await evaluate(renderer,
    `window.electronAPI.saveFile(${JSON.stringify(fixture)}, ${JSON.stringify(files[0])}, false, true)`)
  check('缺失文件被外部重建后自动保存拒绝覆盖，保留字节及修改时间', blockedAutosave === null && readFileSync(files[0], 'utf8') === externallyRecreated && statSync(files[0]).mtimeMs === recreatedMtime)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(externallyRecreated)}`, '拒绝自动保存后没有通知渲染层外部版本')
  check('接受外部重建版本后自动保存不再重复冲突', await evaluate(renderer,
    `window.electronAPI.saveFile(${JSON.stringify(externallyRecreated)}, ${JSON.stringify(files[0])}, false, true)`) === files[0])
  writeFileSync(files[0], fixture)
  await evaluate(renderer, `window.electronAPI.openSibling(${JSON.stringify(files[0])})`)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(fixture)}`, '自动保存保护测试没有恢复后续夹具')
  await evaluate(renderer, "Array.from(document.querySelectorAll('.tab-entry')).find(el => el.dataset.fullName === '相同内容').click()")
  await waitFor("document.querySelector('.tab-entry.active').dataset.fullName === '相同内容'", '恢复测试未切回乙文件')
  unlinkSync(files[0])
  await evaluate(renderer, "document.querySelector('.tab-entry.active .tab-entry-close').click()")
  await waitFor(`document.querySelectorAll('.tab-entry').length === 2 && ${view}.state.doc.toString() === ${JSON.stringify(fixture)}`, '相邻文件缺失阻止当前标签关闭')
  check('关闭当前标签可正常切到磁盘缺失的已有标签', true)
  const recoveredPath = join(dir, '恢复副本.md')
  await evaluate(main, `(() => {
    const dialog = require('electron').dialog
    globalThis.navigationOriginalSaveDialog = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(recoveredPath)} })
  })()`)
  try {
    await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].webContents.send('menu-save-as')")
    await waitFor(`require('fs').existsSync(${JSON.stringify(recoveredPath)})`, '内存副本无法另存为', main)
    check('缺失文件的内存副本可另存且不改写其他打开过的文件', readFileSync(recoveredPath, 'utf8') === fixture && readFileSync(files[3]).equals(untouched.bytes) && statSync(files[3]).mtimeMs === untouched.mtime)
  } finally {
    await evaluate(main, "require('electron').dialog.showSaveDialog = globalThis.navigationOriginalSaveDialog")
  }
  // 文件监听触发真实热更新；搜索框继续接收输入，视口不跳回屏幕外的历史光标。
  const updatePath = join(dir, '热更新交互.md')
  let updatedText = fixture
  writeFileSync(updatePath, updatedText)
  await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('open-in-new-tab', ${JSON.stringify(updatePath)})`)
  await waitFor("document.querySelector('.tab-entry.active').dataset.fullName === '热更新交互'", '热更新测试文件没有打开')
  await moveTo(5)
  for (const sourceMode of [false, true]) {
    if (sourceMode) await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
    await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: modifier })
    await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: modifier })
    const scroller = sourceMode ? "document.getElementById('source-editor')" : `${view}.scrollDOM`
    const content = sourceMode ? "document.getElementById('source-editor').value" : `${view}.state.doc.toString()`
    await evaluate(renderer, `(() => {
      const input = document.querySelector('.search-panel > .search-input')
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus()
      const scroll = ${scroller}; scroll.scrollTop = 900
    })()`)
    await pause(650)
    const beforeScroll = await evaluate(renderer, `${scroller}.scrollTop`)
    assert(beforeScroll > 500, '热更新测试必须先滚离光标')
    updatedText += sourceMode ? '源码热更新\n' : '渲染热更新\n'
    writeFileSync(updatePath, updatedText)
    await waitFor(`${content} === ${JSON.stringify(updatedText)}`, '文件监听没有载入外部更新')
    await pause(150)
    const afterReload = await evaluate(renderer,
      `({ searchFocused: document.activeElement === document.querySelector('.search-panel > .search-input'), scrollTop: ${scroller}.scrollTop })`)
    check(`${sourceMode ? '源码' : '渲染'}热更新保留搜索框焦点与阅读视口`,
      afterReload.searchFocused && Math.abs(afterReload.scrollTop - beforeScroll) <= 2, JSON.stringify({ beforeScroll, ...afterReload }))
    await renderer.send('Input.insertText', { text: '继续搜索' })
    check(`${sourceMode ? '源码' : '渲染'}热更新后继续输入仍只修改搜索词`, await evaluate(renderer,
      `document.querySelector('.search-panel > .search-input').value === '继续搜索' && ${content} === ${JSON.stringify(updatedText)}`))
    await evaluate(renderer, "document.querySelector('.search-close').click()")
  }
  // 通过真实搜索面板替换首尾两处，中间未改动的历史位置必须保留。
  const replacePath = join(dir, '源码批量替换.md')
  const replaceText = 'X\n' + 'a'.repeat(100) + '\n' + 'b'.repeat(100) + '\nX'
  writeFileSync(replacePath, replaceText)
  await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('open-in-new-tab', ${JSON.stringify(replacePath)})`)
  await waitFor(`${view}.state.doc.toString() === ${JSON.stringify(replaceText)}`, '批量替换文件没有打开')
  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: modifier })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: modifier })
  await evaluate(renderer, `(() => {
    const input = document.querySelector('.search-panel > .search-input')
    input.value = 'X'; input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.search-replace-input').value = 'Y'
  })()`)
  for (const position of [0, 102, 203]) {
    await evaluate(renderer, `document.getElementById('source-editor').setSelectionRange(${position}, ${position})`)
    await pause(650)
  }
  await evaluate(renderer, "document.querySelectorAll('.search-replace-row button')[1].click()")
  await pause(650)
  await clickMenu('navigation-back')
  await waitFor("document.getElementById('source-editor').selectionStart === 102", '源码全部替换挪错了中间段落的历史位置')
  check('源码全部替换后后退仍定位到未修改的中间段落', await evaluate(renderer,
    `document.getElementById('source-editor').value === ${JSON.stringify(replaceText.replaceAll('X', 'Y'))}`))
  // 关闭目标标签后从空白标签重开，移除空白历史不能让回放错认相邻记录。
  await evaluate(renderer, "document.querySelector('.search-close').click()")
  for (const sourceMode of [false, true]) {
    const name = sourceMode ? '空白回放源码' : '空白回放渲染'
    const path = join(dir, `${name}.md`)
    // 大文件重开走真实源码模式，分别覆盖两种恢复路径。
    const content = sourceMode ? fixture + '大文件源码。'.repeat(90000) : fixture
    writeFileSync(path, content)
    const saved = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs }
    await evaluate(main, `require('electron').BrowserWindow.getAllWindows()[0].webContents.send('open-in-new-tab', ${JSON.stringify(path)})`)
    await waitFor(`document.querySelector('.tab-entry.active').dataset.fullName === ${JSON.stringify(name)}`, '空白回放目标文件没有打开')
    const caret = sourceMode ? "document.getElementById('source-editor').selectionStart" : `${view}.state.selection.main.head`
    const initialPosition = await evaluate(renderer, caret)
    const target = fixture.split('\n').slice(0, 39).reduce((offset, line) => offset + line.length + 1, 0)
    if (sourceMode) {
      await waitFor("document.getElementById('source-editor').classList.contains('visible')", '大文件未进入源码模式')
      await evaluate(renderer, `document.getElementById('source-editor').setSelectionRange(${target}, ${target})`)
      await pause(650)
    } else await moveTo(40)
    await evaluate(renderer, "document.querySelector('.tab-new-btn').click()")
    await waitFor(`${view}.state.doc.length === 0 && !document.getElementById('source-editor').classList.contains('visible')`, '空白回放标签没有创建')
    await evaluate(renderer, `Array.from(document.querySelectorAll('.tab-entry')).find(el => el.dataset.fullName === ${JSON.stringify(name)}).querySelector('.tab-entry-close').click()`)
    await waitFor(`!Array.from(document.querySelectorAll('.tab-entry')).some(el => el.dataset.fullName === ${JSON.stringify(name)})`, '空白回放目标标签没有关闭')
    await clickMenu('navigation-back')
    await waitFor(`document.querySelector('.tab-entry.active').dataset.fullName === ${JSON.stringify(name)} && ${caret} === ${target}`, '从空白标签重开文件后丢失目标位置')
    check(`${name}在移除空白历史后恢复目标位置`, true)
    await clickMenu('navigation-back')
    await waitFor(`${caret} === ${initialPosition}`, '移除空白历史后跳过了目标文件的较早位置')
    await clickMenu('navigation-forward')
    await waitFor(`${caret} === ${target}`, '移除空白历史后前进未恢复原目标')
    check(`${name}重开后的前进后退仍沿原访问顺序`, true)
    check(`${name}回放没有改写文件`, readFileSync(path).equals(saved.bytes) && statSync(path).mtimeMs === saved.mtime)
  }
  console.log(`前进后退真机验收通过，共 ${passed} 项。`)
} catch (error) {
  console.error(error)
  if (renderer) console.error('失败时编辑器状态：', await evaluate(renderer, `(() => { const v = ${view}, source = document.getElementById('source-editor'); return { content: v.state.doc.toString().slice(0, 300), selection: v.state.selection.main.toJSON(), focus: document.activeElement?.outerHTML.slice(0, 250), sourceVisible: source.offsetParent !== null, sourceLength: source.value.length } })()`).catch(() => null))
  process.exitCode = 1
} finally {
  renderer?.close(); main?.close()
  child?.kill('SIGTERM')
  stopVerifyApp(udd)
}
