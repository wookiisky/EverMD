// 导航观察器在真实 CodeMirror 状态上验证，文件读取由外壳适配器提供。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: `export {EditorNavigation} from './src/renderer/editor-navigation'; export {SearchPanel} from './src/renderer/editor/search-panel'; export {SourceInputEvent} from './src/renderer/editor/editor-source-input'; export {runFormatCommand} from './src/renderer/editor/format-commands'; export {Text,ChangeSet} from '@codemirror/state';`, resolveDir: process.cwd() },
  bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'editor-host', setup(build) {
    build.onResolve({ filter: /\.\/editor\/core$/ }, () => ({ path: 'core', namespace: 'host' }))
    build.onResolve({ filter: /^\.\/editor$/ }, () => ({ path: 'editor', namespace: 'host' }))
    build.onResolve({ filter: /\.\/editor\/source-line$/ }, () => ({ path: 'source', namespace: 'host' }))
    build.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ contents: path === 'core'
      ? `export const getEditorHandle = () => ({getView: () => globalThis.navigationHost.view}); export function onEditorUpdate(listener) { globalThis.navigationHost.listener = listener; return () => {globalThis.navigationHost.listener = null} }`
      : path === 'editor' ? `export const getEditorView = () => globalThis.navigationHost.view;`
      : `export const sourcePositionTop = (_source, position) => position;` }))
  } }],
})
const { EditorState } = await import('@codemirror/state')
const text = Array.from({ length: 60 }, (_, i) => `${i}: ${'正文'.repeat(50)}`).join('\n')
const source = new EventTarget()
let focusCalls = 0, scrollEffects = 0
Object.assign(source, { value: text, selectionStart: 0, selectionEnd: 0, selectionDirection: 'forward', scrollTop: 0, clientHeight: 600,
  focus() { focusCalls++ }, setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } })
const host = globalThis.navigationHost = { listener: null, view: {
  state: EditorState.create({ doc: text }), scrollDOM: { scrollTop: 0, clientHeight: 600, getBoundingClientRect: () => ({top: 0}) },
  get documentTop() { return -this.scrollDOM.scrollTop },
  lineBlockAtHeight(top) { return this.lineBlockAt(Math.max(0, Math.min(top, this.state.doc.length))) },
  lineBlockAt(position) { const line = this.state.doc.lineAt(position); return { from: line.from, top: line.from } },
  requestMeasure(request) { const value = request.read(); request.write?.(value) },
  scrollSnapshot() { return undefined },
  viewportLineBlocks: [],
  coordsAtPos: () => ({ top: 100 }), focus() { focusCalls++ },
  dispatch(spec) { const transaction = this.state.update(spec); const startState = this.state; this.state = transaction.state;
    if (spec.effects) scrollEffects++
    host.listener?.({ state: this.state, startState, changes: transaction.changes, docChanged: transaction.docChanged, selectionSet: !!spec.selection, transactions: [transaction], view: this }) },
} }
const { EditorNavigation, SearchPanel, SourceInputEvent, runFormatCommand, Text: SourceText, ChangeSet: SourceChanges } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
let identity = { filePath: '/a.md', tabId: 'one' }, sourceMode = false, nextResult = 'ok', opens = []
const nav = new EditorNavigation({ source, getIdentity: () => identity, isSourceMode: () => sourceMode,
  isProgrammatic: () => false, open: async anchor => { opens.push(anchor.filePath); if (nextResult === 'ok') identity = {filePath:anchor.filePath,tabId:anchor.tabId}; return nextResult; } })
