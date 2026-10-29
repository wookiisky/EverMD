// 文档安装在真实 EditorState 边界验证；启动交付只替代 Electron 窗口。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import ts from 'typescript'

const bundle = await build({
  stdin: { contents: `
    export { createDocumentState, configureDocumentState, taskMarkerRanges } from './src/renderer/editor/core';
    export { stateExtensions } from './src/renderer/editor/state';
    export { livePreview, livePreviewField, documentFileUrlField, editorFocusField } from './src/renderer/editor/live-preview';
    export { hideBlankLinesField } from './src/renderer/editor/blank-line-visibility';
    export { searchHighlightField, setSearchHighlight } from './src/renderer/editor/search-highlight';
    export { undo, undoDepth } from '@codemirror/commands';
    export { Decoration } from '@codemirror/view';
    export { forceParsing, syntaxTree } from '@codemirror/language';
  `, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
})
const { createDocumentState, configureDocumentState, taskMarkerRanges, stateExtensions,
  livePreview, livePreviewField, documentFileUrlField, editorFocusField, hideBlankLinesField,
  searchHighlightField, setSearchHighlight, undo, undoDepth, Decoration, forceParsing, syntaxTree } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const extensions = [stateExtensions(), livePreview, searchHighlightField]
const decorations = state => {
  const result = { images: [], hidden: [] }
  state.field(livePreviewField).between(0, state.doc.length, (from, _to, decoration) => {
    if (typeof decoration.spec.widget?.src === 'string') result.images.push(decoration.spec.widget.src)
    if (decoration.spec.class === 'cm-md-blank-line-hidden') result.hidden.push(state.doc.lineAt(from).number)
  })
  return result
}
const original = '---\ntitle: example\n---\n\n正文\n\n![图片](images/a.png)\n'
let state = createDocumentState(original, extensions, { fileUrl: 'file:///a/document.md', hideBlankLines: true })
assert.equal(state.doc.toString(), original, '一次安装不修改文件字节')
assert.equal(state.field(documentFileUrlField), 'file:///a/document.md')
assert.equal(state.field(hideBlankLinesField), true)
assert.equal(state.doc.lineAt(state.selection.main.head).number, 4, '新文档光标在属性区之后')
assert.equal(undoDepth(state), 0)
assert.deepEqual(decorations(state).images, ['file:///a/images/a.png'], '首次装饰直接使用目标文件路径')
assert(decorations(state).hidden.includes(6), '首次装饰直接使用隐藏空行偏好')

state = state.update({ changes: { from: state.doc.length, insert: '用户输入' }, userEvent: 'input.type' }).state
state = state.update({ selection: { anchor: 6, head: 4 },
  effects: setSearchHighlight.of(Decoration.set([Decoration.mark({ class: 'test-match' }).range(4, 6)])) }).state
const snapshot = state
const historyDepth = undoDepth(snapshot)
assert(historyDepth > 0)
const restored = configureDocumentState(snapshot, { fileUrl: 'file:///b/document.md', hideBlankLines: false })
assert.equal(restored.doc, snapshot.doc, '恢复快照复用原文档对象')
assert(restored.selection.eq(snapshot.selection), '反向选区保持不变')
assert.equal(undoDepth(restored), historyDepth, '更新偏好不增加或清除撤销记录')
assert.equal(restored.field(searchHighlightField), snapshot.field(searchHighlightField), '搜索装饰保留')
assert.deepEqual(decorations(restored).images, ['file:///b/images/a.png'])
assert.deepEqual(decorations(restored).hidden, [])
assert.equal(snapshot.field(documentFileUrlField), 'file:///a/document.md', '更新配置不污染其他快照')
assert.equal(configureDocumentState(restored, { fileUrl: 'file:///b/document.md', hideBlankLines: false }), restored,
  '配置未变时直接复用状态，不创建无效事务')
assert.equal(configureDocumentState(restored), restored, '省略配置保留快照自己的路径和偏好')
const untitled = configureDocumentState(restored, { fileUrl: null })
assert.equal(untitled.field(documentFileUrlField), null, '显式 null 清除旧文档路径')
assert.deepEqual(decorations(untitled).images, ['images/a.png'], '无路径文档不沿用上个标签的图片基准')
assert.deepEqual(decorations(configureDocumentState(snapshot)).images, ['file:///a/images/a.png'],
  '切回旧快照恢复其自己的图片路径')
let undone = restored
assert(undo({ state: undone, dispatch: transaction => { undone = transaction.state } }))
assert.equal(undone.doc.toString(), original, '恢复后仍能撤销原标签的编辑')

const fresh = createDocumentState('另一篇\n', extensions, { fileUrl: null, hideBlankLines: true }, true)
assert.equal(undoDepth(fresh), 0, '安装新文档清除历史')
assert.equal(fresh.field(searchHighlightField).size, 0, '新文档不残留搜索结果')
assert.equal(fresh.field(editorFocusField), true, '初始焦点在创建装饰前安装')
assert.equal(fresh.field(documentFileUrlField), null)
assert.equal(fresh.selection.main.head, 0)
console.log('通过：新文档一次初始化、相对图片路径、偏好、反向选区、快照隔离、搜索与撤销')

let tasks = createDocumentState('- [ ] 待办\n- [x] 完成\n', extensions, {})
const ranges = taskMarkerRanges(tasks)
assert.equal(taskMarkerRanges(tasks), ranges, '同文档同树复用任务原子范围')
const selected = tasks.update({ selection: { anchor: 6 } }).state
assert.equal(taskMarkerRanges(selected), ranges, '只移动选区不重新遍历任务树')
const actual = []
ranges.between(0, tasks.doc.length, (from, to) => actual.push([from, to]))
assert.deepEqual(actual, [[0, 6], [9, 15]], '任务前缀和末尾空格包含在原子范围内')
tasks = tasks.update({ changes: { from: 0, insert: '开头\n' } }).state
assert.notEqual(taskMarkerRanges(tasks), ranges, '文档改变后范围重新计算')
const long = Array.from({ length: 1000 }, (_, i) => `第${i}行正文\n\n`).join('') + '- [ ] 尾部任务\n'
let partial = createDocumentState(long, extensions, {})
const initialTree = syntaxTree(partial)
const initialRanges = taskMarkerRanges(partial)
const view = { get state() { return partial }, dispatch(spec) { partial = partial.update(spec).state } }
assert(forceParsing(view, long.length, 1000), '推进解析覆盖文档末尾')
assert.equal(partial.doc.toString(), long)
if (syntaxTree(partial) !== initialTree) assert.notEqual(taskMarkerRanges(partial), initialRanges, '树推进后缓存失效')
assert.equal(taskMarkerRanges(partial).size, 1, '文末任务在解析推进后进入原子范围')
console.log('通过：任务范围缓存随文档和语法树失效，选区变化复用')

// 测试实际交付函数，两种事件到达顺序都只开始一次；异步读取期间重复 ready 也不重入。
const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'deliverInitialDocument')
assert(declaration, '主进程应有由页面加载和 renderer-ready 共用的交付入口')
const compiled = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
for (const readyFirst of [false, true]) {
  const windowState = { rendererReady: readyFirst, pendingInitialDocument: null }
  let calls = 0, destroyed = false
  const win = { isDestroyed: () => destroyed }
  const deliver = new Function('getState', compiled + '\nreturn deliverInitialDocument')(() => windowState)
  deliver(win)
  assert.equal(calls, 0)
  windowState.pendingInitialDocument = () => { calls++ }
  deliver(win)
  assert.equal(calls, readyFirst ? 1 : 0)
  windowState.rendererReady = true
  deliver(win)
  deliver(win)
  assert.equal(calls, 1, '交付任务在执行前摘除，连续 ready 不重复启动')
  assert.equal(windowState.pendingInitialDocument, null)
  windowState.pendingInitialDocument = () => { calls++ }
  destroyed = true
  deliver(win)
  assert.equal(calls, 1, '销毁窗口不再投递')
}
console.log('通过：启动交付等待两端就绪、两种事件顺序、重复就绪与窗口销毁')
