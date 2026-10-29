#!/usr/bin/env node
// 表格、图片和 Mermaid 全宽偏好：真实 Electron 离屏窗口验收，只改变显示、不改用户文件。
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
const { dir, udd } = verifyWorkdir('wide-media-ui')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const content = `${view}.state.doc.toString()`
const preference = 'colamd-wide-media'
const fixture = [
  '# 全宽视图', '', '普通正文。' + '用于核对正文自动换行与列宽。'.repeat(4), '',
  '| 项目 | 内容 |', '| --- | --- |', '| 第一项 | 第一项的详细说明 |', '',
  '![大图片](large.svg)', '', '![小图片](small.svg)', '',
  '混排开始 ![混排图片](large.svg) 混排结束', '',
  '- ![列表图片](large.svg)', '', '> ![引用图片](large.svg)', '',
  '| 图片 | 描述 |', '| --- | --- |', '| ![单元格图片](small.svg) | 单元格内容 |', '',
  '![加载失败](missing.svg)', '', '[![链接图片](large.svg)](https://example.com)', '',
  '![相邻图片一](small.svg) ![相邻图片二](small.svg)', '', '尾段文字。', ''
].join('\n')
for (const [name, width, height] of [['large', 1800, 45], ['small', 90, 12]]) {
  writeFileSync(join(dir, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#888"/></svg>`)
}
const scratchFile = join(dir, '增量编辑.md')
const scratchFixture = '# 增量编辑\n\n![大图片](large.svg)   \n\n[ ![标签空白图片](large.svg) ](https://example.com)\n\n![真实混排图片](large.svg) 真实文字\n'
writeFileSync(scratchFile, scratchFixture)
const secondFixture = '# 第二个文件\n\n![大图片](large.svg)\n'
const files = [join(dir, '全宽视图.md'), join(dir, '第二个文件.md')]
writeFileSync(files[0], fixture)
writeFileSync(files[1], secondFixture)
const mermaidFile = join(dir, 'Mermaid全宽.md')
const mermaidFixture = [
  '# Mermaid 全宽', '', '普通说明文字。', '',
  '```mermaid', 'flowchart LR',
  'A[开始处理] --> B[读取配置] --> C[准备输入] --> D[校验内容] --> E[转换结构] --> F[构建输出] --> G[检查结果] --> H[保存文件] --> I[准备结束] --> J[记录日志] --> K[清理现场] --> L[完成处理]',
  '```', '', '```mermaid', 'flowchart LR', 'A[甲] --> B[乙]', '```', '',
  '```mermaid', 'this-is-not-a-mermaid-diagram', '```', ''
].join('\n')
writeFileSync(mermaidFile, mermaidFixture)
const mermaidMtime = statSync(mermaidFile).mtimeMs
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
  }).catch(error => { throw new Error(`${error.message}\n表达式：${expression.slice(0, 500)}`) })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

const port = 25300 + Math.floor(Math.random() * 200)
const inspectPort = port + 1000
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child, renderer, main, primaryWindowId, passed = 0