nav.initialize()
const move = line => host.view.dispatch({ selection: { anchor: host.view.state.doc.line(line).from } })
const settle = () => new Promise(resolve => setTimeout(resolve, 520))
move(20); move(30); await settle()
await nav.navigate(-1)
assert.equal(host.view.state.selection.main.head, 0, '连续光标移动合并且保留最初起点')
await nav.navigate(1)
assert.equal(host.view.state.doc.lineAt(host.view.state.selection.main.head).number, 30, '前进恢复最后停留点')
move(50)
host.view.dispatch({ changes: { from: 0, insert: '新行\n' } })
await settle()
host.view.dispatch({selection:{anchor:host.view.state.selection.main.head+1}})
await settle(); await nav.navigate(-1)
assert.equal(host.view.state.selection.main.head, 3, '输入取消待记录跳转，并映射旧锚点')
await nav.navigate(1)
nav.beforeSwitch(); identity = {filePath:'/b.md',tabId:'one'}; host.view.state = EditorState.create({doc:text}); nav.afterSwitch()
nextResult = 'cancelled'; await nav.navigate(-1)
assert.equal(identity.filePath, '/b.md', '打开失败不改变当前身份')
nextResult = 'ok'; await nav.navigate(-1)
assert.equal(identity.filePath, '/a.md', '同一个标签替换文件仍按路径恢复')
sourceMode = true
nav.withoutRecording(() => { source.value = text; source.setSelectionRange(0,0,'forward') })
source.setSelectionRange(1100,1200,'backward'); source.dispatchEvent(new Event('select')); await settle()
await nav.navigate(-1); await nav.navigate(1)
assert.equal(source.selectionStart,1100); assert.equal(source.selectionEnd,1200); assert.equal(source.selectionDirection,'backward')
source.scrollTop = 900; source.dispatchEvent(new Event('scroll')); await settle()
await nav.navigate(-1)
assert.equal(source.selectionStart,0,'纯滚动没有额外导航节点')
nav.dispose()
sourceMode = false
identity = {filePath:'/a.md',tabId:'one'}
host.view.state = EditorState.create({doc:text})
const unavailable = new Set(['/b.md'])
let pendingOpens = 0, maxPendingOpens = 0
const nav2 = new EditorNavigation({source, getIdentity:()=>identity, isSourceMode:()=>sourceMode, isProgrammatic:()=>false,
  open:async anchor=>{
    pendingOpens++; maxPendingOpens=Math.max(maxPendingOpens,pendingOpens)
    await new Promise(resolve=>setTimeout(resolve,5)); pendingOpens--
    if(unavailable.has(anchor.filePath)) return 'missing'
    identity={filePath:anchor.filePath,tabId:anchor.tabId}; return 'ok'
  }})
nav2.initialize()
nav2.beforeSwitch(); identity={filePath:'/b.md',tabId:'one'}; nav2.afterSwitch()
nav2.beforeSwitch(); identity={filePath:'/c.md',tabId:'one'}; nav2.afterSwitch()
await nav2.navigate(-1)
assert.equal(identity.filePath,'/a.md','缺失文件被移除且继续寻找前一条')
await Promise.all([nav2.navigate(1),nav2.navigate(-1)])
assert.equal(identity.filePath,'/a.md','快速前进后退按请求顺序完成')
assert.equal(maxPendingOpens,1,'跨文件打开不会并发')
nav2.withoutRecording(()=>{sourceMode=true;source.value=text;source.setSelectionRange(0,0,'forward')})
source.dispatchEvent(new Event('select'))
await settle(); await nav2.navigate(1)
assert.equal(identity.filePath,'/c.md','模式切换与迟到选区事件保留前进分支')
nav2.dispose()
sourceMode=false; identity={filePath:'/a.md',tabId:'one'}; host.view.state=EditorState.create({doc:text})
let programmatic=false
const nav3=new EditorNavigation({source,getIdentity:()=>identity,isSourceMode:()=>sourceMode,isProgrammatic:()=>programmatic,
  open:async anchor=>{identity={filePath:anchor.filePath,tabId:anchor.tabId};return 'ok'}})
