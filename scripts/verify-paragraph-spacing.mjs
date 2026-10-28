#!/usr/bin/env node
// 真实 Electron 离屏验收；--baseline 只记录改动前的排版，不断言收紧。
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
const { dir, udd } = verifyWorkdir('paragraph-spacing')
const baseline = process.argv.includes('--baseline')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const fixture = [
  '# 排版验收', '',
  '普通单行甲。', '', '普通单行乙。', '',
  '自动折行：' + '一段文字在窗口变窄之后仍然属于同一段。'.repeat(22),
  '手动续行第一行。', '手动续行第二行。  ', '硬换行之后的正文。', '',
  '> 引用第一行。', '> 引用第二行。  ', '> 引用硬换行之后。', '>',
  '> 引用另一段。', '> > 嵌套引用第一行。', '> > 嵌套引用第二行。', '> >', '> > 嵌套引用后段。', '>',
  '> ## 引用标题', '>', '> ```js', '> const quoted = 1', '> ```', '',
  '> 引用单行甲。', '>', '> 引用单行乙。', '>',
  '> 引用自动折行：' + '引用文字在窗口变窄之后仍然属于同一段。'.repeat(22), '>',
  '> 引用边界末段。', '', '引用外正文。', '', '> 标题前引用。', '## 引用外标题', '',
  '| 单行表头 |', '| --- |', '| 单行单元格 |', '',
  '| 自动表头：' + '表格内的长内容应自然换行。'.repeat(30) + ' |', '| --- |',
  '| 自动单元格：' + '表格内的长内容应自然换行。'.repeat(30) + ' |', '',
  '| 换行表头甲<br>换行表头乙 |', '| --- |', '| 换行单元格甲<br>换行单元格乙 |', '',
  '| 混排表头：家庭 `come` 到位即完成。<br>混排表头第二行。 |', '| --- |', '| 混排单元格：家庭 `follow` 持续陪伴。<br>混排单元格第二行。 |', '',
  '> 混排引用：' + '家庭 `come` 到位即完成，`follow` 持续陪伴。'.repeat(12), '',
  '- 列表第一行。', '  列表续行。', '',
  '```js', 'const ordinary = 1', '```', '',
  '一次接待具有同一管理员入口、客人上下文和持续陪伴目标，由一个任务连续维护介绍、欢迎与陪伴的业务阶段。客人接待不包住整个 CES 展示：编队表演具有独立时间、站位和结束目标，仍独立；聊天、保护、IoT 和远程访问也有各自宿主。', '',
  '家庭 `come` 到位即完成，`follow` 则持续陪伴，完成标准不同；`invite` 可以无回应结束，`ball` 可以由主动来球直接开始，因此保留这些独立任务。接待期间的过来、抚摸和托下巴是接待内部业务分支，不创建同名子任务，也不新增父子调度或第二主任务槽。家庭与接待之外仍使用原独立任务。', '',
  '**状态机阅读约定**', '',
  '本文分开描述任务生命周期、运行期间的业务状态及任务之间的切换。图中实线节点表示需要持续维护的状态；`<<choice>>` 是当次事件处理中完成的条件分支，不是持久业务状态。边统一按“事件 [条件] / 动作”阅读；长条件可用转移表中的编号引用。未接纳的候选、准入检查和技能内部寻找／避障均不作为任务业务状态。', '',
  '增量编辑第一段。', '', '增量编辑第二段。', ''
].join('\n')
const file = join(dir, '段内行距.md')
writeFileSync(file, fixture)
const originalTime = statSync(file).mtimeMs
const port = 24400 + Math.floor(Math.random() * 200)
const inspectPort = port + 1000
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child, renderer, main, passed = 0

// 调试请求超时或连接关闭都必须使验收失败。
async function connect(portNumber, type) {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json()).find(item => item.type === type)
    } catch { /* 等待 Electron 启动。 */ }
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`调试请求超时：${method}`)) }, 15000)
        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close()
  }
}

// 返回可序列化结果，并且保留页面中的异常。
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 等待可观察状态，避免用固定延时判定渲染完成。
async function waitFor(expression, message) {
  for (let i = 0; i < 120; i++) {
    if (await evaluate(renderer, expression)) return
    await pause(100)
  }
  throw new Error(message)
}

