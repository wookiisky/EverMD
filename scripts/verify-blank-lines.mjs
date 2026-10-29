// 隐藏空行只改变装饰：候选识别、焦点、导出与历史都在真实 EditorState 边界验证。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: `export { blankLineNumbers, setHideBlankLinesEffect, hideBlankLinesField } from './src/renderer/editor/blank-line-visibility';
      export { stateExtensions, markdownParser } from './src/renderer/editor/state';
      export { livePreview, livePreviewField, setEditorFocus, setCleanExport } from './src/renderer/editor/live-preview';
      export { EditorState, EditorSelection } from '@codemirror/state';
      export { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';`,
    resolveDir: new URL('..', import.meta.url).pathname
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
})
const { blankLineNumbers, setHideBlankLinesEffect, hideBlankLinesField, stateExtensions, markdownParser,
  livePreview, livePreviewField, setEditorFocus, setCleanExport, EditorState, EditorSelection,
  undo, redo, undoDepth, redoDepth } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const cases = [
  ['段落分隔也选入候选', '甲\n\n\n乙', [2, 3]],
  ['空白字符与首尾空行', '\n \t\n正文\n\n', [1, 2, 4, 5]],
  ['空文档', '', [1]],
  ['普通标记不算空行', '#\n---\n-\n| |', []],
  ['引用标记空行', '> 甲\n>\n> \t\n> 乙', [2, 3]],
  ['嵌套引用标记空行', '>> 甲\n>>\n> > \t\n>> 乙', [2, 3]],
  ['列表与脚注内部普通空行', '- 甲\n\n  续段\n\n[^x]: 脚注\n\n    续段', [2, 4, 6]],
  ['围栏代码内部保护', '```js\n甲\n\n\n乙\n```\n\n正文', [7]],
  ['未闭合围栏内部保护', '```\n甲\n\n\n乙', []],
  ['未闭合围栏最后逻辑空行仍保护', '```js\n甲\n\n', []],
  ['已闭合围栏后末尾空行仍可隐藏', '```js\n甲\n```\n', [4]],
  ['未闭合 HTML 最后逻辑空行仍保护', '<pre>\n\n', []],
  ['缩进代码内部保护', '    甲\n\n\n    乙\n\n正文', [5]],
  ['引用内代码标记空行保护', '> ```js\n> 甲\n>\n> \n> 乙\n> ```\n>\n> 正文', [7]],
  ['HTML 块内部保护', '<pre>\n甲\n\n\n乙\n</pre>\n\n正文', [7]],
  ['HTML 注释内部保护', '<!--\n\n\n-->\n\n正文', [5]],
  ['HTML 处理指令内部保护', '<?xml\n\n?>\n\n正文', [4]],
  ['引用 HTML 内部保护', '> <pre>\n> 甲\n>\n> 乙\n> </pre>\n>\n> 正文', [6]],
  ['属性区内部保护', '---\ntitle: |\n  甲\n\n\n  乙\n---\n\n正文', [8]],
  ['CRLF 属性区内部保护', '---\r\ntitle: |\r\n  甲\r\n\r\n  乙\r\n...\r\n\r\n正文', [7]],
  ['美元公式内部保护', '$$\nx=1\n\n\n+y\n$$\n\n正文', [7]],
  ['LaTeX 有效公式外围空行', '\\[\nx=1\n+y\n\\]\n\n正文', [5]],
  ['引用公式内部保护', '> $$\n> x=1\n>\n> y=2\n> $$\n>\n> 正文', [6]],
  ['代码中的美元不能扩展公式保护', '```\n$$\n```\n\n甲\n\n乙', [4, 6]],
  ['CRLF 与引用标记', '甲\r\n\r\n> 甲\r\n>\r\n乙\r\n', [2, 4, 6]]
]
for (const [name, text, expected] of cases) {
  assert.deepEqual(blankLineNumbers(text), expected, name)
  console.log('通过：' + name)
}
const prefix = Array.from({ length: 2000 }, (_, index) => `长文第${index}行`).join('\n')
const longText = prefix + '\n\n```js\n甲\n\n\n乙\n```\n\n正文'
assert.deepEqual(blankLineNumbers(longText), [2001, 2008], '完整解析保护视口之外的代码空行')
console.log('通过：长文视口外保护范围完整')

// 读取实际 livePreview 装饰，而不是复制一遍显示策略。
const hiddenLines = state => {
  const lines = []
  state.field(livePreviewField).between(0, state.doc.length, (from, _to, decoration) => {
    if (decoration.spec.class?.split(' ').includes('cm-md-blank-line-hidden')) lines.push(state.doc.lineAt(from).number)
  })
  return lines
}
const original = '# 标题\n\n甲\n\n乙\n'
let state = EditorState.create({ doc: original, extensions: [stateExtensions(), livePreview] })
assert.deepEqual(hiddenLines(state), [])
assert.equal(state.field(hideBlankLinesField), false)
const doc = state.doc
state = state.update({ effects: setHideBlankLinesEffect.of(true) }).state
assert.deepEqual(hiddenLines(state), [2, 4, 6], '开启后实际行装饰包含段落分隔')
assert.equal(state.doc, doc, '开关不替换文档对象')
assert.equal(state.doc.toString(), original)
assert.equal(undoDepth(state), 0)
assert.equal(redoDepth(state), 0)