nav3.initialize();move(20);await settle()
programmatic=true
host.view.state=EditorState.create({doc:'新一行\n最后一行'})
focusCalls=0;scrollEffects=0
nav3.reloaded();programmatic=false
assert.equal(host.view.state.doc.lineAt(host.view.state.selection.main.head).number,2,'外部文本变短后按行列夹限恢复')
assert.equal(focusCalls,0,'渲染模式热更新不抢走输入框焦点')
assert.equal(scrollEffects,0,'渲染模式热更新不滚回历史光标')
await nav3.navigate(-1)
assert.equal(host.view.state.selection.main.head,0,'外部重载不增加历史')
nav3.withoutRecording(()=>{sourceMode=true;source.value=text;source.setSelectionRange(0,0,'forward')})
host.view.dispatch({selection:{anchor:5}})
source.dispatchEvent(new Event('select'));await settle();await nav3.navigate(1)
assert.equal(source.selectionStart,text.indexOf('\n')+1,'源码模式忽略后台 CodeMirror 选区')
nav3.dispose()
console.log('通过：防抖起点、输入映射、失败重试、跨文件身份、源码反向选区、滚动排除、缺失文件跳过、连续回放串行、模式切换不切断前进、重载夹限、后台选区隔离')

// 明确的大纲/锚点跳转前，要收妥尚在防抖中的起点。
sourceMode=false;identity={filePath:'/jump.md',tabId:'jump'};host.view.state=EditorState.create({doc:text})
const nav4=new EditorNavigation({source,getIdentity:()=>identity,isSourceMode:()=>false,isProgrammatic:()=>false,open:async()=> 'ok'})
nav4.initialize();move(10)
host.view.dispatch({selection:{anchor:host.view.state.doc.line(40).from},userEvent:'select.jump'})
await nav4.navigate(-1)
assert.equal(host.view.state.doc.lineAt(host.view.state.selection.main.head).number,10,'明确跳转保留尚未停稳的起点')
nav4.dispose()

// 空白标签重开已关闭文件会移除当前位置，回放目标不能再按相邻索引查找。
for (const mode of [false, true]) {
  for (const direction of [-1, 1]) {
    for (const earlier of [false, true]) {
      sourceMode = mode
      const load = (filePath, line = 1) => {
        identity = { filePath, tabId: filePath ?? 'blank' }
        host.view.state = EditorState.create({ doc: text, selection: { anchor: 0 } })
        const position = host.view.state.doc.line(line).from
        host.view.state = host.view.state.update({ selection: { anchor: position } }).state
        source.value = text
        source.setSelectionRange(position, position, 'forward')
      }
      load(earlier ? '/earlier.md' : '/target.md', earlier ? 5 : 40)
      let replayNav
      replayNav = new EditorNavigation({ source, getIdentity: () => identity, isSourceMode: () => sourceMode,
        isProgrammatic: () => false, open: async target => {
          if (identity.filePath === null && target.filePath) replayNav.closed(identity.tabId, null)
          load(target.filePath)
          replayNav.reloaded()
          return 'ok'
        } })
      replayNav.initialize()
      const visit = (filePath, line = 1) => {
        replayNav.beforeSwitch(); load(filePath, line); replayNav.afterSwitch()
      }
      if (earlier) visit('/target.md', 40)
      visit(null)
      if (direction === 1) {
        visit('/target.md', 40)
        await replayNav.navigate(-1)
      }
      await replayNav.navigate(direction)
      const actual = mode ? source.selectionStart : host.view.state.selection.main.head
      assert.equal(identity.filePath, '/target.md', '重开后文档身份正确')
      assert.equal(actual, host.view.state.doc.line(40).from,
        `${mode ? '源码' : '渲染'}${direction < 0 ? '后退' : '前进'}在删除空白当前位置后恢复原目标，不使用移动后的相邻项`)
      replayNav.dispose()
    }
  }
}
console.log('通过：两种模式前进与后退重用空白标签后，仍恢复目标文件原位置')

