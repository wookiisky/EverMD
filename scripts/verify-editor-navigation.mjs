// 导航观察器在真实 CodeMirror 状态上验证，文件读取由外壳适配器提供。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: `export {EditorNavigation} from './src/renderer/editor-navigation'; export {SearchPanel} from './src/renderer/editor/search-panel';`, resolveDir: process.cwd() },
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
  state: EditorState.create({ doc: text }), scrollDOM: { clientHeight: 600, getBoundingClientRect: () => ({top: 0}) },
  coordsAtPos: () => ({ top: 100 }), focus() { focusCalls++ },
  dispatch(spec) { const transaction = this.state.update(spec); const startState = this.state; this.state = transaction.state;
    if (spec.effects) scrollEffects++
    host.listener?.({ state: this.state, startState, changes: transaction.changes, docChanged: transaction.docChanged, selectionSet: !!spec.selection, transactions: [transaction], view: this }) },
} }
const { EditorNavigation, SearchPanel } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
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