const waitFor = async (expression, message) => {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(renderer, expression)) return
    await pause(100)
  }
  throw new Error(message)
}
const check = (name, ok, details) => {
  assert(ok, details ? `${name}\n${JSON.stringify(details)}` : name)
  passed++
  console.log(`通过：${name}`)
}
const checked = () => evaluate(main, "require('electron').Menu.getApplicationMenu().getMenuItemById('wide-media')?.checked")
// 通过原生菜单触发 checkbox，验证菜单、IPC 与渲染偏好的完整接线。
const clickItem = id => evaluate(main, `(() => {
  const { Menu, BrowserWindow } = require('electron')
  const item = Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)})
  if (!item) throw new Error('菜单项不存在：' + ${JSON.stringify(id)})
  item.click(item, BrowserWindow.fromId(${primaryWindowId}))
})()`)
const setWide = async enabled => {
  if (await checked() !== enabled) await clickItem('wide-media')
  await waitFor(`document.body.classList.contains('wide-media') === ${enabled}`, '全宽偏好未应用')
  await waitFor(`localStorage.getItem(${JSON.stringify(preference)}) === '${enabled ? '1' : '0'}'`, '全宽偏好未持久化')
  await pause(100)
}
// 几何从真实布局读取；图片按 alt 定位，不依赖实现添加的独立图片标记。
const measure = () => evaluate(renderer, `(() => {
  const rect = element => {
    const value = element.getBoundingClientRect()
    return { left: value.left, right: value.right, width: value.width, height: value.height }
  }
  const table = document.querySelector('.cm-md-table-widget')
  const image = document.querySelector('img[alt="大图片"]')
  const line = table.closest('.cm-line')
  const paragraph = [...document.querySelectorAll('.cm-line')].find(element => element.textContent.startsWith('普通正文。'))
  return {
    scroller: {...rect(document.querySelector('#editor .cm-scroller')),clientWidth:document.querySelector('#editor .cm-scroller').clientWidth},
    region: rect(document.getElementById('editor-region')), content: rect(document.querySelector('#editor .cm-content')),
    paragraph: paragraph && rect(paragraph), table: rect(table), image: image && rect(image),
    imageNatural: image?.naturalWidth, imageHeight: image?.naturalHeight,
    linked: rect(document.querySelector('img[alt="链接图片"]')),
    adjacent: rect(document.querySelector('img[alt="相邻图片一"]').closest('.cm-line')),
    failed: rect(document.querySelector('.cm-md-image-failed').closest('.cm-line')),
    tableDisplay: getComputedStyle(table).display, tableOverflow: getComputedStyle(table).overflowX,
    lineOverflow: getComputedStyle(line).overflowX,
    small: rect(document.querySelector('img[alt="小图片"]')),
    nested: ['混排图片','列表图片','引用图片','单元格图片'].map(alt => ({alt,...rect(document.querySelector('img[alt="'+alt+'"]'))}))
  }
})()`)
const measureMermaid = () => evaluate(renderer, `(() => {
  const rect = element => {
    const value = element.getBoundingClientRect()
    return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}
  }
  const hosts = [...document.querySelectorAll('.cm-md-mermaid-ready')]
  const large = hosts[0], small = hosts[1]
  const largeSvg = large.querySelector(':scope > svg'), smallSvg = small.querySelector(':scope > svg')
  const failed = document.querySelector('.cm-md-mermaid-failed')
  const scroller = ${view}.scrollDOM
  return {
    scroller:{...rect(scroller),clientWidth:scroller.clientWidth},
    large:{...rect(large),line:rect(large.closest('.cm-line')),svg:rect(largeSvg),natural:Number(largeSvg.getAttribute('width')),viewBox:largeSvg.getAttribute('viewBox'),overflow:getComputedStyle(large).overflowX,display:getComputedStyle(large).display},
    small:{...rect(small),svg:rect(smallSvg),natural:Number(smallSvg.getAttribute('width'))},
    failed:{...rect(failed),line:rect(failed.closest('.cm-line'))}
  }
})()`)
const waitMermaid = () => waitFor("document.querySelectorAll('.cm-md-mermaid-ready').length === 2 && document.querySelectorAll('.cm-md-mermaid-failed').length === 1 && [...document.querySelectorAll('.cm-md-mermaid-ready')].every(host => host.querySelector(':scope > svg')?.getBoundingClientRect().width > 0)", 'Mermaid夹具没有完成真实渲染')
const close = (a, b) => Math.abs(a - b) < 1
const resize = async (width, height = 1100) => {
  await evaluate(main, `require('electron').BrowserWindow.fromId(${primaryWindowId}).setSize(${width}, ${height})`)
  await pause(300)
}
const setSidebar = async (side, visible) => {
  const current = await evaluate(renderer, `document.body.classList.contains('show-${side}-sidebar')`)
  if (current !== visible) await clickItem(`sidebar-${side}-visible`)
  await waitFor(`document.body.classList.contains('show-${side}-sidebar') === ${visible}`, '侧栏未切换')
  await pause(250)
}
const clickAccelerator = accelerator => evaluate(main, `(() => {
  const { Menu, BrowserWindow } = require('electron')
  const flatten = menu => menu.items.flatMap(item => [item, ...(item.submenu ? flatten(item.submenu) : [])])
  const item = flatten(Menu.getApplicationMenu()).find(item => item.accelerator === ${JSON.stringify(accelerator)})
  if (!item) throw new Error('快捷键菜单不存在')
  item.click(item, BrowserWindow.fromId(${primaryWindowId}))
})()`)
const filesUnchanged = () => statSync(mermaidFile).mtimeMs === mermaidMtime && readFileSync(mermaidFile,'utf8') === mermaidFixture && files.every((file, index) => statSync(file).mtimeMs === originalTimes[index] && readFileSync(file, 'utf8') === [fixture, secondFixture][index])