// 阅读滚动不移动光标；跨文件回退仍应恢复离开时的阅读视口。
sourceMode = true
identity = { filePath: '/reading.md', tabId: 'reading' }
source.value = text; source.setSelectionRange(0, 0, 'forward'); source.scrollTop = 900
const readingNav = new EditorNavigation({ source, getIdentity: () => identity, isSourceMode: () => true,
  isProgrammatic: () => false, open: async target => {
    const sameFile = identity.filePath === target.filePath
    identity = { filePath: target.filePath, tabId: target.tabId }
    if (!sameFile) { source.value = text; source.setSelectionRange(0, 0, 'forward'); source.scrollTop = 0 }
    return 'ok'
  } })
readingNav.initialize(); readingNav.beforeSwitch()
identity = { filePath: '/skill.md', tabId: 'skill' }; source.scrollTop = 0
readingNav.afterSwitch(); await readingNav.navigate(-1)
assert.equal(identity.filePath, '/reading.md', '一次回退返回阅读原文')
assert.equal(source.selectionStart, 0, '恢复阅读位置不移动旧光标')
assert.equal(source.scrollTop, 900, '恢复阅读视口，而不是滚到仍留在文首的光标')
source.setSelectionRange(4000, 4000, 'forward'); source.dispatchEvent(new Event('select')); await settle()
source.value = '新增行\n' + text
source.setSelectionRange(4004, 4004, 'forward'); source.dispatchEvent(new Event('input'))
source.scrollTop = 904
await readingNav.navigate(-1)
assert.equal(source.selectionStart, 4, '历史选区跟随文首输入映射')
assert.equal(source.scrollTop, 904, '历史阅读视口也跟随文首输入映射')
readingNav.dispose()
sourceMode = false
source.value = text
host.view.state = EditorState.create({ doc: text })
host.view.scrollDOM.scrollTop = 900
identity = { filePath: '/render-reading.md', tabId: 'render-reading' }
const renderedReadingNav = new EditorNavigation({ source, getIdentity: () => identity, isSourceMode: () => false,
  isProgrammatic: () => false, open: async target => {
    identity = { filePath: target.filePath, tabId: target.tabId }
    host.view.scrollDOM.scrollTop = 0
    return 'ok'
  } })
renderedReadingNav.initialize(); renderedReadingNav.beforeSwitch()
identity = { filePath: '/render-skill.md', tabId: 'render-skill' }; host.view.scrollDOM.scrollTop = 0
renderedReadingNav.afterSwitch(); await renderedReadingNav.navigate(-1)
assert.equal(host.view.scrollDOM.scrollTop, 900, '渲染模式独立恢复阅读视口')
assert.equal(host.view.state.selection.main.head, 0, '渲染模式也保留屏外的旧光标')
const immediateMeasure = host.view.requestMeasure
const pendingMeasures = []
host.view.requestMeasure = request => { pendingMeasures.push(request) }
await renderedReadingNav.navigate(1); await renderedReadingNav.navigate(-1)
await renderedReadingNav.navigate(1); await renderedReadingNav.navigate(-1)
await renderedReadingNav.navigate(-1)
for (const request of pendingMeasures) request.write(request.read())
await Promise.resolve()
assert.equal(host.view.scrollDOM.scrollTop, 900, '布局尚未完成时连续回放，也不能用临时视口覆盖历史')
// 回放测量前允许继续编辑，旧文档的恢复不能覆盖新的阅读位置。
pendingMeasures.length = 0
await renderedReadingNav.navigate(1); await renderedReadingNav.navigate(-1)
host.view.dispatch({ changes: { from: 0, insert: '新增行\n' } })
host.view.scrollDOM.scrollTop = 450
await renderedReadingNav.navigate(1); await renderedReadingNav.navigate(-1)
for (const request of pendingMeasures) request.write(request.read())
await Promise.resolve()
assert.equal(host.view.scrollDOM.scrollTop, 450, '恢复测量前编辑后，离开时保存实际视口，不复用旧锚点')
host.view.requestMeasure = immediateMeasure
renderedReadingNav.dispose()
host.view.scrollDOM.scrollTop = 0
console.log('通过：两种模式独立恢复阅读视口，编辑同时映射历史选区与视口')