// 行高与行盒允许 0.15px 取整；两侧字体基线分别量化的段落边缘允许合计 1px。
function close(actual, expected) {
  return Math.abs(actual - expected) < 0.15
}

// 每项失败都带实际测量，便于区分实现错误和夹具错误。
function check(name, ok, detail) {
  assert(ok, `${name}${detail === undefined ? '' : `：${JSON.stringify(detail)}`}`)
  passed++
  console.log(`通过：${name}`)
}

// 通过真实主题菜单切换，保留应用主题的字体和继承路径。
async function setTheme(theme) {
  await evaluate(main, `(() => {
    const { Menu, BrowserWindow } = require('electron')
    const item = Menu.getApplicationMenu().getMenuItemById('theme-${theme}')
    if (!item) throw new Error('主题菜单缺失')
    item.click(item, BrowserWindow.getAllWindows()[0])
  })()`)
  await waitFor(`document.body.classList.contains('theme-${theme}')`, '主题未切换')
}

// 以字形矩形测内部行距和段落边界，避免只检查行盒或类名。
const measure = `(() => {
  const content = document.querySelector('#editor .cm-content')
  const lines = [...content.querySelectorAll('.cm-line')]
  const line = token => lines.find(item => item.textContent.includes(token))
  const number = (element, property) => parseFloat(getComputedStyle(element)[property])
  const geometry = element => {
    if (!element) throw new Error('夹具元素未渲染')
    // 跳过行内代码的不同字体盒，按正文文字本身测自动折行，避免把同一行的字体差当成换行。
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const rects = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!node.textContent.trim() || node.parentElement.closest('.cm-md-inlinecode, code')) continue
      const range = document.createRange(); range.selectNodeContents(node)
      rects.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0))
    }
    const tops = [...new Set(rects.map(rect => Math.round(rect.top * 100) / 100))].sort((a,b) => a-b)
    const box = element.getBoundingClientRect()
    return {
      lineHeight:number(element, 'lineHeight'), fontSize:number(element,'fontSize'),
      parentLineHeight:number(element.parentElement,'lineHeight'), parentFontSize:number(element.parentElement,'fontSize'),
      boxTop:box.top, boxBottom:box.bottom, height:box.height, paddingTop:number(element,'paddingTop'), paddingBottom:number(element,'paddingBottom'),
      textTop:Math.min(...rects.map(rect=>rect.top)), textBottom:Math.max(...rects.map(rect=>rect.bottom)),
      step:tops.length>1?tops[1]-tops[0]:null, count:tops.length,
      paragraph:element.classList.contains('cm-md-paragraph')
    }
  }
  const sample = token => geometry(line(token))
  const gap = (before,after) => sample(after).textTop-sample(before).textBottom
  const quoteA = sample('引用第一行。'), quoteB = sample('引用第二行。')
  const quoteSeparator = line('引用硬换行之后。').nextElementSibling
  return {
    parent:number(content, 'lineHeight'),fontSize:number(content, 'fontSize'),
    typedLineHeight:(() => {const value=content.computedStyleMap().get('line-height');return {type:value.constructor.name,unit:value.unit,value:value.value,text:value.toString()}})(),
    samples:['自动折行：','手动续行第一行。','手动续行第二行。','硬换行之后的正文。','引用第一行。','引用第二行。','引用硬换行之后。','引用另一段。','嵌套引用第一行。','嵌套引用第二行。','列表第一行。','列表续行。'].map(sample),
    wrapped:sample('自动折行：'),quoteWrapped:sample('引用自动折行：'),mixedQuote:sample('混排引用：'),singleQuote:sample('引用单行甲。'),
    quoteStep:quoteB.textTop-quoteA.textTop,
    manualStep:sample('手动续行第二行。').textTop-sample('手动续行第一行。').textTop,
    hardStep:sample('硬换行之后的正文。').textTop-sample('手动续行第二行。').textTop,
    nestedStep:sample('嵌套引用第二行。').textTop-sample('嵌套引用第一行。').textTop,
    singlePlain:sample('普通单行甲。'),
    boundaryRows:['硬换行之后的正文。','引用第一行。','引用边界末段。','引用外正文。','标题前引用。','引用外标题'].map(token=>({token,...sample(token),html:line(token).outerHTML})),
    userParagraphs:['一次接待具有','完成标准不同','本文分开描述'].map(sample),
    userGaps:[gap('一次接待具有','完成标准不同'),gap('完成标准不同','状态机阅读约定'),gap('状态机阅读约定','本文分开描述')],
    gaps:[gap('普通单行甲。','普通单行乙。'),gap('普通单行乙。','自动折行：'),gap('硬换行之后的正文。','引用第一行。'),gap('引用硬换行之后。','引用另一段。'),gap('嵌套引用第二行。','嵌套引用后段。'),gap('引用单行甲。','引用单行乙。'),gap('引用单行乙。','引用自动折行：'),gap('引用自动折行：','引用边界末段。'),gap('引用边界末段。','引用外正文。'),gap('标题前引用。','引用外标题')],
    separator:{height:quoteSeparator.getBoundingClientRect().height,paragraph:quoteSeparator.classList.contains('cm-md-paragraph')},
    heading:sample('引用标题'),code:sample('const quoted = 1'),plainCode:sample('const ordinary = 1'),
    cells:['单行表头','单行单元格','自动表头：','自动单元格：','换行表头甲','换行单元格甲','混排表头：','混排单元格：'].map(token=>geometry([...content.querySelectorAll('th,td')].find(item=>item.textContent.includes(token)))),
    empty:lines.filter(item => item.textContent.trim() === '' && !item.classList.contains('cm-md-codeblock')).map(item => item.getBoundingClientRect().height)
  }
})()`
// 对照是本轮修改前已交付的排版，使用固定公式，避免新 CSS 变量改变基线。
const previousCSS = `
#editor .cm-content .cm-md-inlinecode,#editor .cm-content .cm-md-table-widget code {line-height:inherit!important}
#editor .cm-content .cm-md-paragraph {line-height:calc(1lh * 1.6 / 1.75)!important;padding-top:0!important;padding-bottom:0!important}
#editor .cm-content .cm-md-blockquote.cm-md-paragraph {line-height:calc(1lh * 1.6 / 1.75 * .9)!important}
#editor .cm-content .cm-md-blockquote.cm-md-paragraph-first {padding-top:calc(1lh / 18)!important}
#editor .cm-content .cm-md-blockquote.cm-md-paragraph-last {padding-bottom:calc(1lh / 18)!important}
#editor .cm-content .cm-md-table-widget th,#editor .cm-content .cm-md-table-widget td {line-height:calc(var(--md-body-line-height) * .9)!important;padding-top:calc(8px + 1lh / 18)!important;padding-bottom:calc(8px + 1lh / 18)!important}`