state = state.update({ selection: EditorSelection.single(state.doc.line(2).from), effects: setEditorFocus.of(true) }).state
assert.deepEqual(hiddenLines(state), [4, 6], '有焦点时活动空行临时显示')
state = state.update({ selection: EditorSelection.single(state.doc.line(4).from) }).state
assert.deepEqual(hiddenLines(state), [2, 6], '移动光标后只恢复新的活动空行')
state = state.update({ effects: setEditorFocus.of(false) }).state
assert.deepEqual(hiddenLines(state), [2, 4, 6], '失去焦点后恢复隐藏')
state = state.update({ effects: setCleanExport.of(true) }).state
assert.deepEqual(hiddenLines(state), [], '干净导出恢复原始空行')
state = state.update({ effects: setCleanExport.of(false) }).state
assert.deepEqual(hiddenLines(state), [2, 4, 6], '导出结束恢复视图偏好')
state = state.update({ effects: setHideBlankLinesEffect.of(false) }).state
assert.deepEqual(hiddenLines(state), [], '关闭后完整恢复空行')
assert.equal(state.doc, doc)
console.log('通过：实际装饰随开关、活动行、焦点和导出变化，文档不变')

let quoteState = EditorState.create({ doc: '> 甲\n>\n>>\n> 乙', extensions: [stateExtensions(), livePreview] })
quoteState = quoteState.update({
  effects: [setHideBlankLinesEffect.of(true), setEditorFocus.of(true)],
  selection: EditorSelection.single(quoteState.doc.line(2).from)
}).state
assert.deepEqual(hiddenLines(quoteState), [3], '正在编辑的引用标记空行恢复高度')
quoteState = quoteState.update({ effects: setEditorFocus.of(false) }).state
assert.deepEqual(hiddenLines(quoteState), [2, 3], '引用空行失去焦点后重新隐藏')
console.log('通过：引用标记空行也遵守焦点恢复策略')

let multipleState = EditorState.create({
  doc: original,
  extensions: [stateExtensions(), livePreview, EditorState.allowMultipleSelections.of(true)]
})
multipleState = multipleState.update({
  effects: [setHideBlankLinesEffect.of(true), setEditorFocus.of(true)],
  selection: EditorSelection.create([
    EditorSelection.cursor(multipleState.doc.line(2).from),
    EditorSelection.cursor(multipleState.doc.line(4).from)
  ])
}).state
assert.deepEqual(hiddenLines(multipleState), [6], '多光标所在的空行都保持可见')
console.log('通过：多个活动光标所在空行都恢复高度')

state = state.update({ changes: { from: state.doc.length, insert: '新段' }, userEvent: 'input.type' }).state
const edited = state.doc.toString()
const depth = undoDepth(state)
state = state.update({ effects: setHideBlankLinesEffect.of(true) }).state
assert.equal(undoDepth(state), depth, '开启不增加撤销步骤')
assert.deepEqual(hiddenLines(state), [2, 4], '输入内容后末尾原空行不再隐藏')
const dispatch = transaction => { state = transaction.state }
assert(undo({ state, dispatch }))
assert.equal(state.doc.toString(), original, '撤销只撤用户输入')
assert.deepEqual(hiddenLines(state), [2, 4, 6], '文档撤销后自动重算空行装饰')
assert.equal(state.field(hideBlankLinesField), true, '撤销不关闭视图偏好')
const redoCount = redoDepth(state)
state = state.update({ effects: setHideBlankLinesEffect.of(false) }).state
assert.equal(redoDepth(state), redoCount, '关闭不清空重做历史')
assert(redo({ state, dispatch }))
assert.equal(state.doc.toString(), edited)
assert.deepEqual(hiddenLines(state), [])
console.log('通过：用户编辑和撤销重做独立于空行视图开关')