// 重开时磁盘内容变短，固定目标仍要读取按新正文夹限后的行列。
for (const mode of [false, true]) {
  sourceMode = mode; identity = { filePath: '/shorter.md', tabId: 'closed' }
  host.view.state = EditorState.create({ doc: text, selection: { anchor: text.indexOf('39:') } })
  source.value = text; source.setSelectionRange(text.indexOf('39:'), text.indexOf('39:'), 'forward')
  let reloadNav
  reloadNav = new EditorNavigation({ source, getIdentity: () => identity, isSourceMode: () => sourceMode,
    isProgrammatic: () => false, open: async target => {
      reloadNav.closed(identity.tabId, null)
      identity = { filePath: target.filePath, tabId: 'blank' }
      const shorter = text.split('\n').slice(0, 30).join('\n')
      host.view.state = EditorState.create({ doc: shorter })
      source.value = shorter; source.setSelectionRange(0, 0, 'forward')
      reloadNav.reloaded()
      return 'ok'
    } })
  reloadNav.initialize(); reloadNav.beforeSwitch()
  identity = { filePath: null, tabId: 'blank' }
  host.view.state = EditorState.create({ doc: '' }); source.value = ''; source.setSelectionRange(0, 0, 'forward')
  reloadNav.afterSwitch(); await reloadNav.navigate(-1)
  assert.equal(mode ? source.selectionStart : host.view.state.selection.main.head, host.view.state.doc.line(30).from,
    '删除空白记录后重开变短文件，恢复映射后的目标而非打开前的旧偏移')
  reloadNav.dispose()
}
console.log('通过：重开变短文件后，两种模式均采用映射后的目标位置')

// 走搜索面板真实的全部替换入口，验证不连续修改之间的锚点与替换长度无关。
for (const replacement of ['Y', '更长的替换', '', '$&']) {
  const original='X\n'+'a'.repeat(100)+'\n'+'b'.repeat(100)+'\nX'
  sourceMode=true;identity={filePath:'/replace.md',tabId:'replace'}
  source.value=original;source.setSelectionRange(0,0,'forward')
  const batchNav=new EditorNavigation({source,getIdentity:()=>identity,isSourceMode:()=>true,isProgrammatic:()=>false,open:async()=> 'ok'})
  batchNav.initialize()
  for (const position of [102,203]) {
    source.setSelectionRange(position,position,'forward');source.dispatchEvent(new Event('select'));await settle()
  }
  const panel=Object.create(SearchPanel.prototype)
  Object.assign(panel,{input:{value:'X'},replaceInput:{value:replacement},matches:[{from:0,to:1},{from:204,to:205}],
    getSourceEditor:()=>source,searchSourceEditor() {}})
  panel.replaceAll()
  assert.equal(source.value,original.replaceAll('X',()=>replacement),'全部替换保留替换文本的字面值')
  await batchNav.navigate(-1)
  assert.equal(source.selectionStart,102+replacement.length-1,'全部替换保留中间未修改段落的历史位置')
  source.scrollTop=75;focusCalls=0
  batchNav.reloaded()
  assert.equal(focusCalls,0,'源码模式热更新不抢走输入框焦点')
  assert.equal(source.scrollTop,75,'源码模式热更新不滚回历史光标')
  batchNav.dispose()
}
console.log('通过：热更新不聚焦或滚动，源码全部替换映射等长、增长、删除及含替换符的修改')