const launch = async file => {
  child = spawn(require('electron'), [
    'scripts/offscreen-window.cjs', file, `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'
  ], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  primaryWindowId = await evaluate(main, "require('electron').BrowserWindow.getAllWindows()[0].id")
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))}`, '夹具未载入')
}
const closeApp = async () => {
  const exited = new Promise(resolve => child.once('exit', resolve))
  const snapshot = await evaluate(main, `(async () => {
    const { ipcMain, BrowserWindow } = require('electron')
    const win = BrowserWindow.fromId(${primaryWindowId})
    return await new Promise(resolve => {
      const timer = setTimeout(() => { ipcMain.removeListener('document-state-response', listener); resolve({timeout:true}) }, 3000)
      const listener = (_event, id, state) => {
        if (id !== 'wide-media-quit-probe') return
        clearTimeout(timer); ipcMain.removeListener('document-state-response', listener)
        resolve({dirty:state.dirty, dirtyTabs:state.tabs?.length, windows:BrowserWindow.getAllWindows().length})
      }
      ipcMain.on('document-state-response', listener)
      win.webContents.send('request-document-state', 'wide-media-quit-probe')
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
  await launch(mermaidFile)
  check('视图菜单包含默认关闭的全宽勾选项', await checked() === false)
  await resize(1440)
  await setSidebar('left', false)
  await setSidebar('right', false)
  await waitMermaid()
  const mermaidBaseline = await measureMermaid()
  await setWide(true)
  const mermaidWide = await measureMermaid()
  check('顶层宽Mermaid图可突破正文列宽', mermaidWide.large.svg.width > mermaidBaseline.large.svg.width + 100, {before:mermaidBaseline,after:mermaidWide})
  check('Mermaid行保留编辑区两侧留白与既有代码内边距', close(mermaidWide.large.line.left,mermaidWide.scroller.left+40) && close(mermaidWide.large.line.right,mermaidWide.scroller.left+mermaidWide.scroller.clientWidth-40) && mermaidWide.large.svg.left >= mermaidWide.large.left-1 && mermaidWide.large.svg.right <= mermaidWide.large.right+1, mermaidWide)
  check('Mermaid宽图按容器与原始尺寸共同限制最大宽度', close(mermaidWide.large.svg.width,Math.min(mermaidWide.large.width,mermaidWide.large.natural)), mermaidWide.large)
  check('Mermaid小图不强制放大', close(mermaidWide.small.svg.width,mermaidBaseline.small.svg.width) && close(mermaidWide.small.svg.width,mermaidWide.small.natural))
  check('Mermaid失败块保持原正文宽度和源码', close(mermaidWide.failed.line.width,mermaidBaseline.failed.line.width) && await evaluate(renderer, "document.querySelector('.cm-md-mermaid-failed').textContent.includes('this-is-not-a-mermaid-diagram')"))
  check('Mermaid全宽没有引入新的显示或内部溢出行为', mermaidWide.large.overflow === mermaidBaseline.large.overflow && mermaidWide.large.display === mermaidBaseline.large.display)
  await setWide(false)
  const mermaidRestored = await measureMermaid()
  check('关闭开关恢复Mermaid原展示宽度', close(mermaidRestored.large.svg.width,mermaidBaseline.large.svg.width) && close(mermaidRestored.large.line.width,mermaidBaseline.large.line.width))
  await setWide(true)
  for (const theme of ['dark','light']) {
    await clickItem(`theme-${theme}`)
    await waitFor(`document.body.classList.contains('theme-${theme}')`, 'Mermaid主题未应用')
    const layout = await measureMermaid()
    check(`${theme}主题Mermaid受可用宽度限制`, close(layout.large.line.width,layout.scroller.clientWidth-80) && close(layout.large.svg.width,Math.min(layout.large.width,layout.large.natural)), layout)
    if (process.env.COLAMD_WIDE_MEDIA_SCREENSHOTS === '1') {
      const screenshot = await renderer.send('Page.captureScreenshot',{format:'png'})
      writeFileSync(`/tmp/colamd-mermaid-wide-${theme}.png`,Buffer.from(screenshot.data,'base64'))
    }
  }
  for (const [width,left,right] of [[1440,true,true],[680,true,true],[520,false,false]]) {
    await resize(width)
    await setSidebar('left',left)
    await setSidebar('right',right)
    const layout = await measureMermaid()
    check(`${width}px窗口与侧栏下Mermaid遵循编辑区边界`, close(layout.large.line.left,layout.scroller.left+40) && close(layout.large.line.right,layout.scroller.left+layout.scroller.clientWidth-40) && layout.large.svg.width <= layout.large.width+1, layout)
  }
  // 只点击Pele缩放控件；控件应消费事件，不能把图切回源码。
  await waitFor("!!document.querySelector('.cm-md-mermaid-ready .pele-zoom-in') && getComputedStyle(document.querySelector('.cm-md-mermaid-ready .pele-zoom')).display !== 'none'", '窄窗没有提供既有Mermaid缩放控件')
  const zoomFit = (await measureMermaid()).large.viewBox
  await evaluate(renderer, "document.querySelector('.cm-md-mermaid-ready .pele-zoom-in').click()")
  const zoomed = await measureMermaid()
  check('窄窗Mermaid既有放大按钮仍可用且不进入源码', zoomed.large.viewBox !== zoomFit && await evaluate(renderer,"document.querySelectorAll('.cm-md-mermaid-ready').length === 2"))
  await evaluate(renderer, "document.querySelector('.cm-md-mermaid-ready .pele-zoom-reset').click()")
  check('Mermaid既有还原按钮回到适配宽度', (await measureMermaid()).large.viewBox === zoomFit)
  await resize(1100)
  await evaluate(renderer, "document.querySelector('.cm-md-mermaid-ready .pele-zoom-in').click()")
  await setWide(false)
  check('放大后切换全宽开关沿用Pele适配行为', (await measureMermaid()).large.viewBox === zoomFit)
  await setWide(true)
  await resize(1440)
  for (const mode of ['exporting','presenting']) {
    await setWide(false)
    await evaluate(renderer, `document.body.classList.add('${mode}')`)
    await pause(100)
    const before = await measureMermaid()
    await setWide(true)
    const after = await measureMermaid()
    check(`${mode}保持Mermaid原排版规则`, close(before.large.svg.width,after.large.svg.width) && close(before.large.line.width,after.large.line.width) && close(before.small.svg.width,after.small.svg.width))
    await evaluate(renderer, `document.body.classList.remove('${mode}')`)
  }
  await setWide(false)
  await renderer.send('Emulation.setEmulatedMedia',{media:'print'})
  const mermaidPrintBefore = await measureMermaid()
  await setWide(true)
  const mermaidPrintAfter = await measureMermaid()
  check('PDF打印中的Mermaid不受屏幕全宽开关影响', close(mermaidPrintBefore.large.svg.width,mermaidPrintAfter.large.svg.width) && close(mermaidPrintBefore.large.line.width,mermaidPrintAfter.large.line.width))
  await renderer.send('Emulation.setEmulatedMedia',{media:''})
  await pause(150)
  const diagram = (await measureMermaid()).large.svg
  for (const type of ['mousePressed','mouseReleased']) {
    await renderer.send('Input.dispatchMouseEvent',{type,x:diagram.left+40,y:diagram.top+diagram.height/2,button:'left',clickCount:1})
  }
  await waitFor("document.querySelectorAll('.cm-md-mermaid-ready').length === 1", '点击Mermaid未进入源码')
  const mermaidPosition = mermaidFixture.indexOf('flowchart LR')
  const editing = await evaluate(renderer, `(() => {
    const point = ${view}.domAtPos(${mermaidPosition})
    const element = point.node.nodeType === Node.ELEMENT_NODE ? point.node : point.node.parentElement
    const line = element.closest('.cm-line')
    return {width:line.getBoundingClientRect().width,normal:document.querySelector('#editor .cm-content').getBoundingClientRect().width-80,standalone:line.classList.contains('cm-md-mermaid-standalone')}
  })()`)
  check('Mermaid进入源码编辑后恢复普通正文列宽', close(editing.width,editing.normal) && !editing.standalone, editing)
  await evaluate(renderer, `${view}.dispatch({selection:{anchor:0}});${view}.focus()`)
  await waitMermaid()
  check('离开源码后Mermaid恢复全宽且不改文档', (await measureMermaid()).large.svg.width > mermaidBaseline.large.svg.width+100 && await evaluate(renderer,`${content} === ${JSON.stringify(mermaidFixture)} && !document.querySelector('.tab-entry.active').classList.contains('dirty')`))
  await setWide(false)
  await evaluate(renderer, `window.electronAPI.openSibling(${JSON.stringify(files[0])})`)
  await waitFor(`${content} === ${JSON.stringify(fixture)}`, '图片和表格夹具未载入')
  await waitFor(`document.querySelectorAll('#editor img').length >= 9 && [...document.querySelectorAll('#editor img')].every(image => image.complete) && !!document.querySelector('.cm-md-image-failed')`, '图片夹具未渲染')
  await evaluate(renderer, `${view}.dispatch({selection:{anchor:0}})`)
  const baseline = await measure()
  await setWide(true)
  const wide = await measure()
  check('大表格和独立大图使用更宽空间', wide.table.width > baseline.table.width + 100 && wide.image.width > baseline.image.width + 100)
  check('正文列宽和文字位置保持不变', close(wide.paragraph.width, baseline.paragraph.width) && close(wide.paragraph.left, baseline.paragraph.left) && close(wide.content.width, baseline.content.width))
  check('全宽内容止于编辑区两侧留白', close(wide.table.left, wide.scroller.left + 40) && close(wide.table.right, wide.scroller.left + wide.scroller.clientWidth - 40) && wide.image.left >= wide.scroller.left + 39 && wide.image.right <= wide.scroller.left + wide.scroller.clientWidth - 39, wide)
  check('图片保持原始比例且小图不放大', close(wide.image.width / wide.image.height, wide.imageNatural / wide.imageHeight) && close(wide.small.width, 90))
  check('独立链接图片可使用更宽空间', wide.linked.width > baseline.linked.width + 100)
  check('相邻多图与加载失败仍使用原正文行宽', close(wide.adjacent.width, baseline.adjacent.width) && close(wide.failed.width, baseline.failed.width))
  check('混排和各嵌套容器中的图片不扩宽', wide.nested.every((image, index) => close(image.width, baseline.nested[index].width)))
  check('没有新增表格内部横向滚动或改变表格显示方式', wide.tableOverflow === baseline.tableOverflow && wide.lineOverflow === baseline.lineOverflow && wide.tableDisplay === baseline.tableDisplay)
  check('图片加载失败仍显示原始源码', await evaluate(renderer, "document.querySelector('.cm-md-image-failed').textContent === '![加载失败](missing.svg)'"))
  await setWide(false)
  const restored = await measure()
  check('关闭开关恢复表格和图片原宽度', close(restored.table.width, baseline.table.width) && close(restored.image.width, baseline.image.width))

  for (const width of ['narrow', 'standard', 'wide']) {
    await clickItem(`page-width-${width}`)
    await pause(100)
    const before = await measure()
    await setWide(true)
    const after = await measure()
    check(`${width}正文列宽不受全宽开关影响`, close(before.paragraph.width, after.paragraph.width) && close(before.paragraph.left, after.paragraph.left))
    await setWide(false)
  }
  await clickItem('page-width-standard')
  await setWide(true)
  for (const theme of ['dark', 'light']) {
    await clickItem(`theme-${theme}`)
    await waitFor(`document.body.classList.contains('theme-${theme}')`, '主题未应用')
    const layout = await measure()
    check(`${theme}主题使用编辑区可用宽度`, close(layout.table.width, layout.scroller.clientWidth - 80) && layout.image.width <= layout.scroller.clientWidth - 79)
    if (process.env.COLAMD_WIDE_MEDIA_SCREENSHOTS === '1') {
      const screenshot = await renderer.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`/tmp/colamd-wide-media-${theme}.png`, Buffer.from(screenshot.data, 'base64'))
    }
  }
  for (const [width, left, right] of [[1440,true,false],[1440,false,true],[1440,true,true],[680,true,true],[520,false,false]]) {
    await resize(width)
    await setSidebar('left', left)
    await setSidebar('right', right)
    const layout = await measure()
    check(`${width}px窗口、左栏${left}右栏${right}时遵循编辑区边界`, close(layout.table.left, layout.scroller.left + 40) && close(layout.table.right, layout.scroller.left + layout.scroller.clientWidth - 40) && layout.image.left >= layout.scroller.left + 39 && layout.image.right <= layout.scroller.left + layout.scroller.clientWidth - 39, layout)
  }
  await resize(1440)
  await setSidebar('left', false)
  await setSidebar('right', false)
  for (const mode of ['exporting', 'presenting']) {
    await setWide(false)
    await evaluate(renderer, `document.body.classList.add('${mode}')`)
    await pause(100)
    const before = await measure()
    await setWide(true)
    const after = await measure()
    check(`${mode}保持自己的表格和图片宽度规则`, close(before.table.width, after.table.width) && close(before.image.width, after.image.width))
    await evaluate(renderer, `document.body.classList.remove('${mode}')`)
  }
  await setWide(false)
  await renderer.send('Emulation.setEmulatedMedia', { media: 'print' })
  const printBefore = await measure()
  await setWide(true)
  const printAfter = await measure()
  check('PDF打印布局不受屏幕全宽开关影响', close(printBefore.table.width, printAfter.table.width) && close(printBefore.image.width, printAfter.image.width))
  await renderer.send('Emulation.setEmulatedMedia', { media: '' })

  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await waitFor("document.getElementById('source-editor').classList.contains('visible')", '未进入源码模式')
  const sourceBefore = await evaluate(renderer, "({width:document.getElementById('source-editor').getBoundingClientRect().width,value:document.getElementById('source-editor').value})")
  await setWide(false)
  check('源码模式保持原文和列宽', await evaluate(renderer, `document.getElementById('source-editor').value === ${JSON.stringify(fixture)} && Math.abs(document.getElementById('source-editor').getBoundingClientRect().width-${sourceBefore.width}) < 1`))
  await setWide(true)
  await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
  await waitFor("!document.getElementById('source-editor').classList.contains('visible')", '未返回渲染模式')

  const firstTab = await evaluate(renderer, "document.querySelector('.tab-entry.active').dataset.tabId")
  await clickAccelerator('CmdOrCtrl+T')
  await evaluate(renderer, `window.electronAPI.openSibling(${JSON.stringify(files[1])})`)
  await waitFor(`${content} === ${JSON.stringify(secondFixture)}`, '新标签文件未载入')
  check('新文件沿用全宽开关且不标脏', await checked() && await evaluate(renderer, "document.body.classList.contains('wide-media') && !document.querySelector('.tab-entry.active').classList.contains('dirty')"))
  await setWide(false)
  await evaluate(renderer, `document.querySelector('[data-tab-id="${firstTab}"]').click()`)
  await waitFor(`${content} === ${JSON.stringify(fixture)}`, '旧标签未恢复')
  check('旧标签恢复后沿用当前关闭偏好', await evaluate(renderer, "!document.body.classList.contains('wide-media')"))
  await setWide(true)
  await clickAccelerator('CmdOrCtrl+T')
  await evaluate(renderer, `window.electronAPI.openSibling(${JSON.stringify(scratchFile)})`)
  await waitFor(`${content} === ${JSON.stringify(scratchFixture)}`, '增量编辑夹具未载入')
  const imagePosition = scratchFixture.indexOf('![')
  const scratchStandalone = "document.querySelector('img[alt=\"大图片\"]')?.closest('.cm-line')?.classList.contains('cm-md-image-standalone')"
  await waitFor(`${scratchStandalone} === true && document.querySelector('img[alt="标签空白图片"]')?.complete && document.querySelector('img[alt="真实混排图片"]')?.complete`, '空白与混排图片夹具未渲染')
  await waitFor(`parseFloat(getComputedStyle(${view}.scrollDOM).getPropertyValue('--editor-available-width')) === ${view}.scrollDOM.clientWidth && Math.abs(document.querySelector('img[alt="大图片"]').width - (${view}.scrollDOM.clientWidth - 80)) < 1`, '新文档全宽布局测量未完成')
  const whitespaceImages = await evaluate(renderer, `(() => {
    const image = alt => document.querySelector('img[alt="'+alt+'"]')
    const available = ${view}.scrollDOM.clientWidth - 80
    return {available, plain:image('大图片').width,linked:image('标签空白图片').width,mixed:image('真实混排图片').width,variable:getComputedStyle(${view}.scrollDOM).getPropertyValue('--editor-available-width'),line:image('大图片').closest('.cm-line').getBoundingClientRect().width,body:document.body.className}
  })()`)
  check('图片末尾及链接标签内纯空白不阻止扩宽', close(whitespaceImages.plain, whitespaceImages.available) && close(whitespaceImages.linked, whitespaceImages.available), whitespaceImages)
  check('真实文字混排图片保留正文最大宽度', whitespaceImages.mixed < whitespaceImages.available - 100, whitespaceImages)
  await evaluate(renderer, `${view}.dispatch({changes:{from:${imagePosition},insert:'混排文字 '},userEvent:'input.type'})`)
  await waitFor(`${scratchStandalone} === false`, '增量转为混排后残留独立图片标记')
  check('独立图片转为混排时立即恢复原容器', true)
  await setWide(false)
  await setWide(true)
  await evaluate(renderer, `${view}.focus()`)
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await renderer.send('Input.dispatchKeyEvent', {type:'keyDown',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers})
  await renderer.send('Input.dispatchKeyEvent', {type:'keyUp',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers})
  await waitFor(`${content} === ${JSON.stringify(scratchFixture)} && ${scratchStandalone} === true`, '撤销未恢复独立图片及其布局')
  check('切换视图不占正文撤销步骤，撤销恢复独立图片', true)
  await clickAccelerator('CmdOrCtrl+S')
  await waitFor("!document.querySelector('.tab-entry.active').classList.contains('dirty')", '增量测试文件未保存')
  check('增量编辑仅写入自身临时文件', readFileSync(scratchFile, 'utf8') === scratchFixture && filesUnchanged())
  await evaluate(renderer, `document.querySelector('[data-tab-id="${firstTab}"]').click()`)
  await waitFor(`${content} === ${JSON.stringify(fixture)}`, '增量验证后主夹具未恢复')
  // 新窗口沿用真实菜单入口；离屏壳会同时约束新建窗口，不能为测试同步而抢用户焦点。
  const windowIds = await evaluate(main, "require('electron').BrowserWindow.getAllWindows().map(win => win.id)")
  await clickAccelerator('CmdOrCtrl+N')
  let secondWindowId
  for (let i = 0; i < 150 && !secondWindowId; i++) {
    secondWindowId = await evaluate(main, `require('electron').BrowserWindow.getAllWindows().find(win => !${JSON.stringify(windowIds)}.includes(win.id))?.id`)
    if (!secondWindowId) await pause(100)
  }
  assert(secondWindowId, '菜单未创建第二个窗口')
  const secondExpression = expression => evaluate(main, `require('electron').BrowserWindow.fromId(${secondWindowId}).webContents.executeJavaScript(${JSON.stringify(expression)})`)
  let secondReady = false
  for (let i = 0; i < 150 && !secondReady; i++) {
    secondReady = await secondExpression("!!document.querySelector('#editor .cm-content') && document.body.classList.contains('wide-media')")
    if (!secondReady) await pause(100)
  }
  check('新窗口立即沿用已持久化全宽偏好', secondReady)
  await setWide(false)
  let secondSynced = false
  for (let i = 0; i < 150 && !secondSynced; i++) {
    secondSynced = await secondExpression("!document.body.classList.contains('wide-media') && localStorage.getItem('colamd-wide-media') === '0'")
    if (!secondSynced) await pause(100)
  }
  check('原生菜单切换同步两个窗口及持久化状态', secondSynced && await checked() === false)
  await evaluate(main, `(() => { require('electron').BrowserWindow.fromId(${secondWindowId}).webContents.send('set-wide-media', true); return true })()`)
  await waitFor("document.body.classList.contains('wide-media') && localStorage.getItem('colamd-wide-media') === '1'", '第二窗口修改没有同步首窗')
  for (let i = 0; i < 150 && !await checked(); i++) await pause(100)
  check('第二窗口修改同步首窗与原生菜单', await checked() && await secondExpression("document.body.classList.contains('wide-media') && localStorage.getItem('colamd-wide-media') === '1'"))
  await evaluate(main, `(() => { require('electron').BrowserWindow.fromId(${secondWindowId}).close(); return true })()`)
  let secondClosed = false
  for (let i = 0; i < 100 && !secondClosed; i++) {
    secondClosed = await evaluate(main, `!require('electron').BrowserWindow.fromId(${secondWindowId})`)
    if (!secondClosed) await pause(100)
  }
  check('第二窗口正常关闭且主窗口保持干净', secondClosed && await evaluate(renderer, `${content} === ${JSON.stringify(fixture)} && !document.querySelector('.tab-entry.active').classList.contains('dirty')`))
  await evaluate(main, `(() => {
    const { Menu, BrowserWindow } = require('electron')
    const flatten = menu => menu.items.flatMap(item => [item,...(item.submenu ? flatten(item.submenu) : [])])
    const item = flatten(Menu.getApplicationMenu()).find(item => item.label === 'English')
    item.click(item, BrowserWindow.fromId(${primaryWindowId}))
  })()`)
  for (let i = 0; i < 100; i++) {
    if (await evaluate(main, "require('electron').Menu.getApplicationMenu().getMenuItemById('wide-media').label === 'Full-width Tables, Images and Mermaid'")) break
    await pause(100)
  }
  check('英文菜单文案与勾选状态同步', await evaluate(main, "(() => { const item = require('electron').Menu.getApplicationMenu().getMenuItemById('wide-media');return item.label === 'Full-width Tables, Images and Mermaid' && item.checked })()"))
  await pause(1200)
  check('开关、主题与布局变化不修改文档或触发保存', filesUnchanged() && await evaluate(renderer, `${content} === ${JSON.stringify(fixture)} && !document.querySelector('.tab-entry.active').classList.contains('dirty')`))
  await closeApp()
  await pause(200)
  await launch(files[0])
  await waitFor("document.body.classList.contains('wide-media')", '重启没有恢复全宽偏好')
  check('重启恢复全宽偏好和菜单勾选', await checked())
  await pause(1200)
  check('重启应用偏好仍保留文件字节和修改时间', filesUnchanged())
  await closeApp()
  console.log(`全宽视图真机验收通过，共 ${passed} 项。`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  renderer?.close(); main?.close()
  child?.kill('SIGTERM')
  stopVerifyApp(udd)
}
