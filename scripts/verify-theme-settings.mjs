#!/usr/bin/env node
// 真实 Electron 窗口验收主题配置，测试窗口始终离屏且不抢焦点。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const baselineMode = process.argv.includes('--baseline')
const baselinePath = process.env.COLAMD_THEME_BASELINE ?? '/tmp/colamd-theme-settings-baseline.json'
assertBuildFresh()
const { dir, udd } = verifyWorkdir('theme-settings')
const file = join(dir, '主题配置验收.md')
const fixture = [
  '# 一级标题', '', '## 二级标题', '', '### 三级标题', '', '#### 四级标题', '',
  '##### 五级标题', '', '###### 六级标题', '',
  '正文 **加粗文字**、*斜体文字*、~~删除文字~~、[链接文字](https://example.com)、`行内代码`、==高亮文字==。', '',
  '> 引用正文', '', '- 列表正文', '',
  '| 表头内容 |', '| --- |', '| 单元内容 |', '',
  '```js', 'const sample = "code" // comment', '```', '', '---', '',
  '自动换行测量：' + '同一段落中的文字应当自动换行且独立控制行高。'.repeat(18), '',
  '后续段落测量。', ''
].join('\n')
writeFileSync(file, fixture)
const originalTime = statSync(file).mtimeMs
const port = 26300 + Math.floor(Math.random() * 200)
const inspectPort = port + 500
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, renderer, main, passed = 0
const createdThemeIds = new Set()
const createdLegacyFiles = new Set()
const createdRecoveryFiles = new Set()
const testThemeId = `user-verify-${Date.now()}`

// 调试连接按真实消息响应判定，断连与超时直接使测试失败。
async function connect(portNumber, type, targetId) {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json())
        .find(item => item.type === type && (!targetId || item.id === targetId))
    } catch { /* 等待应用启动。 */ }
    if (!target) await pause(200)
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

// 保留页面中的异常详情，避免把执行失败误判成空结果。
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 只等待可观察状态，不使用固定延时断言成功。
async function waitFor(expression, message, client = renderer) {
  for (let i = 0; i < 120; i++) {
    if (await evaluate(client, expression)) return
    await pause(100)
  }
  throw new Error(message)
}

// 失败时携带实际值，定位样式差异而不是只报告布尔值。
function check(name, ok, detail) {
  assert(ok, `${name}${detail === undefined ? '' : `：${JSON.stringify(detail)}`}`)
  passed++
  console.log(`通过：${name}`)
}