// 只读的约束落在真实 EditorState，而非仅依赖 contenteditable DOM。
const stateBundle=await build({stdin:{contents:`export {stateExtensions,editableCompartment} from './src/renderer/editor/state';export {EditorState} from '@codemirror/state';export {undo,deleteLine,undoDepth} from '@codemirror/commands';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'})
const readonly=await import('data:text/javascript;base64,'+Buffer.from(stateBundle.outputFiles[0].text).toString('base64'))
let state=readonly.EditorState.create({doc:'原文',extensions:[readonly.stateExtensions(),readonly.editableCompartment.of(readonly.EditorState.readOnly.of(false))]})
state=state.update({changes:{from:state.doc.length,insert:'新增'}}).state
state=state.update({effects:readonly.editableCompartment.reconfigure(readonly.EditorState.readOnly.of(true))}).state
const readonlyView={get state(){return state},dispatch(transaction){state=transaction.state}}
assert.equal(readonly.undo(readonlyView),false,'只读期间撤销不执行')
assert.equal(readonly.deleteLine(readonlyView),false,'只读期间删除行不执行')
state=state.update({changes:{from:0,to:state.doc.length,insert:'不应写入'}}).state
assert.equal(state.doc.toString(),'原文新增','自定义写入事务也被只读过滤')
assert.equal(readonly.undoDepth(state),1,'被拒绝的写入不污染撤销栈')
state=state.update({effects:readonly.editableCompartment.reconfigure(readonly.EditorState.readOnly.of(false))}).state
assert.equal(readonly.undo(readonlyView),true,'恢复编辑后仍可正常撤销')
assert.equal(state.doc.toString(),'原文')
console.log('通过：明确跳转收妥起点、只读命令/事务保护、恢复编辑后撤销栈保持')


// 长文档源码选择不重新构建全文；真实编辑只构建改动片段，历史仍使用新正文。
const longSource = Array.from({length: 4000}, (_, index) => `段落 ${index}：${'正文'.repeat(20)}`).join('\n')
sourceMode = true; identity = {filePath: '/large-source.md', tabId: 'large'}
source.value = longSource; source.setSelectionRange(0, 0, 'forward')
let sourceProgrammatic = false
const cachedNav = new EditorNavigation({source, getIdentity: () => identity, isSourceMode: () => sourceMode,
  isProgrammatic: () => sourceProgrammatic, open: async () => 'ok'})
cachedNav.initialize()
const originalTextOf = SourceText.of
let fullSourceBuilds = 0
SourceText.of = function(lines) {
  if (lines.length > 1000) fullSourceBuilds++
  return originalTextOf.call(this, lines)
}
try {
  for (let index = 1; index <= 20; index++) {
    source.setSelectionRange(index, index + 2, 'backward')
    source.dispatchEvent(new Event('select'))
  }
  assert.equal(fullSourceBuilds, 0, '纯源码选区更新复用现有文本结构，不重建长文档')
  source.value = longSource.slice(0, 10) + '新增\n' + longSource.slice(10)
  source.setSelectionRange(13, 13, 'forward'); source.dispatchEvent(new Event('input'))
  assert.equal(cachedNav.document().toString(), source.value, '原生输入后的导航文本与实际正文一致')
  assert.equal(fullSourceBuilds, 0, '原生局部编辑只创建变更片段')
  const changes = SourceChanges.of([{from: 5, to: 8, insert: '替换'}, {from: 2000, to: 2010, insert: '批量\n修改'}], source.value.length)
  source.value = changes.apply(cachedNav.document()).toString()
  source.setSelectionRange(0, 0, 'forward'); source.dispatchEvent(new SourceInputEvent(changes))
  assert.equal(cachedNav.document().toString(), source.value, '不连续变更应用到同一份导航文本')
  assert.equal(fullSourceBuilds, 0, '带ChangeSet的批量编辑复用未变化片段')
  sourceProgrammatic = true
  source.value = '外部重载\n新正文'; source.dispatchEvent(new Event('input'))
  sourceProgrammatic = false
  assert.equal(cachedNav.document().toString(), source.value, '程序化替换后丢弃旧文本结构')
  source.value = '切换文件\n另一个版本'; identity = {filePath: '/next-source.md', tabId: 'next'}
  cachedNav.afterSwitch()
  assert.equal(cachedNav.document().toString(), source.value, '切标签后导航读取新文本')
} finally {
  SourceText.of = originalTextOf
  cachedNav.dispose()
}
console.log('通过：长文档源码选择零次全文构建，原生/批量输入增量更新，程序化替换与切标签正确失效')

// 包裹式格式命令只需选区附近的字节，文档很长也不必序列化全文。
for (const [id, marker] of [['bold', '**'], ['italic', '*'], ['inlineCode', '`'], ['strikethrough', '~~']]) {
  let formatState = EditorState.create({doc: `${marker}正文${marker}\n${longSource}`, selection: {anchor: marker.length, head: marker.length + 2}})
  const originalDocument = formatState.doc
  originalDocument.toString = () => { throw new Error('局部格式命令不应读取全文') }
  const view = {get state() { return formatState }, hasFocus: true, focus() {}, dispatch(spec) { formatState = formatState.update(spec).state }}
  try { runFormatCommand(view, id) } finally { delete originalDocument.toString }
  assert.equal(formatState.doc.sliceString(0, 2), '正文', `${id} 正确移除包裹标记`)
  assert.equal(formatState.selection.main.from, 0)
  assert.equal(formatState.selection.main.to, 2)
}
console.log('通过：加粗、斜体、行内代码和删除线命令只读局部文本')

// 搜索动作必须先核对实际正文，不能把旧标签或旧版本的命中位置写进当前文件。
const searchSource = new EventTarget()
Object.assign(searchSource, {value: '', readOnly: false, selectionStart: 0, selectionEnd: 0,
  focus() {}, setSelectionRange(from, to) { this.selectionStart = from; this.selectionEnd = to },
  setRangeText(replacement, from, to) { this.value = this.value.slice(0, from) + replacement + this.value.slice(to) }})
let searchSourceMode = false
const searchPanel = Object.create(SearchPanel.prototype)
Object.assign(searchPanel, {input: {value: 'target', focus() {}}, replaceInput: {value: 'Z'}, countEl: {textContent: ''},
  matches: [], currentIndex: -1, beforeNavigate() {}, getSourceEditor: () => searchSourceMode ? searchSource : null})
host.listener = null
host.view.state = EditorState.create({doc: 'target first target'})
searchPanel.search()
assert.deepEqual(searchPanel.matches, [{from: 0, to: 6}, {from: 13, to: 19}])
host.view.dispatch({changes: {from: 0, insert: 'new '}})
searchPanel.next()
assert.deepEqual(searchPanel.matches, [{from: 4, to: 10}, {from: 17, to: 23}], '编辑后下一项重算真实位置')
host.view.state = EditorState.create({doc: 'different target document'})
searchPanel.replaceCurrent()
assert.equal(host.view.state.doc.toString(), 'different Z document', '切标签后替换只命中当前文件匹配')
searchSourceMode = true; searchSource.value = 'source target text'
searchPanel.search()
searchSource.value = 'prefix source target text'
searchPanel.replaceCurrent()
assert.equal(searchSource.value, 'prefix source Z text', '源码值改变后替换不使用旧匹配位置')
searchSource.value = 'other only'; searchPanel.next()
assert.deepEqual(searchPanel.matches, [], '切换到无匹配的源码内容后旧命中失效')
assert.equal(searchPanel.countEl.textContent, '0/0')
searchSourceMode = false; host.view.state = EditorState.create({doc: 'same same'})
searchPanel.input.value = 'same'; searchPanel.search()
const originalLowercase = String.prototype.toLowerCase
let documentLowercases = 0
String.prototype.toLowerCase = function() {
  if (String(this) === 'same same') documentLowercases++
  return originalLowercase.call(this)
}
try {
  searchPanel.input.value = 'sa'; searchPanel.search()
  searchPanel.input.value = 'same'; searchPanel.search()
  assert.equal(documentLowercases, 0, '同文档连续查询复用大小写转换结果')
} finally { String.prototype.toLowerCase = originalLowercase }
console.log('通过：查找复用当前文档分析，编辑/标签/模式变化后的导航与替换核对真实匹配')