// 真实菜单只切换视图偏好，开关后的字形间距仍须与相同开关状态的基线比较。
async function setHidden(enabled) {
  await evaluate(main, `(() => {
    const {Menu,BrowserWindow}=require('electron')
    const item=Menu.getApplicationMenu().getMenuItemById('hide-blank-lines')
    if(item.checked!==${enabled}) item.click(item,BrowserWindow.getAllWindows()[0])
  })()`)
  await waitFor(`localStorage.getItem('colamd-hide-blank-lines')==='${enabled ? '1' : '0'}'`, '隐藏空行偏好未更新')
}

// 临时注入旧规则，测完立即移除，不动文档和应用偏好。
async function measurePrevious() {
  return evaluate(renderer, `(() => {
    const style=document.createElement('style');style.textContent=${JSON.stringify(previousCSS)};document.head.appendChild(style)
    const measured=${measure};style.remove();return measured
  })()`)
}

// 走原生菜单应用自定义主题时使用的真实 IPC 和 applyTheme，避免只在 DOM 注入 CSS。
async function applyCustomTheme(name, css) {
  await evaluate(main, `(() => {
    const win=require('electron').BrowserWindow.getAllWindows()[0]
    win.webContents.send('set-theme',${JSON.stringify(`custom:${name}`)})
    win.webContents.send('set-custom-css',${JSON.stringify(css)})
  })()`)
  await waitFor(`document.body.classList.contains('theme-custom')&&localStorage.getItem('colamd-theme')===${JSON.stringify(`custom:${name}`)}`, '自定义主题未通过应用路径生效')
}