// 从主进程发送现有主题选择事件，覆盖 renderer 的真实主题加载链路。
async function setTheme(id) {
  await evaluate(main, `(globalThis.__themeVerifyWindow??require('electron').BrowserWindow.getAllWindows()[0]).webContents.send('set-theme',${JSON.stringify(id)})`)
  await waitFor(`localStorage.getItem('colamd-theme')===${JSON.stringify(id)}`, '主题未切换')
  await evaluate(renderer, `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
}

// 界面语言走原生菜单回调，名称断言直接读取主题配置而不绑定具体文案。
async function verifyThemeNames() {
  const originalLanguage=await evaluate(renderer,'window.electronAPI.getLanguage()')
  const builtinThemes=JSON.parse(readFileSync(join(root,'src/shared/builtin-themes.json'),'utf8'))
  const library=await evaluate(renderer,'window.electronAPI.listThemeDefinitions()')
  const definitions=new Map([...builtinThemes,...library].map(theme=>[theme.id,theme]))
  const expected=Object.fromEntries(builtinThemes.map(theme=>[theme.id,definitions.get(theme.id).name]))
  const selectLanguage=async language=>{
    const label=language==='zh'?'中文':'English'
    await evaluate(main,`(() => {const {Menu}=require('electron'),flatten=menu=>menu.items.flatMap(item=>[item,...(item.submenu?flatten(item.submenu):[])]),item=flatten(Menu.getApplicationMenu()).find(item=>item.label===${JSON.stringify(label)});if(!item)throw new Error('未找到界面语言菜单');globalThis.__themeNamesPreviousMenu=Menu.getApplicationMenu();item.click(item,globalThis.__themeVerifyWindow)})()`)
    await waitFor(`require('electron').Menu.getApplicationMenu()!==globalThis.__themeNamesPreviousMenu`, '界面语言菜单未重建',main)
    await waitFor(`document.documentElement.lang===${JSON.stringify(language==='zh'?'zh-CN':'en')}`, '渲染窗口界面语言未更新')
  }
  try {
    for(const language of ['zh','en']) {
      await selectLanguage(language)
      const menuNames=await evaluate(main,`Object.fromEntries(${JSON.stringify(builtinThemes.map(theme=>theme.id))}.map(id=>[id,require('electron').Menu.getApplicationMenu().getMenuItemById('theme-'+id)?.label]))`)
      check(`${language}界面主题菜单使用配置名称`,JSON.stringify(menuNames)===JSON.stringify(expected),{expected,actual:menuNames})
      await openSettings()
      const dropdownNames=await evaluate(renderer,`Object.fromEntries([...document.getElementById('theme-settings-theme').options].filter(option=>${JSON.stringify(builtinThemes.map(theme=>theme.id))}.includes(option.value)).map(option=>[option.value,option.textContent]))`)
      check(`${language}界面主题下拉与菜单名称一致`,Object.entries(expected).every(([id,name])=>dropdownNames[id]===name),dropdownNames)
      await action('cancel')
      await waitFor(`!document.getElementById('theme-settings-dialog')`, '名称验收面板未关闭')
    }
  } finally {
    await selectLanguage(originalLanguage)
    await evaluate(main,'delete globalThis.__themeNamesPreviousMenu')
  }
}

// 主题从原生菜单进入，配置值与真实元素的计算样式比较，不固定任何一套配色。
async function verifyBuiltinThemeApplication() {
  const builtins=JSON.parse(readFileSync(join(root,'src/shared/builtin-themes.json'),'utf8'))
  const fileBefore=readFileSync(file)
  const timeBefore=statSync(file).mtimeMs
  const boundsBefore=await evaluate(main,'globalThis.__themeVerifyWindow.getBounds()')
  const layout=`(() => {
    const body=getComputedStyle(document.body)
    return {column:body.getPropertyValue('--editor-column-width'),sides:['left','right'].map(side=>{
      const element=document.getElementById(side+'-sidebar'),style=getComputedStyle(element)
      return {side,hidden:element.hidden,visible:document.body.classList.contains('show-'+side+'-sidebar'),width:style.width,top:style.top,bottom:style.bottom}
    })}
  })()`
  const layoutBefore=await evaluate(renderer,layout)
  // 先选中末项，保证首个 checkbox 菜单动作也是真实切换，避免重选把已选项反选。
  await setTheme(builtins.at(-1).id)
  for(const theme of builtins) {
    await evaluate(main,`(() => {
      const item=require('electron').Menu.getApplicationMenu().getMenuItemById(${JSON.stringify('theme-'+theme.id)})
      if(!item||!item.enabled)throw new Error('缺少可用主题菜单项')
      item.click(item,globalThis.__themeVerifyWindow)
    })()`)
    await waitFor(`document.body.dataset.themeId===${JSON.stringify(theme.id)}&&localStorage.getItem('colamd-theme')===${JSON.stringify(theme.id)}`, '原生菜单未应用主题 '+theme.id)
    await waitFor(`require('electron').Menu.getApplicationMenu().getMenuItemById(${JSON.stringify('theme-'+theme.id)})?.checked`, '主题菜单未选中 '+theme.id,main)
    check(`${theme.id} 原生菜单可选择并同步勾选`,true)
    // 历史主题的计算样式由迁移基线覆盖；显式配色与排版覆盖新配置的实际消费路径。
    if(!Object.keys(theme.syntax).length&&theme.typography.lineHeight===undefined)continue
    await renderFixture()
    const actual=await evaluate(renderer,`(() => {
      const theme=${JSON.stringify(theme)},results=[]
      const normalize=value=>{const probe=document.createElement('span');probe.style.color=value;document.body.append(probe);try{return getComputedStyle(probe).color}finally{probe.remove()}}
      const compare=(name,actual,expected)=>results.push({name,actual,expected,ok:actual===expected})
      const color=(name,selector,property,value,pseudo)=>{
        if(value===undefined)return
        const element=document.querySelector(selector)
        compare(name,element?getComputedStyle(element,pseudo)[property]:null,normalize(value))
      }
      color('正文底色','body','backgroundColor',theme.colors.bg)
      color('外壳底色','#titlebar','backgroundColor',theme.colors.chromeBackground)
      color('左侧栏底色','#left-sidebar','backgroundColor',theme.colors.sidebarBackground)
      color('右侧栏底色','#right-sidebar','backgroundColor',theme.colors.sidebarBackground)
      color('正文文字','.cm-md-paragraph','color',theme.colors.text)
      color('代码块底色','.cm-md-codeblock','backgroundColor',theme.colors.codeBlockBackground,'::before')
      color('代码块文字','.cm-md-codeblock','color',theme.colors.codeBlockText)
      color('行内代码文字','.cm-md-inlinecode','color',theme.styles.inlineCode?.color)
      const code=[...document.querySelectorAll('.cm-md-codeblock')].find(element=>element.textContent.includes('const sample'))
      for(const [token,kind] of [['const','keyword'],['"code"','string'],['// comment','comment']]) {
        const walker=code&&document.createTreeWalker(code,NodeFilter.SHOW_TEXT)
        let element
        while(walker?.nextNode())if(walker.currentNode.textContent.trim()===token){element=walker.currentNode.parentElement;break}
        if(theme.syntax[kind])compare('代码语法 '+kind,element?getComputedStyle(element).color:null,normalize(theme.syntax[kind]))
      }
      const paragraph=[...document.querySelectorAll('.cm-md-paragraph')].find(element=>element.textContent.startsWith('自动换行测量：'))
      if(theme.typography.lineHeight!==undefined) {
        const style=getComputedStyle(paragraph)
        results.push({name:'段内行高',actual:parseFloat(style.lineHeight),expected:parseFloat(style.fontSize)*theme.typography.lineHeight,ok:Math.abs(parseFloat(style.lineHeight)-parseFloat(style.fontSize)*theme.typography.lineHeight)<.15})
      }
      if(theme.typography.paragraphSpacing!==undefined) {
        const before=parseFloat(getComputedStyle(paragraph).paddingBottom)
        document.body.style.setProperty('--theme-paragraph-spacing','0em')
        const without=parseFloat(getComputedStyle(paragraph).paddingBottom)
        document.body.style.removeProperty('--theme-paragraph-spacing')
        const expected=parseFloat(getComputedStyle(paragraph).fontSize)*theme.typography.paragraphSpacing
        results.push({name:'段落间距',actual:before-without,expected,ok:Math.abs(before-without-expected)<.15})
      }
      for(let level=1;level<=6;level++) {
        const style=theme.styles['heading'+level],element=document.querySelector('.cm-md-atxheading'+level)
        if(style?.fontWeight!==undefined)compare('标题字重 '+level,getComputedStyle(element).fontWeight,String(style.fontWeight))
      }
      return results
    })()`)
    check(`${theme.id} 正文、外壳、代码与排版实际生效`,actual.length>0&&actual.every(result=>result.ok),actual.filter(result=>!result.ok))
    const metrics=await evaluate(renderer,paragraphMetrics)
    if(theme.typography.lineHeight!==undefined)check(`${theme.id} 自动折行使用主题行高`,metrics.count>2&&Math.abs(metrics.step-metrics.fontSize*theme.typography.lineHeight)<.15,metrics)
    await evaluate(renderer,`(() => {const view=document.querySelector('#editor .cm-content').cmTile.root.view;view.focus();view.dispatch({selection:{anchor:view.state.doc.toString().indexOf('正文 **')}})})()`)
    await waitFor(`!!document.querySelector('#editor .cm-cursor')`, '主题光标未绘制 '+theme.id)
    const cursor=await evaluate(renderer,`(() => {const probe=document.createElement('span');probe.style.color=${JSON.stringify(theme.colors.cursor??theme.colors.text)};document.body.append(probe);try{return {actual:getComputedStyle(document.querySelector('#editor .cm-cursor')).borderLeftColor,expected:getComputedStyle(probe).color}}finally{probe.remove()}})()`)
    check(`${theme.id} 光标使用主题颜色`,cursor.actual===cursor.expected,cursor)
    await evaluate(renderer,`(() => {const view=document.querySelector('#editor .cm-content').cmTile.root.view,anchor=view.state.doc.toString().indexOf('正文 **');view.dispatch({selection:{anchor,head:anchor+2}})})()`)
    await waitFor(`!!document.querySelector('#editor .cm-selectionBackground')`, '主题选区未绘制 '+theme.id)
    const selection=await evaluate(renderer,`(() => {const probe=document.createElement('span');probe.style.color=${JSON.stringify(theme.colors.selection)};document.body.append(probe);try{return {actual:getComputedStyle(document.querySelector('#editor .cm-selectionBackground')).backgroundColor,expected:getComputedStyle(probe).color}}finally{probe.remove()}})()`)
    check(`${theme.id} 选区使用主题颜色`,selection.actual===selection.expected,selection)
    await evaluate(renderer,`(() => {const view=document.querySelector('#editor .cm-content').cmTile.root.view;view.dispatch({selection:{anchor:0}})})()`)
    const screenshot=await renderer.send('Page.captureScreenshot',{format:'png'})
    writeFileSync(`/tmp/colamd-theme-${theme.id}.png`,Buffer.from(screenshot.data,'base64'))
  }
  check('切换内置主题保持侧栏显隐、宽度及正文列宽',JSON.stringify(await evaluate(renderer,layout))===JSON.stringify(layoutBefore))
  check('切换内置主题保持窗口结构',JSON.stringify(await evaluate(main,'globalThis.__themeVerifyWindow.getBounds()'))===JSON.stringify(boundsBefore))
  check('切换内置主题不改写文档字节及修改时间',fileBefore.equals(readFileSync(file))&&statSync(file).mtimeMs===timeBefore)
}

// 计算样式基线只记录视觉属性，不绑定主题颜色的具体字面值。
const visualSnapshot = `(() => {
  const properties=['color','backgroundColor','fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textAlign','borderTopColor','borderTopWidth','borderBottomColor','borderBottomWidth','borderBottomStyle','borderLeftWidth','borderRightWidth','paddingTop','paddingBottom','paddingLeft','paddingRight','opacity']
  const selectors={body:'body',content:'#editor .cm-content',heading1:'.cm-md-atxheading1',heading2:'.cm-md-atxheading2',heading3:'.cm-md-atxheading3',heading4:'.cm-md-atxheading4',heading5:'.cm-md-atxheading5',heading6:'.cm-md-atxheading6',strong:'.cm-md-strong',emphasis:'.cm-md-em',strikethrough:'.cm-md-strike',inlineCode:'.cm-md-inlinecode',quote:'.cm-md-blockquote',list:'.cm-md-li',tableHeader:'.cm-md-table-widget th',tableCell:'.cm-md-table-widget td',codeBlock:'.cm-md-codeblock',horizontalRule:'.cm-md-hr'}
  return Object.fromEntries(Object.entries(selectors).map(([name,selector])=>{const element=document.querySelector(selector);if(!element)return[name,null];const style=getComputedStyle(element);return[name,Object.fromEntries(properties.map(property=>[property,style[property]]))]}))
})()`

// 读取真正承载文字的节点，避免只测外层颜色而漏掉语法高亮的覆盖。
const linkTextColors = `doc => [...doc.querySelectorAll('.cm-md-link,.cm-md-table-widget a[data-href]')].flatMap(link => {
  const walker=doc.createTreeWalker(link,NodeFilter.SHOW_TEXT),colors=[]
  while(walker.nextNode())if(walker.currentNode.textContent.trim())colors.push(doc.defaultView.getComputedStyle(walker.currentNode.parentElement).color)
  return colors
})`

// 整篇渲染仅改变测试视口，不修改缓冲区。
async function renderFixture() {
  await evaluate(renderer, `(() => {const view=document.querySelector('#editor .cm-content').cmTile.root.view;view.viewState.printing=true;view.requestMeasure()})()`)
  await waitFor(`document.querySelector('#editor .cm-content').textContent.includes('后续段落测量')`, '夹具末段未渲染')
}

// 面板通过已公开菜单事件打开，测试不额外暴露业务入口。
async function openSettings() {
  await evaluate(main, `(globalThis.__themeVerifyWindow??require('electron').BrowserWindow.getAllWindows()[0]).webContents.send('menu-theme-settings')`)
  await waitFor(`!!document.getElementById('theme-settings-dialog')`, '主题配置面板未打开')
}

// 分类切换和字段输入均经过真实 DOM 事件。
async function changeField(category, path, value) {
  await evaluate(renderer, `(() => {
    const category=document.getElementById('theme-settings-category');category.value=${JSON.stringify(category)};category.dispatchEvent(new Event('change',{bubbles:true}))
  })()`)
  await waitFor(`!!document.querySelector('[data-theme-path="${path}"]')`, `缺少配置字段 ${path}`)
  await evaluate(renderer, `(() => {
    const input=document.querySelector('[data-theme-path="${path}"]');input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))
  })()`)
}

// 点击面板现有动作并等待调用端自行判断结果。
async function action(name) {
  await evaluate(renderer, `document.querySelector('[data-theme-action="${name}"]').click()`)
}

// 下拉选择经过真实 change 事件，等待结果由每个用例明确判断。
async function selectDraft(id) {
  await evaluate(renderer, `(() => {const select=document.getElementById('theme-settings-theme');select.value=${JSON.stringify(id)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}

// 键盘操作送到真实焦点，不用合成 KeyboardEvent 冒充浏览器默认行为。
async function pressKey(key, code, windowsVirtualKeyCode) {
  await renderer.send('Input.dispatchKeyEvent', {type:'keyDown',key,code,windowsVirtualKeyCode,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})})
  await renderer.send('Input.dispatchKeyEvent', {type:'keyUp',key,code,windowsVirtualKeyCode})
}