// 每笔真实事务之后与完整解析逐次比较，包含会把保护范围一直改到文末的编辑。
const editCases = [
  ['普通文字与换行', '标题\n\n正文\n\n尾段', state => [{ from: 1, insert: '新\n' }, { from: state.doc.length, insert: '\n\n末尾' }]],
  ['删除围栏开头', '```js\n\n正文\n```\n\n尾段\n', () => [{ from: 0, to: 3 }]],
  ['删除围栏结尾', '```js\n\n正文\n```\n\n尾段\n', state => { const start = state.doc.toString().lastIndexOf('```'); return [{ from: start, to: start + 3 }] }],
  ['文首插入未闭合围栏', '甲\n\n乙\n\n丙\n', () => [{ from: 0, insert: '```\n' }]],
  ['HTML结束符改变', '<pre>\n\n甲\n</pre>\n\n乙\n', state => { const start = state.doc.toString().indexOf('</pre>'); return [{ from: start, to: start + 6 }] }],
  ['属性区闭合改变', '---\ntitle: 测试\n\n---\n\n甲\n', state => { const start = state.doc.toString().lastIndexOf('---'); return [{ from: start, to: start + 3 }] }],
  ['公式闭合改变', '$$\nx=1\n\n$$\n\n甲\n', state => { const start = state.doc.toString().lastIndexOf('$$'); return [{ from: start, to: start + 2 }] }],
  ['引用中代码与空行', '> ```\n>\n> 甲\n> ```\n>\n尾段', () => [{ from: 2, to: 5 }, { from: 14, insert: '新' }]],
  ['CRLF与末尾空行', '甲\r\n\r\n```\r\n\r\n乙\r\n```\r\n', state => [{ from: 0, insert: '\r\n' }, { from: state.doc.length, insert: '\r\n' }]],
  ['全文替换', '甲\n\n乙', state => [{ from: 0, to: state.doc.length, insert: '<!--\n\n未闭合\n' }]],
]
const unchangedTail = Array.from({ length: 100 }, (_, index) => `保持不变的第${index}段\n\n`).join('')
for (const [name, text, change] of editCases) {
  // 长后缀确保有可复用片段，不能只用短夹具让增量解析自然退回全文解析。
  let current = EditorState.create({ doc: text + '\n\n' + unchangedTail, extensions: [stateExtensions(), livePreview] })
  current = current.update({ effects: setHideBlankLinesEffect.of(true) }).state
  current = current.update({ changes: change(current), userEvent: 'input.type' }).state
  assert.deepEqual(hiddenLines(current), blankLineNumbers(current.doc.toString()), `${name}：编辑后与完整解析一致`)
  const dispatch = transaction => { current = transaction.state }
  assert(undo({ state: current, dispatch }), `${name}：可以撤销`)
  assert.deepEqual(hiddenLines(current), blankLineNumbers(current.doc.toString()), `${name}：撤销后与完整解析一致`)
  assert(redo({ state: current, dispatch }), `${name}：可以重做`)
  assert.deepEqual(hiddenLines(current), blankLineNumbers(current.doc.toString()), `${name}：重做后与完整解析一致`)
}
console.log('通过：多处编辑、语法保护边界、全文替换、撤销和重做逐笔与完整解析一致')

// 完整解析器的调用记录只观察增量片段是否被利用，不把机器速度当正确性断言。
const parse = markdownParser.parse
const recordedParse = action => {
  const calls = []
  markdownParser.parse = function (input, fragments, ranges) {
    calls.push(fragments?.length ?? 0)
    return parse.call(this, input, fragments, ranges)
  }
  try { action(); return calls } finally { markdownParser.parse = parse }
}
const longDocument = Array.from({ length: 500 }, (_, index) => `第${index}段正文\n\n`).join('')
let incremental = EditorState.create({ doc: longDocument, extensions: [stateExtensions(), livePreview] })
incremental = incremental.update({ effects: setHideBlankLinesEffect.of(true) }).state
const incrementalCalls = recordedParse(() => {
  incremental = incremental.update({ changes: [{ from: 4, insert: '新' }, { from: incremental.doc.length - 8, insert: '末' }] }).state
})
assert(incrementalCalls.some(count => count > 0), '普通局部编辑复用未修改部分的完整语法树')
assert.deepEqual(hiddenLines(incremental), blankLineNumbers(incremental.doc.toString()))
assert.deepEqual(recordedParse(() => {
  incremental = incremental.update({ selection: { anchor: 12 } }).state
}), [], '只移动光标不重复调用完整解析器')

for (const [name, suspend, resume] of [
  ['关闭隐藏空行', setHideBlankLinesEffect.of(false), setHideBlankLinesEffect.of(true)],
  ['干净导出', setCleanExport.of(true), setCleanExport.of(false)],
]) {
  incremental = incremental.update({ effects: suspend }).state
  assert.deepEqual(recordedParse(() => {
    incremental = incremental.update({ changes: { from: 0, insert: '```\n' } }).state
    incremental = incremental.update({ changes: { from: incremental.doc.length, insert: '\n\n' } }).state
  }), [], `${name}期间不解析空行保护树`)
  incremental = incremental.update({ effects: resume }).state
  assert.deepEqual(hiddenLines(incremental), blankLineNumbers(incremental.doc.toString()), `${name}后恢复使用当前文档而非旧片段`)
}

let otherDocument = EditorState.create({ doc: '其他标签\n\n尾段', extensions: [stateExtensions(), livePreview] })
otherDocument = otherDocument.update({ effects: setHideBlankLinesEffect.of(true) }).state
assert.deepEqual(hiddenLines(otherDocument), [2], '另一标签的空行候选独立')
assert.deepEqual(hiddenLines(incremental), blankLineNumbers(incremental.doc.toString()), '切回原标签仍保留自己的保护范围')
console.log('通过：局部编辑复用完整树，选区与暂停期间不解析，恢复及标签数据独立')