try {
  child = spawn(require('electron'), [
    'scripts/offscreen-window.cjs', file, `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'
  ], { cwd: root, env, stdio: 'ignore' })
  renderer = await connect(port, 'page')
  main = await connect(inspectPort, 'node')
  await waitFor(`${view}?.state.doc.toString() === ${JSON.stringify(fixture)}`, '夹具未加载')
  await evaluate(renderer, `(() => { const v = ${view}; v.viewState.printing = true; v.requestMeasure() })()`)
  await waitFor("[...document.querySelectorAll('#editor .cm-line')].some(line => line.textContent.includes('增量编辑第二段'))", '整篇夹具未渲染')
  const records = []
  for (const theme of ['light', 'dark', 'elegant', 'sepia', 'writer']) {
    await setTheme(theme)
    const metrics = await evaluate(renderer, measure)
    records.push({ theme, parent:metrics.parent, paragraph:metrics.samples[0].lineHeight, quote:metrics.samples[4].lineHeight, quoteWrapped:metrics.quoteWrapped.step, cells:metrics.cells.map(cell=>({lineHeight:cell.lineHeight,fontSize:cell.fontSize,parentLineHeight:cell.parentLineHeight,parentFontSize:cell.parentFontSize,count:cell.count,height:cell.height})) })
    if (baseline) continue
    const restored = await measurePrevious()
    Object.assign(records.at(-1), {
      maxParagraphGapDelta:Math.max(...metrics.gaps.map((gap,index)=>Math.abs(gap-restored.gaps[index]))),
      maxSingleCellHeightDelta:Math.max(...metrics.cells.slice(0,2).map((cell,index)=>Math.abs(cell.height-restored.cells[index].height)))
    })
    const expected = metrics.parent * 1.6 / 1.75 * .9
    check(`${theme} 普通段落与列表续行实际行高再缩小百分之十`, [0,1,2,3,10,11].every(index=>metrics.samples[index].paragraph&&close(metrics.samples[index].lineHeight,expected)), metrics)
    check(`${theme} 引用与嵌套引用段内行高再收紧百分之十`, [4,5,6,7,8,9].every(index=>metrics.samples[index].paragraph&&close(metrics.samples[index].lineHeight,restored.samples[index].lineHeight*.9)), metrics)
    check(`${theme} 正文自动折行、手动换行与硬换行均再缩小百分之十`, metrics.wrapped.step!==null&&close(metrics.wrapped.step,restored.wrapped.step*.9)&&close(metrics.manualStep,restored.manualStep*.9)&&close(metrics.hardStep,restored.hardStep*.9),metrics.wrapped)
    check(`${theme} 引用自动折行与手动换行的实际字形间距再收紧百分之十`,metrics.quoteWrapped.step!==null&&close(metrics.quoteWrapped.step,restored.quoteWrapped.step*.9)&&close(metrics.quoteStep,restored.quoteStep*.9)&&close(metrics.nestedStep,restored.nestedStep*.9),{current:metrics.quoteStep,previous:restored.quoteStep,wrapped:metrics.quoteWrapped.step})
    check(`${theme} 段落首尾补偿保留普通及引用单行高度与真实段落间距`,close(metrics.singleQuote.height,restored.singleQuote.height)&&close(metrics.singlePlain.height,restored.singlePlain.height)&&metrics.gaps.every((gap,index)=>Math.abs(gap-restored.gaps[index])<1),{current:metrics.gaps,previous:restored.gaps,single:metrics.singleQuote})
    check(`${theme} 引用空行、普通空行、标题与代码保持原尺寸`, !metrics.separator.paragraph&&close(metrics.separator.height,metrics.parent)&&metrics.empty.every(height=>close(height,metrics.parent))&&close(metrics.heading.height,restored.heading.height)&&close(metrics.code.height,restored.code.height)&&close(metrics.plainCode.height,restored.plainCode.height),metrics.separator)
    check(`${theme} 表格表头与单元格行高按真实旧值缩小百分之十`,metrics.cells.every((cell,index)=>close(cell.lineHeight,restored.cells[index].lineHeight*.9)),{current:metrics.cells,previous:restored.cells})
    check(`${theme} 表格单行总高度不变，多行只减少内部间隔`,metrics.cells.slice(0,6).every((cell,index)=>cell.count===restored.cells[index].count&&close(cell.height,restored.cells[index].height-(cell.count-1)*restored.cells[index].lineHeight*.1)),{current:metrics.cells,previous:restored.cells})
    check(`${theme} 表头及单元格自动折行与br实际字形间距缩小百分之十`,metrics.cells.slice(2,6).every((cell,index)=>cell.step!==null&&close(cell.step,restored.cells[index+2].step*.9)),metrics.cells)
    check(`${theme} 用户原文段内自动折行再缩小百分之十且跨段距离不变`,metrics.userParagraphs.every((paragraph,index)=>paragraph.step!==null&&(index===1 ? close(paragraph.step,paragraph.lineHeight)&&paragraph.step<restored.userParagraphs[index].step : close(paragraph.step,restored.userParagraphs[index].step*.9)))&&metrics.userGaps.every((gap,index)=>Math.abs(gap-restored.userGaps[index])<1),{current:metrics.userGaps,previous:restored.userGaps,currentParagraphs:metrics.userParagraphs,previousParagraphs:restored.userParagraphs})
    check(`${theme} 混排行内代码的引用和表格实际步长等于容器行高`,close(metrics.mixedQuote.step,metrics.mixedQuote.lineHeight)&&metrics.cells.slice(6).every(cell=>close(cell.step,cell.lineHeight)),{quote:metrics.mixedQuote,cells:metrics.cells.slice(6)})
    await setHidden(true)
    const compact=await evaluate(renderer,measure)
    const oldCompact=await measurePrevious()
    check(`${theme} 隐藏空行后仍只收紧段内换行，段落边缘和用户原文跨段间距保持`,compact.empty.every(height=>height===0)&&compact.gaps.every((gap,index)=>Math.abs(gap-oldCompact.gaps[index])<1)&&compact.userGaps.every((gap,index)=>Math.abs(gap-oldCompact.userGaps[index])<1)&&close(compact.manualStep,oldCompact.manualStep*.9)&&close(compact.nestedStep,oldCompact.nestedStep*.9),{current:compact.gaps,previous:oldCompact.gaps,user:compact.userGaps,oldUser:oldCompact.userGaps})
    await setHidden(false)

  }
  console.log(`真实窗口行距测量：${JSON.stringify(records)}`)
  if (!baseline) {
    const customRecords = []
    const legacyWriter = '#editor .cm-content{font-size:15px;line-height:1.8} #editor .cm-md-table-widget th,#editor .cm-md-table-widget td{font-size:0.9em}'
    const customThemes = [
      {name:'旧版作家主题.css',css:legacyWriter,cellFont:13.5,oldLineHeight:24.3},
      {name:'当前作家主题.css',css:readFileSync(join(root,'themes/writer.css'),'utf8'),cellFont:13.5,oldLineHeight:24.3},
      {name:'固定像素主题.css',css:'#editor .cm-content{font-size:16px;line-height:30px}@media(min-width:1px){#editor .cm-content{line-height:32px}}',cellFont:16,oldLineHeight:32},
      {name:'相对长度主题.css',css:'#editor .cm-content{font-size:16px;line-height:2em} #editor .cm-md-table-widget th,#editor .cm-md-table-widget td{font-size:0.9em}',cellFont:14.4,oldLineHeight:32},
      {name:'百分比行高主题.css',css:'#editor .cm-content{font-size:16px;line-height:200%} #editor .cm-md-table-widget th,#editor .cm-md-table-widget td{font-size:0.9em}',cellFont:14.4,oldLineHeight:32},
      {name:'计算倍率主题.css',css:'#editor .cm-content{font-size:15px;line-height:calc(1.8)} #editor .cm-md-table-widget th,#editor .cm-md-table-widget td{font-size:0.9em}',cellFont:13.5,oldLineHeight:24.3},
      {name:'变量倍率主题.css',css:'#editor .cm-content{font-size:15px;--reading-line-height:1.8;line-height:var(--reading-line-height)} #editor .cm-md-table-widget th,#editor .cm-md-table-widget td{font-size:0.9em}',cellFont:13.5,oldLineHeight:24.3},
      {name:'编辑器作用域倍率主题.css',css:'#editor .cm-editor{--reading-line-height:1.8} #editor .cm-content{font-size:15px;line-height:var(--reading-line-height)} #editor .cm-md-table-widget th,#editor .cm-md-table-widget td{font-size:0.9em}',cellFont:13.5,oldLineHeight:24.3}
    ]
    for (const theme of customThemes) {
      await applyCustomTheme(theme.name,theme.css)
      const current = await evaluate(renderer, measure)
      const previous = await measurePrevious()
      customRecords.push({name:theme.name,parent:current.parent,typedLineHeight:current.typedLineHeight,cellFont:current.cells[0].fontSize,oldCellLineHeight:previous.cells[0].lineHeight,newCellLineHeight:current.cells[0].lineHeight,maxSingleCellHeightDelta:Math.max(...current.cells.slice(0,2).map((cell,index)=>Math.abs(cell.height-previous.cells[index].height)))})
      console.log(`自定义主题真实测量：${JSON.stringify(customRecords.at(-1))}`)
      check(`${theme.name} 通过真实应用路径保留字号并按旧行高缩小百分之十`,current.cells.every((cell,index)=>close(cell.fontSize,theme.cellFont)&&close(previous.cells[index].lineHeight,theme.oldLineHeight*.9)&&close(cell.lineHeight,previous.cells[index].lineHeight*.9)),customRecords.at(-1))
      check(`${theme.name} 单行单元格总高度保持`,current.cells.slice(0,2).every((cell,index)=>close(cell.height,previous.cells[index].height)),customRecords.at(-1))
      check(`${theme.name} 自动折行和br实际行距缩小百分之十`,current.cells.slice(2,6).every((cell,index)=>cell.count===previous.cells[index+2].count&&cell.step!==null&&close(cell.step,previous.cells[index+2].step*.9)),customRecords.at(-1))
    }
    // 重载时主题先于编辑器创建；测试进程内替换 CSS 读取，避免改用户的主题目录。
    await evaluate(main, `(async () => {
      const {ipcMain,BrowserWindow}=require('electron'),win=BrowserWindow.getAllWindows()[0]
      globalThis.__initialThemeEditorCount=null
      ipcMain.removeHandler('load-theme-css')
      ipcMain.handle('load-theme-css',async()=>{
        globalThis.__initialThemeEditorCount=await win.webContents.executeJavaScript("document.querySelectorAll('#editor .cm-content').length")
        return ${JSON.stringify(customThemes.at(-1).css)}
      })
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload()})
      return true
    })()`)
    await waitFor(`${view}?.state.doc.toString()===${JSON.stringify(fixture)}&&document.body.classList.contains('theme-custom')`, '初次加载未恢复夹具或自定义主题')
    await evaluate(renderer, `(() => {const v=${view};v.viewState.printing=true;v.requestMeasure()})()`)
    await waitFor("document.querySelectorAll('#editor .cm-md-table-widget').length===4", '初次加载未渲染完整表格')
    const initial=await evaluate(renderer,measure)
    check('初次应用主题确实发生在编辑器创建前',await evaluate(main,'globalThis.__initialThemeEditorCount===0'))
    check('初次加载保留编辑器作用域变量及小字号单元格行高',initial.cells.every(cell=>close(cell.fontSize,13.5)&&close(cell.lineHeight,19.683)),initial.cells)
    await setTheme('light')
    const before = await evaluate(renderer, `${view}.state.doc.toString()`)
    await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
    await waitFor("document.getElementById('source-editor').classList.contains('visible')", '未进入源码模式')
    check('源码模式完整保留原文', await evaluate(renderer, `document.getElementById('source-editor').value === ${JSON.stringify(before)}`))
    await evaluate(renderer, "document.getElementById('source-toggle-btn').click()")
    await waitFor("!document.getElementById('source-editor').classList.contains('visible')", '未恢复渲染模式')
    await evaluate(renderer, `(() => { const v = ${view}; v.viewState.printing = true; v.requestMeasure() })()`)
    await waitFor("document.querySelector('#editor .cm-md-paragraph') !== null", '恢复渲染后缺少段落装饰')
    const exported = await evaluate(renderer, `(() => {
      const article = document.createElement('article')
      article.className = 'colamd-document'
      article.innerHTML = window.__colamdExportDocumentHTML()
      document.body.appendChild(article)
      const result = [...article.querySelectorAll('p')].map(item => ({parent:parseFloat(getComputedStyle(item.parentElement).lineHeight),lineHeight:parseFloat(getComputedStyle(item).lineHeight),quoted:!!item.closest('blockquote')}))
      const quotes = article.querySelectorAll('blockquote p').length
      const wrapped = [...article.querySelectorAll('p')].find(item => item.textContent.includes('自动折行：'))
      const range = document.createRange()
      range.selectNodeContents(wrapped)
      const tops = [...new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top * 100) / 100))].sort((a,b) => a-b)
      const wrappedStep = tops.length > 1 ? tops[1]-tops[0] : null
      const geometry = element => {
        const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),rects=[]
        while(walker.nextNode()) {const node=walker.currentNode;if(!node.textContent.trim()||node.parentElement.closest('code'))continue;const range=document.createRange();range.selectNodeContents(node);rects.push(...[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0))}
        const tops=[...new Set(rects.map(rect=>Math.round(rect.top*100)/100))].sort((a,b)=>a-b)
        const box=element.getBoundingClientRect()
        return {height:box.height,lineHeight:parseFloat(getComputedStyle(element).lineHeight),step:tops.length>1?tops[1]-tops[0]:null,count:tops.length,topGap:Math.min(...rects.map(rect=>rect.top))-box.top,bottomGap:box.bottom-Math.max(...rects.map(rect=>rect.bottom))}
      }
      const quote=[...article.querySelectorAll('blockquote p')].find(item=>item.textContent.includes('引用自动折行：'))
      const elements=[quote,...article.querySelectorAll('th,td'),wrapped]
      const current=elements.map(geometry)
      const mixedElements=[...article.querySelectorAll('p,th,td')].filter(item=>item.textContent.includes('混排引用：')||item.textContent.startsWith('家庭 ')||item.textContent.includes('混排表头：')||item.textContent.includes('混排单元格：'))
      const mixed=mixedElements.map(geometry)
      const codeBlocks=[...article.querySelectorAll('pre code')].map(item=>({lineHeight:parseFloat(getComputedStyle(item).lineHeight),fontSize:parseFloat(getComputedStyle(item).fontSize)}))
      const style=document.createElement('style')
      style.textContent='.colamd-document p code,.colamd-document td code,.colamd-document th code{line-height:inherit!important}.colamd-document p{line-height:calc(1lh * 1.6 / 1.75)!important;padding-top:0!important;padding-bottom:0!important}.colamd-document blockquote p{line-height:calc(1lh * 1.6 / 1.75 * .9)!important;padding-top:calc(1lh / 18)!important;padding-bottom:calc(1lh / 18)!important}.colamd-document th,.colamd-document td{line-height:calc(1lh * .9)!important;padding-top:calc(8px + 1lh / 18)!important;padding-bottom:calc(8px + 1lh / 18)!important}'
      document.head.appendChild(style)
      const previous=elements.map(geometry)
      style.remove();article.remove()
      return {paragraphs:result,quotes,wrappedStep,current,previous,mixed,codeBlocks}
    })()`)
    check('HTML 语义导出正文与引用段落使用紧凑行距', exported.quotes > 0 && exported.paragraphs.length > 0 && exported.paragraphs.every(item => close(item.lineHeight, item.parent * 1.6 / 1.75 * (item.quoted ? .81 : .9))), exported)
    check('HTML 导出长段落自动折行的实际字形行距同步收紧', exported.wrappedStep !== null && close(exported.wrappedStep, exported.paragraphs[0].lineHeight), exported)
    check('HTML 引用自动折行收紧百分之十且段落首尾留白不变', exported.current[0].step!==null&&close(exported.current[0].step,exported.previous[0].step*.9)&&Math.abs(exported.current[0].topGap-exported.previous[0].topGap)<.5&&Math.abs(exported.current[0].bottomGap-exported.previous[0].bottomGap)<.5,exported)
    check('HTML 表格保留单行高度并仅收紧多行内部间隔',exported.current.slice(1,7).every((cell,index)=>{const old=exported.previous[index+1];return close(cell.lineHeight,old.lineHeight*.9)&&cell.count===old.count&&close(cell.height,old.height-(cell.count-1)*old.lineHeight*.1)&&(cell.step===null||close(cell.step,old.step*.9))}),exported)
    check('HTML 普通正文自动折行再缩小百分之十且段落首尾留白保持',close(exported.current.at(-1).step,exported.previous.at(-1).step*.9)&&Math.abs(exported.current.at(-1).topGap-exported.previous.at(-1).topGap)<.5&&Math.abs(exported.current.at(-1).bottomGap-exported.previous.at(-1).bottomGap)<.5,exported.current.at(-1))
    check('HTML 正文、引用和单元格的代码混排不撑高实际行距，代码块沿用原行高',exported.mixed.length>=4&&exported.mixed.every(item=>close(item.step,item.lineHeight))&&exported.codeBlocks.length>0&&exported.codeBlocks.every(item=>close(item.lineHeight,item.fontSize*1.6)),{mixed:exported.mixed,codeBlocks:exported.codeBlocks})
    await pause(1200)
    check('排版、主题与模式切换不标记文档已编辑', await evaluate(renderer, `!document.querySelector('.tab-entry.active').classList.contains('dirty') && ${view}.state.doc.toString() === ${JSON.stringify(fixture)}`))
    check('排版不改文件字节和修改时间', readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalTime)
    // 在未命名标签测试增量编辑，不让原夹具受到自动保存影响。
    await evaluate(main, `(() => { const {Menu,BrowserWindow}=require('electron'); const flatten=menu=>menu.items.flatMap(item=>[item,...(item.submenu?flatten(item.submenu):[])]); const item=flatten(Menu.getApplicationMenu()).find(item=>item.accelerator==='CmdOrCtrl+T'); item.click(item,BrowserWindow.getAllWindows()[0]) })()`)
    await waitFor(`${view}?.state.doc.length === 0`, '未创建未命名测试标签')
    await evaluate(renderer, `${view}.dispatch({changes:{from:0,insert:${JSON.stringify('甲\n\n乙')}},userEvent:'input.type'})`)
    await waitFor("document.querySelectorAll('#editor .cm-md-paragraph').length === 2", '初始两段未被识别')
    await evaluate(renderer, `${view}.dispatch({changes:{from:2,to:3},userEvent:'delete.backward'})`)
    await waitFor("document.querySelectorAll('#editor .cm-line').length === 2", '删除空行后未合段')
    check('删除空行合段后两行均保持紧凑行高', await evaluate(renderer, "[...document.querySelectorAll('#editor .cm-line')].every(item => item.classList.contains('cm-md-paragraph') && parseFloat(getComputedStyle(item).lineHeight) < parseFloat(getComputedStyle(item.parentElement).lineHeight))"))
    await evaluate(renderer, `${view}.dispatch({changes:{from:2,insert:${JSON.stringify('\n')}},userEvent:'input.type'})`)
    await waitFor("document.querySelectorAll('#editor .cm-line').length === 3", '插入空行后未拆段')
    check('插入空行拆段后仅空行恢复段落间距', await evaluate(renderer, "(() => { const lines=[...document.querySelectorAll('#editor .cm-line')];return lines[0].classList.contains('cm-md-paragraph')&&!lines[1].classList.contains('cm-md-paragraph')&&lines[2].classList.contains('cm-md-paragraph')&&lines[1].getBoundingClientRect().height>0&&parseFloat(getComputedStyle(lines[0]).lineHeight)<lines[0].getBoundingClientRect().height })()"))
    console.log(`段内行距真机验收通过，共 ${passed} 项。`)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  renderer?.close(); main?.close()
  child?.kill('SIGTERM')
  stopVerifyApp(udd)
}