// 两个临时用户主题隔离本轮交互，避免测试保存覆盖用户的内置主题定制。
async function verifyThemeSwitching(custom, builtins) {
  const secondId=`${testThemeId}-switch`
  const second={...structuredClone(builtins.find(theme=>theme.id==='dark')),id:secondId,name:'切换验收专用'}
  createdThemeIds.add(secondId)
  assert((await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(second)})`)).ok)
  await setTheme(testThemeId)
  await openSettings()
  check('主题下拉包含内置主题与用户主题',await evaluate(renderer,`(() => {const ids=[...document.getElementById('theme-settings-theme').options].map(option=>option.value);return ['light','dark',${JSON.stringify(testThemeId)},${JSON.stringify(secondId)}].every(id=>ids.includes(id))})()`))
  await selectDraft(secondId)
  await waitFor(`document.getElementById('theme-settings-theme').value===${JSON.stringify(secondId)}`, '干净主题切换未完成')
  check('下拉切换只加载配置和预览，不应用主编辑器',await evaluate(renderer,`localStorage.getItem('colamd-theme')===${JSON.stringify(testThemeId)}&&document.querySelector('[data-theme-path="appearance"]').value==='dark'`))
  await changeField('interface','colors.text','#123456')
  await action('resetCategory')
  check('切换主题后重置分类使用目标主题原版',await evaluate(renderer,`document.querySelector('[data-theme-path="colors.text"]').value===${JSON.stringify(second.colors.text)}`))
  await selectDraft(testThemeId)
  await waitFor(`document.getElementById('theme-settings-theme').value===${JSON.stringify(testThemeId)}`, '重置回原值后仍阻止切换')
  check('字段改回载入值后直接切换，无需保存确认',await evaluate(renderer,`!document.getElementById('theme-settings-switch-dialog')`))
  const originalName=custom.name
  await action('rename')
  await waitFor(`!!document.getElementById('theme-settings-name')`, '重命名弹窗未打开')
  check('重命名弹窗按内容高度显示',await evaluate(renderer,`(() => {const dialog=document.getElementById('theme-settings-rename-dialog');return dialog.getBoundingClientRect().bottom-dialog.lastElementChild.getBoundingClientRect().bottom<40})()`))
  const renameScreenshot=await renderer.send('Page.captureScreenshot',{format:'png'})
  writeFileSync('/tmp/colamd-theme-settings-rename.png',Buffer.from(renameScreenshot.data,'base64'))
  await evaluate(renderer,`document.getElementById('theme-settings-name').value='不应保存的名称'`)
  await action('renameCancel')
  check('取消重命名保留当前名称',await evaluate(renderer,`document.getElementById('theme-settings-theme').selectedOptions[0].textContent===${JSON.stringify(originalName)}`))
  await action('rename')
  await evaluate(renderer,`document.getElementById('theme-settings-name').value='   '`)
  await action('renameConfirm')
  check('空白名称不关闭重命名弹窗',await evaluate(renderer,`!!document.getElementById('theme-settings-rename-dialog')`))
  await pressKey('Escape','Escape',27)
  await waitFor(`!document.getElementById('theme-settings-rename-dialog')`, 'Escape未取消重命名')
  check('Escape只关闭重命名弹窗，保留配置面板',await evaluate(renderer,`!!document.getElementById('theme-settings-dialog')`))
  const renamed=`${originalName} 已重命名`
  await action('rename')
  await evaluate(renderer,`(() => {const input=document.getElementById('theme-settings-name');input.value=${JSON.stringify(renamed)};input.focus()})()`)
  await pressKey('Enter','Enter',13)
  await waitFor(`!document.getElementById('theme-settings-rename-dialog')`, 'Enter未确认重命名')
  check('重命名更新下拉名称但未提前写盘',await evaluate(renderer,`document.getElementById('theme-settings-theme').selectedOptions[0].textContent===${JSON.stringify(renamed)}`)&&(await evaluate(renderer,'window.electronAPI.listThemeDefinitions()')).find(theme=>theme.id===testThemeId).name===originalName)
  await selectDraft(secondId)
  await waitFor(`!!document.getElementById('theme-settings-switch-dialog')`, '修改名称后切换未确认')
  check('保存确认弹窗按内容高度显示',await evaluate(renderer,`(() => {const dialog=document.getElementById('theme-settings-switch-dialog');return dialog.getBoundingClientRect().bottom-dialog.lastElementChild.getBoundingClientRect().bottom<40})()`))
  const switchScreenshot=await renderer.send('Page.captureScreenshot',{format:'png'})
  writeFileSync('/tmp/colamd-theme-settings-switch.png',Buffer.from(switchScreenshot.data,'base64'))
  check('确认切换前下拉仍选中当前草稿',await evaluate(renderer,`document.getElementById('theme-settings-theme').value===${JSON.stringify(testThemeId)}`))
  await action('switchCancel')
  check('取消切换保留名称草稿和原选择',await evaluate(renderer,`document.getElementById('theme-settings-theme').value===${JSON.stringify(testThemeId)}&&document.getElementById('theme-settings-theme').selectedOptions[0].textContent===${JSON.stringify(renamed)}`))
  await selectDraft(secondId)
  await pressKey('Escape','Escape',27)
  await waitFor(`!document.getElementById('theme-settings-switch-dialog')`, 'Escape未取消切换')
  check('Escape取消切换后焦点返回主题下拉',await evaluate(renderer,`document.activeElement===document.getElementById('theme-settings-theme')`))
  await selectDraft(secondId)
  await action('switchSave')
  await waitFor(`document.getElementById('theme-settings-theme')?.value===${JSON.stringify(secondId)}`, '保存并切换未加载目标')
  check('保存并切换应用已保存主题，同时保留配置面板',await evaluate(renderer,`localStorage.getItem('colamd-theme')===${JSON.stringify(testThemeId)}&&!!document.getElementById('theme-settings-dialog')`))
  check('重命名随保存并切换实际持久化',(await evaluate(renderer,'window.electronAPI.listThemeDefinitions()')).find(theme=>theme.id===testThemeId).name===renamed)
  await waitFor(`require('electron').Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(`theme-${testThemeId}`)})?.label===${JSON.stringify(renamed)}`, '保存后原生菜单主题名称未更新',main)
  check('用户主题保存后原生菜单同步名称',await evaluate(main,`require('electron').Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(`theme-${testThemeId}`)})?.label===${JSON.stringify(renamed)}`))
  await selectDraft(testThemeId)
  await changeField('interface','colors.text','not-a-color')
  await selectDraft(secondId)
  await action('switchSave')
  await waitFor(`!document.getElementById('theme-settings-switch-dialog')`, '无效输入保存后确认框未关闭')
  check('无效输入阻止保存并切换且保留原文',await evaluate(renderer,`document.getElementById('theme-settings-theme').value===${JSON.stringify(testThemeId)}&&document.querySelector('[data-theme-path="colors.text"]').value==='not-a-color'`))
  // 只让本验收进程的草稿恢复写入失败，不触碰用户恢复目录或其他写入。
  await evaluate(main,`(() => {const fs=require('fs/promises');globalThis.__themeOriginalWriteFile=fs.writeFile;globalThis.__themeRecoveryFailed=false;fs.writeFile=async function(path,...args){if(String(path).includes('theme-draft-')){globalThis.__themeRecoveryFailed=true;throw new Error('验收注入恢复写入失败')}return globalThis.__themeOriginalWriteFile.call(this,path,...args)}})()`)
  try {
    await selectDraft(secondId)
    await action('switchDiscard')
    await waitFor(`!document.getElementById('theme-settings-switch-dialog')&&!document.querySelector('[data-theme-action="save"]').disabled`, '恢复写入失败未结束忙碌状态')
    check('恢复副本写入失败阻止切换且保留无效输入',await evaluate(main,`globalThis.__themeRecoveryFailed`)&&await evaluate(renderer,`document.getElementById('theme-settings-theme').value===${JSON.stringify(testThemeId)}&&document.querySelector('[data-theme-path="colors.text"]').value==='not-a-color'`))
    check('恢复副本写入失败后焦点返回主题下拉',await evaluate(renderer,`document.activeElement===document.getElementById('theme-settings-theme')`))
  } finally {
    await evaluate(main,`(() => {require('fs/promises').writeFile=globalThis.__themeOriginalWriteFile;delete globalThis.__themeOriginalWriteFile})()`)
  }
  const recoveryDir=join(homedir(),'.colamd','recovered')
  const before=new Set(existsSync(recoveryDir)?readdirSync(recoveryDir):[])
  await selectDraft(secondId)
  await action('switchDiscard')
  await waitFor(`document.getElementById('theme-settings-theme')?.value===${JSON.stringify(secondId)}`, '不保存并切换未完成')
  check('不保存切换成功后焦点返回主题下拉',await evaluate(renderer,`document.activeElement===document.getElementById('theme-settings-theme')`))
  const recovered=readdirSync(recoveryDir).filter(name=>!before.has(name)).map(name=>join(recoveryDir,name)).find(path=>{
    try{return JSON.parse(readFileSync(path,'utf8')).theme?.id===testThemeId}catch{return false}
  })
  if(recovered)createdRecoveryFiles.add(recovered)
  const recoveredDraft=recovered?JSON.parse(readFileSync(recovered,'utf8')):null
  check('不保存切换先写出包含无效原文的恢复副本',!!recoveredDraft&&recoveredDraft.invalidFields['colors.text']==='not-a-color',recoveredDraft)
  check('恢复副本路径告知用户且未应用目标主题',await evaluate(renderer,`document.getElementById('theme-settings-status').textContent.includes(${JSON.stringify(recovered??'missing-recovery')})&&localStorage.getItem('colamd-theme')===${JSON.stringify(testThemeId)}`))
  await selectDraft(testThemeId)
  await changeField('interface','colors.text','#234567')
  const themePath=join(homedir(),'.colamd','themes',`${encodeURIComponent(testThemeId)}.theme.json`)
  const original=readFileSync(themePath,'utf8')
  rmSync(themePath)
  mkdirSync(themePath)
  try {
    await selectDraft(secondId)
    await action('switchSave')
    await waitFor(`!document.getElementById('theme-settings-switch-dialog')&&!document.querySelector('[data-theme-action="save"]').disabled`, '失败保存未结束忙碌状态')
    check('真实写盘失败保留草稿和当前选择',await evaluate(renderer,`document.getElementById('theme-settings-theme').value===${JSON.stringify(testThemeId)}&&document.querySelector('[data-theme-path="colors.text"]').value==='#234567'`))
  } finally {
    rmSync(themePath,{recursive:true,force:true})
    writeFileSync(themePath,original)
  }
  const updated={...structuredClone(second),name:'外部更新后的主题'}
  assert((await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(updated)})`)).ok)
  await waitFor(`document.getElementById('theme-settings-theme').querySelector('option[value="${secondId}"]').textContent===${JSON.stringify(updated.name)}`, '主题库更新未刷新下拉名称')
  check('主题库更新选项保留当前草稿',await evaluate(renderer,`document.getElementById('theme-settings-theme').value===${JSON.stringify(testThemeId)}&&document.querySelector('[data-theme-path="colors.text"]').value==='#234567'`))
  await action('cancel')
  await waitFor(`!document.getElementById('theme-settings-dialog')`, '切换验收面板未关闭')
  // 恢复本脚本临时主题，后续排版回归继续使用相同初始契约。
  assert((await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(custom)})`)).ok)
  for(const language of ['zh','en']) {
    const sample=JSON.parse(readFileSync(join(root,'src/shared/theme-settings-labels.json'),'utf8'))[language].sample
    const lines=sample.split('\n'),headings=lines.map((text,index)=>({text,index})).filter(line=>/^#{1,6} /.test(line.text))
    check(`${language}预览每级标题后都有普通正文`,[1,2,3,4,5,6].every(level=>headings.some(line=>line.text.startsWith(`${'#'.repeat(level)} `)&&(()=>{const next=lines.slice(line.index+1).find(text=>text.trim());return next?.length>15&&!/^(#|>|-|\||`)/.test(next)})())),headings.map(line=>line.text))
  }
}

// 原生文件选择只在验收进程替换，导入导出仍经过实际 IPC 和文件读写。
async function dialogResult(method, result) {
  await evaluate(main, `(() => {
    const dialog=require('electron').dialog
    globalThis.__themeOriginalDialogs??={showSaveDialog:dialog.showSaveDialog,showOpenDialog:dialog.showOpenDialog}
    dialog[${JSON.stringify(method)}]=async()=>(${JSON.stringify(result)})
  })()`)
}

// 段内步长使用真实字形矩形；段落间空隙测最后一行字形到底下一段字形。
const paragraphMetrics = `(() => {
  const lines=[...document.querySelectorAll('#editor .cm-line')]
  const first=lines.find(element=>element.textContent.startsWith('自动换行测量：'))
  const next=lines.find(element=>element.textContent.startsWith('后续段落测量。'))
  if(!first||!next)throw new Error('测量段落未渲染')
  const rects=element=>{const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),result=[];while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);result.push(...[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0))}return result}
  const a=rects(first),b=rects(next),tops=[...new Set(a.map(rect=>Math.round(rect.top*100)/100))].sort((a,b)=>a-b)
  return {count:tops.length,step:tops[1]-tops[0],gap:Math.min(...b.map(rect=>rect.top))-Math.max(...a.map(rect=>rect.bottom)),fontSize:parseFloat(getComputedStyle(first).fontSize),lineHeight:parseFloat(getComputedStyle(first).lineHeight)}
})()`

// 每次启动都使用同一临时 profile，重启验收才能证明持久化恢复。
async function launch() {
  child = spawn(require('electron'), [join(root, 'scripts/offscreen-window.cjs'), file,
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { cwd: root, env, stdio: 'ignore' })
  main = await connect(inspectPort, 'node')
  renderer = await connect(port, 'page')
  await waitFor(`document.querySelector('#editor .cm-content')?.textContent.includes('一级标题')`, 'Markdown 夹具未载入')
  await evaluate(main, `(() => {globalThis.__themeVerifyWindow=require('electron').BrowserWindow.getAllWindows()[0];globalThis.__themeVerifyWindow.setSize(1300,2200)})()`)
  await evaluate(renderer, `document.querySelector('#editor .cm-content').cmTile.root.view.dispatch({selection:{anchor:0}})`)
  await renderFixture()
}

// 只清理当前验收 profile 的进程，不干扰用户正在运行的应用。
async function stop() {
  if(main)await evaluate(main,`require('electron').session.defaultSession.flushStorageData()`).catch(()=>{})
  renderer?.close(); main?.close()
  const process = child
  child = null; renderer = null; main = null
  process?.kill('SIGTERM')
  stopVerifyApp(udd)
  await pause(200)
}

try {
  await launch()
  const themes = ['light','elegant','notion','writer','bear','sepia','dark','gruvbox','midnight','solarized-dark','nord','dracula']
  const snapshots = {}
  for (const id of themes) {
    await setTheme(id)
    snapshots[id] = await evaluate(renderer, visualSnapshot)
  }
  if (baselineMode) {
    writeFileSync(baselinePath, JSON.stringify(snapshots, null, 2) + '\n')
    console.log(`已记录 ${themes.length} 套主题迁移前样式：${baselinePath}`)
  } else {
    if (existsSync(baselinePath)) {
      const before = JSON.parse(readFileSync(baselinePath, 'utf8'))
      const differences = []
      for (const id of themes) for (const [kind, properties] of Object.entries(before[id])) {
        if (!properties) continue
        for (const [property, value] of Object.entries(properties)) {
          const border=property.match(/^border(Top|Bottom|Left|Right)Color$/)
          if(border&&parseFloat(properties[`border${border[1]}Width`])===0&&parseFloat(snapshots[id][kind]?.[`border${border[1]}Width`])===0)continue
          if (snapshots[id][kind]?.[property] !== value) differences.push({ theme:id,kind,property,before:value,after:snapshots[id][kind]?.[property] })
        }
      }
      if(differences.length)writeFileSync('/tmp/colamd-theme-migration-differences.json',JSON.stringify(differences,null,2)+'\n')
      check('12 套内置主题迁移保持原计算样式', differences.length === 0, {count:differences.length,examples:differences.slice(0,20)})
    }
    await setTheme('light')
    await verifyThemeNames()
    await verifyBuiltinThemeApplication()
    await setTheme('light')
    const initial = await evaluate(renderer, visualSnapshot)
    const definitionsBeforeCancel = await evaluate(renderer, `window.electronAPI.listThemeDefinitions()`)
    await openSettings()
    check('主题名称由切换主题的下拉列表显示', await evaluate(renderer, `document.getElementById('theme-settings-theme') instanceof HTMLSelectElement`))
    check('配置面板具有对话框语义与隔离预览', await evaluate(renderer, `(() => {const dialog=document.getElementById('theme-settings-dialog');return (dialog.tagName==='DIALOG'||dialog.getAttribute('role')==='dialog')&&!!document.getElementById('theme-settings-preview')?.contentDocument})()`))
    await waitFor(`!!document.getElementById('theme-settings-preview')?.contentDocument?.querySelector('.cm-content')`, '隔离预览编辑器未挂载')
    await waitFor(`[...document.getElementById('theme-settings-preview').contentDocument.querySelectorAll('.cm-md-paragraph')].some(element=>element.textContent.length>70)`, '隔离预览缺少长正文样张')
    const previewWrap=await evaluate(renderer,`(() => {
      const frame=document.getElementById('theme-settings-preview'),doc=frame.contentDocument
      const paragraphs=[...doc.querySelectorAll('.cm-md-paragraph')].filter(element=>element.textContent.length>70)
      return paragraphs.map(element=>{const range=doc.createRange();range.selectNodeContents(element);const tops=[...new Set([...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0).map(rect=>Math.round(rect.top*100)/100))];return {length:element.textContent.length,count:tops.length,step:tops.length>1?tops[1]-tops[0]:null}})
    })()`)
    check('隔离预览中的长正文实际自动折行',previewWrap.some(paragraph=>paragraph.count>1),previewWrap)
    const screenshot=await renderer.send('Page.captureScreenshot',{format:'png'})
    writeFileSync('/tmp/colamd-theme-settings-panel.png',Buffer.from(screenshot.data,'base64'))
    await changeField('interface','colors.text','#123456')
    check('草稿预览未改变主编辑器主题', JSON.stringify(await evaluate(renderer, visualSnapshot)) === JSON.stringify(initial))
    const cursorPicked=await evaluate(renderer,`(() => {
      const input=document.querySelector('[data-theme-path="colors.cursor"]'),row=input.closest('.theme-settings-row'),picker=row.querySelector('input[type="color"]'),alpha=row.querySelector('input[type="range"]')
      picker.value='#345678';picker.dispatchEvent(new Event('input',{bubbles:true}));return{value:input.value,alpha:Number(alpha.value)}
    })()`)
    check('未设光标色时直接取色得到不透明颜色',cursorPicked.value==='#345678'&&cursorPicked.alpha===1,cursorPicked)
    await action('cancel')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '取消未关闭面板')
    check('取消未持久化内置主题定制', JSON.stringify(await evaluate(renderer, `window.electronAPI.listThemeDefinitions()`))===JSON.stringify(definitionsBeforeCancel))
    await setTheme('dark')
    await openSettings()
    check('深色配置面板使用当前主题表面和文字',await evaluate(renderer,`(() => {const dialog=getComputedStyle(document.getElementById('theme-settings-dialog'));return dialog.backgroundColor===getComputedStyle(document.body).backgroundColor&&dialog.color===getComputedStyle(document.body).color})()`))
    await waitFor(`document.getElementById('theme-settings-preview')?.contentDocument?.body.classList.contains('theme-dark')`, '深色样张主题未应用')
    check('深色主题同步原生控件和预览的明暗方案',await evaluate(renderer,`(() => {const preview=document.getElementById('theme-settings-preview').contentDocument;return getComputedStyle(document.body).colorScheme==='dark'&&preview.defaultView.getComputedStyle(preview.body).colorScheme==='dark'})()`))
    const darkScreenshot=await renderer.send('Page.captureScreenshot',{format:'png'})
    writeFileSync('/tmp/colamd-theme-settings-panel-dark.png',Buffer.from(darkScreenshot.data,'base64'))
    await evaluate(main,'globalThis.__themeVerifyWindow.setSize(720,700)')
    await evaluate(renderer,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    check('窄窗口配置面板保持在可用视口内',await evaluate(renderer,`(() => {const rect=document.getElementById('theme-settings-dialog').getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+.5&&rect.top>=0&&rect.bottom<=innerHeight+.5})()`))
    await action('rename')
    check('深色窄窗口重命名弹窗可见且输入获得焦点',await evaluate(renderer,`(() => {const dialog=document.getElementById('theme-settings-rename-dialog'),rect=dialog.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+.5&&rect.top>=0&&rect.bottom<=innerHeight+.5&&document.activeElement===document.getElementById('theme-settings-name')})()`))
    await action('renameCancel')
    await action('cancel')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '深色面板取消失败')
    await evaluate(main,'globalThis.__themeVerifyWindow.setSize(1300,2200)')

    const builtins = JSON.parse(readFileSync(join(root,'src/shared/builtin-themes.json'),'utf8'))
    const custom = { ...structuredClone(builtins.find(theme=>theme.id==='light')),id:testThemeId,name:'主题验收专用' }
    createdThemeIds.add(testThemeId)
    const created = await evaluate(renderer, `window.electronAPI.saveThemeDefinition(${JSON.stringify(custom)})`)
    check('通过实际 IPC 保存独立用户主题', created.ok, created)
    await verifyThemeSwitching(custom,builtins)
    await setTheme(testThemeId)
    await openSettings()
    await changeField('interface','colors.text','not-a-color')
    await action('save')
    check('无效颜色保留面板和草稿', await evaluate(renderer, `!!document.getElementById('theme-settings-dialog')&&!!document.getElementById('theme-settings-status').textContent`))
    check('无效草稿未写入主题文件', (await evaluate(renderer, `window.electronAPI.listThemeDefinitions()`)).find(theme=>theme.id===testThemeId).colors.text===custom.colors.text)
    await evaluate(renderer, `(() => {
      const category=document.getElementById('theme-settings-category')
      for(const value of ['typography','interface']) { category.value=value;category.dispatchEvent(new Event('change',{bubbles:true})) }
    })()`)
    check('切换分类后保留无效输入原文',await evaluate(renderer,`document.querySelector('[data-theme-path="colors.text"]').value==='not-a-color'`))
    await changeField('interface','colors.text','#234567')
    await changeField('heading1','styles.heading1.color','#8a2456')
    await changeField('heading1','styles.heading1.fontWeight',400)
    await changeField('strong','styles.strong.color','#167043')
    await changeField('strong','styles.strong.fontWeight',400)
    await changeField('link','styles.link.color','#a12345')
    const previewLinks=await evaluate(renderer,`(${linkTextColors})(document.getElementById('theme-settings-preview').contentDocument)`)
    check('隔离预览中的实际链接文字使用分类颜色',previewLinks.length>0&&previewLinks.every(color=>color==='rgb(161, 35, 69)'),previewLinks)
    await changeField('emphasis','styles.emphasis.fontStyle','normal')
    await changeField('strikethrough','styles.strikethrough.textDecoration','none')
    await changeField('typography','typography.lineHeight',1.6)
    await changeField('typography','typography.paragraphSpacing',0.5)
    await action('save')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '保存未关闭面板')
    await waitFor(`getComputedStyle(document.querySelector('.cm-md-atxheading1')).color==='rgb(138, 36, 86)'`, '标题颜色未生效')
    check('标题与粗体分别使用配置颜色', await evaluate(renderer, `getComputedStyle(document.querySelector('.cm-md-strong')).color==='rgb(22, 112, 67)'`))
    const spans=await evaluate(renderer,`(() => {
      const selectors={heading1:'.cm-md-atxheading1',strong:'.cm-md-strong',emphasis:'.cm-md-em',strikethrough:'.cm-md-strike'}
      return Object.fromEntries(Object.entries(selectors).map(([kind,selector])=>{
        const element=document.querySelector(selector),walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),styles=[]
        while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent.trim()||node.parentElement.closest('.cm-md-marker'))continue;const style=getComputedStyle(node.parentElement);styles.push({fontWeight:style.fontWeight,fontStyle:style.fontStyle,textDecoration:style.textDecorationLine})}
        return[kind,styles]
      }))
    })()`)
    check('标题实际文字 span 接受自定义字重',spans.heading1.length>0&&spans.heading1.every(style=>style.fontWeight==='400'),spans.heading1)
    check('粗体实际文字 span 可恢复普通字重',spans.strong.length>0&&spans.strong.every(style=>style.fontWeight==='400'),spans.strong)
    check('斜体实际文字 span 可恢复正常字体',spans.emphasis.length>0&&spans.emphasis.every(style=>style.fontStyle==='normal'),spans.emphasis)
    check('删除线实际文字 span 可取消划线',spans.strikethrough.length>0&&spans.strikethrough.every(style=>style.textDecoration==='none'),spans.strikethrough)
    const appliedLinks=await evaluate(renderer,`(${linkTextColors})(document)`)
    check('保存后主编辑器中的实际链接文字使用分类颜色',appliedLinks.length>0&&appliedLinks.every(color=>color==='rgb(161, 35, 69)'),appliedLinks)
    await renderFixture()
    const metricsA = await evaluate(renderer,paragraphMetrics)
    check('段内行高作用于实际自动折行步长',metricsA.count>2&&Math.abs(metricsA.step-metricsA.fontSize*1.6)<.15,metricsA)
    await openSettings()
    await changeField('typography','typography.paragraphSpacing',1.5)
    await action('save')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '段间距保存未完成')
    await renderFixture()
    const metricsB = await evaluate(renderer,paragraphMetrics)
    check('调整段落间距不改变同段自动折行步长',Math.abs(metricsB.step-metricsA.step)<.15,{before:metricsA,after:metricsB})
    check('段落间距独立增加真实字形间的空隙',Math.abs(metricsB.gap-metricsA.gap-metricsA.fontSize)<.25,{before:metricsA,after:metricsB})
    await openSettings()
    await changeField('typography','typography.lineHeight',1.9)
    await action('save')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '行高保存未完成')
    await renderFixture()
    const metricsC = await evaluate(renderer,paragraphMetrics)
    const saved = (await evaluate(renderer, `window.electronAPI.listThemeDefinitions()`)).find(theme=>theme.id===testThemeId)
    check('调整段内行高保留独立段落间距配置',saved.typography.paragraphSpacing===1.5&&Math.abs(metricsC.step-metricsC.fontSize*1.9)<.15,{saved:saved.typography,metrics:metricsC})

    const htmlStyle = await evaluate(renderer, `(() => {
      const article=document.createElement('article');article.className='colamd-document';article.innerHTML=window.__colamdExportDocumentHTML();document.body.appendChild(article)
      const result={heading:getComputedStyle(article.querySelector('h1')).color,strong:getComputedStyle(article.querySelector('strong')).color,link:getComputedStyle(article.querySelector('a')).color,paragraph:parseFloat(getComputedStyle(article.querySelector('p')).lineHeight)};article.remove();return result
    })()`)
    check('HTML 语义结构采用相同文字配置',htmlStyle.heading==='rgb(138, 36, 86)'&&htmlStyle.strong==='rgb(22, 112, 67)',htmlStyle)
    check('HTML 与主编辑器使用相同的链接分类颜色',appliedLinks.every(color=>color===htmlStyle.link),htmlStyle)
    const htmlPath=join(dir,'主题排版.html')
    await dialogResult('showSaveDialog',{canceled:false,filePath:htmlPath})
    const htmlExported=await evaluate(renderer,`window.electronAPI.exportHTML({content:${JSON.stringify(fixture)},document:window.__colamdExportDocumentHTML(),html:document.querySelector('#editor .cm-content').innerHTML,styles:Array.from(document.styleSheets).flatMap(sheet=>{try{return Array.from(sheet.cssRules,rule=>rule.cssText)}catch{return[]}}).join('\\n'),bodyClass:document.body.className})`)
    check('HTML 导出实际写出包含主题的独立文档',htmlExported&&existsSync(htmlPath))
    const exportedHTML=readFileSync(htmlPath,'utf8')
    const standaloneStyle=await evaluate(renderer,`(async()=>{const frame=document.createElement('iframe');frame.style.cssText='position:fixed;width:800px;height:800px;left:-2000px';const loaded=new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));frame.srcdoc=${JSON.stringify(exportedHTML)};document.body.appendChild(frame);await loaded;const result={heading:frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('h1')).color,strong:frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('strong')).color};frame.remove();return result})()`)
    check('独立 HTML 文件重载后保留分类文字样式',standaloneStyle.heading===htmlStyle.heading&&standaloneStyle.strong===htmlStyle.strong,standaloneStyle)
    const yaml = require('yaml')
    for (const format of ['yaml','json']) {
      const exportPath=join(dir,`导出主题.${format}`)
      await dialogResult('showSaveDialog',{canceled:false,filePath:exportPath})
      const result=await evaluate(renderer,`window.electronAPI.exportThemeDefinition(${JSON.stringify(saved)},${JSON.stringify(format)})`)
      check(`${format} 通过原生导出入口写出实际文件`,result.ok&&existsSync(exportPath),result)
      const text=readFileSync(exportPath,'utf8')
      const parsed=format==='yaml'?yaml.parse(text):JSON.parse(text)
      check(`${format} 格式化文件完整保留主题定义`,JSON.stringify(parsed)===JSON.stringify(saved)&&text.includes('\n  '),text.slice(0,100))
      await dialogResult('showOpenDialog',{canceled:false,filePaths:[exportPath]})
      const imported=await evaluate(renderer,`window.electronAPI.importThemeFile()`)
      const withoutId=theme=>{const {id,...rest}=theme;return rest}
      check(`${format} 导入导出往返保留内容并使用独立标识`,imported?.ok&&JSON.stringify(withoutId(imported.theme))===JSON.stringify(withoutId(saved))&&imported.theme.id!==saved.id,imported)
    }
    await dialogResult('showSaveDialog',{canceled:true})
    check('取消导出被明确返回且不写入文件',(await evaluate(renderer,`window.electronAPI.exportThemeDefinition(${JSON.stringify(saved)},'yaml')`)).canceled===true)
    const invalidFile=join(dir,'无效配置.yaml')
    writeFileSync(invalidFile,'version: 999\nname: invalid\n')
    await dialogResult('showOpenDialog',{canceled:false,filePaths:[invalidFile]})
    check('不支持的文件版本导入失败且不保存',!(await evaluate(renderer,'window.electronAPI.importThemeFile()')).ok)
    const legacyFile=join(dir,'旧主题.css')
    writeFileSync(legacyFile,':root{--text-color:#314159;--bg-color:#fefefe} #editor .cm-content .cm-md-atxheading1{color:#265358} @media(min-width:1px){#editor .cm-content{letter-spacing:.01em}}')
    await dialogResult('showOpenDialog',{canceled:false,filePaths:[legacyFile]})
    await openSettings()
    await action('import')
    await waitFor(`document.getElementById('theme-settings-theme')?.selectedOptions[0]?.textContent.includes('旧主题')`, '旧 CSS 未进入面板草稿')
    check('尚未保存的导入主题显示为下拉当前项',await evaluate(renderer,`(() => {const select=document.getElementById('theme-settings-theme');return select.value.startsWith('user-')&&select.selectedOptions.length===1})()`))
    check('旧 CSS 导入不立即改变当前活动主题',await evaluate(renderer,`localStorage.getItem('colamd-theme')===${JSON.stringify(testThemeId)}`))
    await action('cancel')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '旧 CSS 草稿取消失败')

    const originalTargets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const originalTargetId=originalTargets.find(target=>target.type==='page').id
    await evaluate(main,`(() => {const {Menu,BrowserWindow}=require('electron');const flatten=menu=>menu.items.flatMap(item=>[item,...(item.submenu?flatten(item.submenu):[])]);const item=flatten(Menu.getApplicationMenu()).find(item=>item.accelerator==='CmdOrCtrl+N');item.click(item,globalThis.__themeVerifyWindow)})()`)
    let secondTarget
    for(let i=0;i<100&&!secondTarget;i++) {
      const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      secondTarget=targets.find(target=>target.type==='page'&&target.id!==originalTargetId)
      if(!secondTarget)await pause(100)
    }
    assert(secondTarget,'第二窗口调试目标未创建')
    const second=await connect(port,'page',secondTarget.id)
    try {
      await waitFor(`!!window.electronAPI&&!!document.querySelector('#editor .cm-content')`, '第二窗口未就绪',second)
      await evaluate(main,`require('electron').BrowserWindow.getAllWindows().find(win=>win!==globalThis.__themeVerifyWindow).webContents.send('set-theme','dark')`)
      await waitFor(`localStorage.getItem('colamd-theme')==='dark'&&document.body.classList.contains('theme-dark')`, '第二窗口未切换深色主题',second)
      const next=structuredClone(saved);next.styles.heading1.color='#992255'
      await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(next)})`)
      await waitFor(`getComputedStyle(document.querySelector('.cm-md-atxheading1')).color==='rgb(153, 34, 85)'`, '相同主题定义更新未应用')
      check('主题定义更新未切换使用其他主题的窗口',await evaluate(second,`document.body.classList.contains('theme-dark')`))
      await evaluate(main,`require('electron').BrowserWindow.getAllWindows().find(win=>win!==globalThis.__themeVerifyWindow).webContents.send('set-theme',${JSON.stringify(testThemeId)})`)
      await waitFor(`document.body.classList.contains('theme-configured')&&!document.body.classList.contains('theme-dark')`, '第二窗口未使用用户主题',second)
      next.colors.bg='#fdfcfb'
      await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(next)})`)
      await waitFor(`getComputedStyle(document.body).backgroundColor==='rgb(253, 252, 251)'`, '第二窗口同主题未同步更新',second)
      check('使用同一主题的窗口同步定义修改',await evaluate(renderer,`getComputedStyle(document.body).backgroundColor==='rgb(253, 252, 251)'`))
    } finally {second.close()}
    await setTheme(testThemeId)
    await stop()
    await launch()
    await waitFor(`localStorage.getItem('colamd-theme')===${JSON.stringify(testThemeId)}&&getComputedStyle(document.querySelector('.cm-md-atxheading1')).color==='rgb(153, 34, 85)'`, '应用重启未恢复已保存主题')
    check('真实进程重启恢复主题颜色和独立排版配置',(await evaluate(renderer,`window.electronAPI.listThemeDefinitions()`)).find(theme=>theme.id===testThemeId).typography.paragraphSpacing===1.5)
    const oldName=`verify-theme-settings-${Date.now()}.css`
    const oldPath=join(homedir(),'.colamd','themes',oldName)
    const oldCSS=`/* ${oldName} */\n:root{--text-color:#314159;--bg-color:#fefefe}\n#editor .cm-content .cm-md-atxheading1{color:#265358}\n@media(min-width:1px){#editor .cm-content{letter-spacing:.01em}}\n`
    writeFileSync(oldPath,oldCSS)
    createdLegacyFiles.add(oldPath)
    const oldTime=statSync(oldPath).mtimeMs
    const migratedId=`legacy-${createHash('sha256').update(oldName).digest('hex').slice(0,16)}`
    createdThemeIds.add(migratedId)
    // 构造排序更靠前的同内容主题，恢复必须仍指向原文件而非第一份匹配内容。
    let duplicateName,duplicateId
    for(let i=0;!duplicateId;i++) {
      const candidate=`${oldName}-${i}.css`
      const id=`legacy-${createHash('sha256').update(candidate).digest('hex').slice(0,16)}`
      if(id.localeCompare(migratedId)<0){duplicateName=candidate;duplicateId=id}
    }
    const duplicatePath=join(homedir(),'.colamd','themes',duplicateName)
    writeFileSync(duplicatePath,oldCSS)
    createdLegacyFiles.add(duplicatePath)
    createdThemeIds.add(duplicateId)
    await evaluate(renderer,`localStorage.setItem('colamd-theme',${JSON.stringify(`custom:${oldName}`)})`)
    await stop()
    await launch()
    await waitFor(`localStorage.getItem('colamd-theme')===${JSON.stringify(migratedId)}&&getComputedStyle(document.querySelector('.cm-md-atxheading1')).color==='rgb(38, 83, 88)'`, '旧 CSS 启动迁移或选中状态恢复失败')
    check('旧 CSS 启动后纳入统一主题且恢复原选择',await evaluate(renderer,`document.body.dataset.themeId===${JSON.stringify(migratedId)}&&getComputedStyle(document.querySelector('#editor .cm-content')).color==='rgb(49, 65, 89)'`))
    await openSettings()
    await changeField('heading1','styles.heading1.color','#513159')
    await action('save')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '迁移主题保存未完成')
    await waitFor(`getComputedStyle(document.querySelector('.cm-md-atxheading1')).color==='rgb(81, 49, 89)'`, '迁移主题的表单修改未生效')
    const migrated=(await evaluate(renderer,'window.electronAPI.listThemeDefinitions()')).find(theme=>theme.id===migratedId)
    check('迁移主题保存结构化修改并保留未识别兼容规则',migrated.styles.heading1.color==='#513159'&&migrated.extensions.css.includes('@media'),migrated)
    check('旧 CSS 迁移与编辑均保留原文件字节和修改时间',readFileSync(oldPath,'utf8')===oldCSS&&statSync(oldPath).mtimeMs===oldTime)
    const duplicate=(await evaluate(renderer,'window.electronAPI.listThemeDefinitions()')).find(theme=>theme.id===duplicateId)
    check('同内容旧主题按文件身份恢复且保存不改动另一份',duplicate.styles.heading1===undefined&&readFileSync(duplicatePath,'utf8')===oldCSS,duplicate)
    const borderId=`user-verify-border-direction-${Date.now()}`
    createdThemeIds.add(borderId)
    const borderTheme={version:1,id:borderId,name:'旧CSS边线方向验收',appearance:'light',colors:{},typography:{},styles:{},syntax:{},extensions:{css:'#editor .cm-content .cm-md-atxheading1{border-left:3px solid red} #editor .cm-content .cm-md-atxheading2{border-bottom:4px dashed blue} #editor .cm-content .cm-md-hr{border-top:5px dotted green} #editor .cm-content .cm-md-table-widget th{border-left:6px solid purple} #editor .cm-content .cm-md-table-widget td{border-left:7px solid orange}'}}
    await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(borderTheme)})`)
    await setTheme(borderId)
    const borders=await evaluate(renderer,`(() => {
      const read=selector=>{const style=getComputedStyle(document.querySelector(selector));return {left:style.borderLeftWidth,right:style.borderRightWidth,top:style.borderTopWidth,bottom:style.borderBottomWidth,color:style.borderBottomColor,borderStyle:style.borderBottomStyle}}
      return {heading1:read('.cm-md-atxheading1'),heading2:read('.cm-md-atxheading2'),rule:read('.cm-md-hr'),header:read('.cm-md-table-widget th'),cell:read('.cm-md-table-widget td')}
    })()`)
    check('旧标题左边线不会变成下边线',borders.heading1.left==='3px'&&borders.heading1.bottom!=='3px',borders.heading1)
    check('旧表格左边线不会扩散到其他边',borders.header.left==='6px'&&borders.header.bottom!=='6px'&&borders.cell.left==='7px'&&borders.cell.top!=='7px'&&borders.cell.right!=='7px'&&borders.cell.bottom!=='7px',borders)
    await openSettings()
    await changeField('heading2','styles.heading2.borderColor','#008000')
    await changeField('horizontalRule','styles.horizontalRule.borderColor','#800080')
    await action('save')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '边线迁移主题保存未完成')
    const borderSaved=(await evaluate(renderer,'window.electronAPI.listThemeDefinitions()')).find(theme=>theme.id===borderId)
    check('可表达的标题下边线和分隔线上边线完整迁入配置',borderSaved.styles.heading2.borderWidth===4&&borderSaved.styles.heading2.borderStyle==='dashed'&&borderSaved.styles.horizontalRule.borderWidth===5&&borderSaved.styles.horizontalRule.borderStyle==='dotted',borderSaved.styles)
    const repeatedId=`user-verify-repeat-${Date.now()}`
    const repeated={version:1,id:repeatedId,name:'旧CSS层叠验收',appearance:'light',colors:{},typography:{},styles:{},syntax:{},extensions:{css:':root{--text-color:red} :root{--text-color:blue} #editor .cm-content .cm-md-strong{font-style:oblique}'}}
    createdThemeIds.add(repeatedId)
    check('包含schema外合法CSS值的旧主题可正常保存',(await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(repeated)})`)).ok)
    await setTheme(repeatedId)
    await waitFor(`getComputedStyle(document.querySelector('#editor .cm-content')).color==='rgb(0, 0, 255)'`, '旧 CSS 后声明的变量被错误固化覆盖')
    check('旧CSS重复变量遵循后声明优先',await evaluate(renderer,`getComputedStyle(document.querySelector('#editor .cm-content')).color==='rgb(0, 0, 255)'`))
    check('schema外的合法oblique继续通过兼容CSS生效',await evaluate(renderer,`getComputedStyle(document.querySelector('.cm-md-strong')).fontStyle==='oblique'`))
    const scopedId=`user-verify-scoped-${Date.now()}`
    const scoped={...repeated,id:scopedId,name:'旧CSS作用域验收',extensions:{css:'body.theme-custom #editor .cm-content{letter-spacing:1px;line-height:30px}'}}
    createdThemeIds.add(scopedId)
    await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(scoped)})`)
    await setTheme(scopedId)
    await openSettings()
    await waitFor(`!!document.getElementById('theme-settings-preview')?.contentDocument?.querySelector('.cm-content')`, '兼容CSS预览未挂载')
    const scopedMetrics=await evaluate(renderer,`(() => {
      const preview=document.getElementById('theme-settings-preview').contentDocument
      const metrics=(doc,win)=>{const style=win.getComputedStyle(doc.querySelector('#editor .cm-content'));return{letterSpacing:style.letterSpacing,lineHeight:style.lineHeight}}
      return{applied:metrics(document,window),preview:metrics(preview,preview.defaultView)}
    })()`)
    check('旧CSS的body.theme-custom作用域在预览和应用中一致',scopedMetrics.applied.letterSpacing==='1px'&&scopedMetrics.applied.lineHeight==='30px'&&JSON.stringify(scopedMetrics.applied)===JSON.stringify(scopedMetrics.preview),scopedMetrics)
    await action('cancel')
    await waitFor(`!document.getElementById('theme-settings-dialog')`, '兼容CSS面板取消失败')
    const containerId=`user-verify-container-${Date.now()}`
    const containerTheme={...repeated,id:containerId,name:'旧CSS容器排版验收',extensions:{css:'#editor .cm-content{font-size:1.2em;padding-left:30px}'}}
    createdThemeIds.add(containerId)
    await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(containerTheme)})`)
    await setTheme(containerId)
    const containerMetrics=await evaluate(renderer,`(() => {
      const content=document.querySelector('#editor .cm-content'),paragraph=content.querySelector('.cm-md-paragraph')
      return{containerFont:parseFloat(getComputedStyle(content).fontSize),paragraphFont:parseFloat(getComputedStyle(paragraph).fontSize),containerPadding:parseFloat(getComputedStyle(content).paddingLeft),paragraphPadding:parseFloat(getComputedStyle(paragraph).paddingLeft)}
    })()`)
    check('旧CSS容器相对字号不再次施加到段落',Math.abs(containerMetrics.containerFont-19.2)<.01&&Math.abs(containerMetrics.paragraphFont-19.2)<.01,containerMetrics)
    check('旧CSS容器内边距只作用容器而不重复作用段落',containerMetrics.containerPadding===30&&containerMetrics.paragraphPadding===0,containerMetrics)
    const tableBorderId=`user-verify-table-border-${Date.now()}`
    const tableBorderTheme={...structuredClone(custom),id:tableBorderId,name:'表格边线验收',colors:{...custom.colors,tableBorder:'#123abc'}}
    createdThemeIds.add(tableBorderId)
    await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(tableBorderTheme)})`)
    await setTheme(tableBorderId)
    const tableBorderMetrics=await evaluate(renderer,`(() => {
      const article=document.createElement('article');article.className='colamd-document';article.innerHTML=window.__colamdExportDocumentHTML();document.body.appendChild(article)
      const colors=selector=>[...document.querySelectorAll(selector)].map(element=>getComputedStyle(element).borderTopColor)
      const result={editor:colors('#editor .cm-md-table-widget th,#editor .cm-md-table-widget td'),html:colors('.colamd-document th,.colamd-document td')};article.remove();return result
    })()`)
    check('表格边线颜色同时作用编辑器与HTML表头及单元格',tableBorderMetrics.editor.length>=2&&tableBorderMetrics.html.length>=2&&[...tableBorderMetrics.editor,...tableBorderMetrics.html].every(color=>color==='rgb(18, 58, 188)'),tableBorderMetrics)
    const legacyBodyId=`user-verify-body-code-${Date.now()}`
    const legacyBodyTheme={...repeated,id:legacyBodyId,name:'旧CSS正文派生代码色验收',extensions:{css:'body{--bg-color:#111;--text-color:#eee;--code-block-bg:#222}'}}
    createdThemeIds.add(legacyBodyId)
    await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(legacyBodyTheme)})`)
    await setTheme(legacyBodyId)
    const bodyCodeColor=await evaluate(renderer,`(() => {
      const code=[...document.querySelectorAll('#editor .cm-md-codeblock')].find(element=>element.textContent.includes('const sample'))
      const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let ordinary=null
      while(walker.nextNode()){const node=walker.currentNode;if(node.textContent.includes('=')){ordinary=getComputedStyle(node.parentElement).color;break}}
      return{block:getComputedStyle(code).color,ordinary}
    })()`)
    check('旧CSS未设代码文字色时普通代码文字跟随正文色',bodyCodeColor.block==='rgb(238, 238, 238)'&&bodyCodeColor.ordinary==='rgb(238, 238, 238)',bodyCodeColor)
    const layoutFile=join(dir,'排版字段边界.md')
    const layoutFixture=['# 边界验收','','- 列表字号项','','| 表头 |','| --- |','| **表格加粗** |','','> 普通引用首行。','> 普通引用中行。','> 普通引用末行。','','> 嵌套代码引用首行。','>','> ```js','> const nestedCode = 1','> const nestedCodeSecond = 2','> ```','>','> 嵌套代码引用末行。','','```js','const first = 1','const middle = 2','const last = 3','```',''].join('\n')
    writeFileSync(layoutFile,layoutFixture)
    const layoutTime=statSync(layoutFile).mtimeMs
    const layoutId=`user-verify-layout-${Date.now()}`
    createdThemeIds.add(layoutId)
    const layout={...structuredClone(custom),id:layoutId,name:'排版边界验收',styles:{strong:{fontSize:1.5},list:{fontSize:1.5},codeBlock:{fontSize:1.5}}}
    await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(layout)})`)
    await setTheme(layoutId)
    await evaluate(renderer,`window.electronAPI.openFilePath(${JSON.stringify(layoutFile)})`)
    await waitFor(`document.querySelector('#editor .cm-content')?.textContent.includes('边界验收')`, '独立排版夹具未打开')
    await evaluate(renderer,`(() => {const view=document.querySelector('#editor .cm-content').cmTile.root.view;view.viewState.printing=true;view.requestMeasure()})()`)
    await waitFor(`document.querySelector('#editor .cm-content')?.textContent.includes('const middle')&&!!document.querySelector('.cm-md-table-widget strong')`, '完整排版夹具未渲染')
    const layoutMeasure=`(() => {
      const lines=[...document.querySelectorAll('#editor .cm-line')]
      const line=token=>lines.find(element=>element.textContent.includes(token))
      const font=element=>{const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);while(walker.nextNode()){if(!walker.currentNode.textContent.trim()||walker.currentNode.parentElement.closest('.cm-md-li-bullet,.cm-md-listmark,.cm-md-marker'))continue;return parseFloat(getComputedStyle(walker.currentNode.parentElement).fontSize)}}
      const metrics=element=>({top:parseFloat(getComputedStyle(element).paddingTop),bottom:parseFloat(getComputedStyle(element).paddingBottom)})
      const list=line('列表字号项'),bullet=list.querySelector('.cm-md-li-bullet,.cm-md-listmark'),table=document.querySelector('.cm-md-table-widget strong'),code=line('const middle')
      return{listFont:font(list),bulletFont:parseFloat(getComputedStyle(bullet).fontSize),bullet:metrics(bullet),tableFont:font(table),codeFont:font(code),quoteFirst:metrics(line('普通引用首行')),quoteMiddle:metrics(line('普通引用中行')),quoteLast:metrics(line('普通引用末行')),nestedFirst:metrics(line('嵌套代码引用首行')),nestedLast:metrics(line('嵌套代码引用末行')),nestedCode:metrics(line('const nestedCodeSecond')),codeMiddle:metrics(code),codeFirst:metrics(document.querySelector('.cm-md-codeblock-first:not(.cm-md-blockquote)')),codeLast:metrics(document.querySelector('.cm-md-codeblock-last:not(.cm-md-blockquote)'))}
    })()`
    const layoutBefore=await evaluate(renderer,layoutMeasure)
    check('列表字号只放大一次且标记不承接段落内边距',layoutBefore.listFont===24&&layoutBefore.bulletFont===24&&layoutBefore.bullet.top===0&&layoutBefore.bullet.bottom===0,layoutBefore)
    check('表格中的粗体字号只放大一次',layoutBefore.tableFont===24,layoutBefore)
    check('编辑器代码块字号按正文倍率只放大一次',layoutBefore.codeFont===24,layoutBefore)
    layout.styles.quote={spacingBefore:1,spacingAfter:2}
    layout.styles.codeBlock={fontSize:1.5,spacingBefore:1,spacingAfter:2}
    await evaluate(renderer,`window.electronAPI.saveThemeDefinition(${JSON.stringify(layout)})`)
    await waitFor(`parseFloat(getComputedStyle(document.querySelector('.cm-md-codeblock-first:not(.cm-md-blockquote)')).paddingTop)===24`, '代码块首行间距未应用')
    const layoutAfter=await evaluate(renderer,layoutMeasure)
    check('多源行引用只在整个引用首尾添加间距',layoutAfter.quoteFirst.top===16&&layoutAfter.quoteLast.bottom===32&&JSON.stringify(layoutAfter.quoteMiddle)===JSON.stringify(layoutBefore.quoteMiddle),{before:layoutBefore,after:layoutAfter})
    check('含代码的引用按外层引用边界确定首尾间距',layoutAfter.nestedFirst.top===16&&layoutAfter.nestedLast.bottom===32&&JSON.stringify(layoutAfter.nestedCode)===JSON.stringify(layoutBefore.nestedCode),{before:layoutBefore,after:layoutAfter})
    check('多源行代码块仅首尾行改变间距',layoutAfter.codeFirst.top===24&&layoutAfter.codeLast.bottom===48&&JSON.stringify(layoutAfter.codeMiddle)===JSON.stringify(layoutBefore.codeMiddle),{before:layoutBefore,after:layoutAfter})
    const layoutHTML=await evaluate(renderer,`(() => {const article=document.createElement('article');article.className='colamd-document';article.innerHTML=window.__colamdExportDocumentHTML();document.body.appendChild(article);const code=article.querySelector('pre code'),result={pre:parseFloat(getComputedStyle(code.parentElement).fontSize),code:parseFloat(getComputedStyle(code).fontSize)};article.remove();return result})()`)
    check('HTML代码块实际code字体与编辑器倍率一致',layoutHTML.pre===24&&layoutHTML.code===24,layoutHTML)
    check('排版字段验证不修改独立夹具内容和修改时间',readFileSync(layoutFile,'utf8')===layoutFixture&&statSync(layoutFile).mtimeMs===layoutTime)
    await evaluate(renderer,`window.electronAPI.openFilePath(${JSON.stringify(file)})`)
    await waitFor(`document.querySelector('#editor .cm-content')?.textContent.includes('一级标题')`, '排版验收后未恢复原夹具')
  }
  check('主题操作未改写 Markdown 文件', readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalTime)
  if (!baselineMode) console.log(`主题配置验收通过，共 ${passed} 项。`)
} finally {
  if(renderer) {
    for(const id of createdThemeIds) await evaluate(renderer,`window.electronAPI.deleteThemeDefinition(${JSON.stringify(id)})`).catch(()=>{})
    if(main) await evaluate(main,`(() => {if(globalThis.__themeOriginalDialogs)Object.assign(require('electron').dialog,globalThis.__themeOriginalDialogs)})()`).catch(()=>{})
  }
  renderer?.close()
  main?.close()
  child?.kill('SIGTERM')
  stopVerifyApp(udd)
  // 删除范围只包含本脚本创建的随机主题标识，失败时也不留用户主题目录残渣。
  for(const id of createdThemeIds)rmSync(join(homedir(),'.colamd','themes',`${encodeURIComponent(id)}.theme.json`),{force:true})
  for(const path of createdLegacyFiles)rmSync(path,{force:true})
  for(const path of createdRecoveryFiles)rmSync(path,{force:true})
}
