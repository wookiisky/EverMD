// 使用真实 Markdown 和嵌入语言解析器检查折叠范围与编辑事务。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: `
    export { EditorState } from '@codemirror/state'
    export { syntaxTree, LanguageDescription } from '@codemirror/language'
    export { languages } from '@codemirror/language-data'
    export { stateExtensions } from './src/renderer/editor/state'
    export * from './src/renderer/editor/code-folding'
  `, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const {
  EditorState, syntaxTree, LanguageDescription, languages, stateExtensions,
  codeFoldingState, fenceFoldRanges, toggleCodeFold, revealCodeFolds, clearCodeFolds, codeFoldsIntersect,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'))

const fixtures = {
  json: ['{', '  "nested": [', '    "a bracket in a string: ]",', '    2', '  ]', '}'],
  yml: ['app:', '  list:', '    - first', '    - second'],
  js: ['function f() {', '  if (true) {', '    return 1', '  }', '}'],
  jsx: ['const tree = <main>', '  <div>', '    hello', '  </div>', '</main>'],
  ts: ['interface T {', '  a: {', '    b: string', '  }', '}'],
  tsx: ['const tree: JSX.Element = <main>', '  <div>', '    hello', '  </div>', '</main>'],
  python: ['def f():', '    if True:', '        return 1'],
  html: ['<main>', '  <div>', '    hello', '  </div>', '</main>'],
  css: ['@media screen {', '  div {', '    color: red;', '  }', '}'],
}
for (const language of Object.keys(fixtures)) {
  await LanguageDescription.matchLanguageName(languages, language, false).load()
}

function create(doc) {
  return EditorState.create({ doc, extensions: [stateExtensions(), codeFoldingState] })
}

function ranges(state) {
  const folds = []
  syntaxTree(state).iterate({ enter(node) {
    if (node.name === 'FencedCode') folds.push(...fenceFoldRanges(state, node.node))
  } })
  return folds
}

for (const [language, body] of Object.entries(fixtures)) {
  const state = create(['```' + language, ...body, '```', '正文'].join('\n'))
  const [whole, outer, inner, ...extra] = ranges(state)
  assert.equal(whole.kind, 'block', language)
  assert.equal(whole.from, state.doc.line(1).to, language)
  assert.equal(whole.to, state.doc.line(body.length + 2).to, language)
  assert.equal(outer.kind, 'section', language)
  assert.equal(inner.kind, 'section', language)
  assert(outer.from < inner.from && inner.to <= outer.to, language)
  for (const part of [outer, inner, ...extra]) {
    assert(state.doc.lineAt(part.from).number < state.doc.lineAt(part.to).number, language)
    assert(part.from > whole.from && part.to < whole.to, language)
  }
}

const body = fixtures.json
const quoted = create(['> ```JSON', ...body.map(line => '> ' + line), '> ```', '> 引用续文'].join('\n'))
const [quoteWhole, , quoteInner] = ranges(quoted)
assert.equal(quoteWhole.to, quoted.doc.line(body.length + 2).to)
assert.equal(quoted.sliceDoc(quoteInner.to, quoteInner.to + 1), ']')
const listed = create(['- item', '  ~~~json', ...body.map(line => '  ' + line), '  ~~~', '  续文'].join('\n'))
assert.equal(ranges(listed).length, 3)
for (const state of [quoted, listed]) {
  const [, , inner] = ranges(state)
  const folded = state.update({ effects: toggleCodeFold.of(inner) }).state
  assert(codeFoldsIntersect(folded, inner.from, inner.to), '引用和列表中的折叠使用实际围栏位置')
}
assert.equal(ranges(create('```text\n{\n  [\n  ]\n}\n```')).length, 1)
assert.equal(ranges(create('```not-a-language\n{\n  [\n  ]\n}\n```')).length, 1)
assert.equal(ranges(create('```json\n{}\n```')).length, 0)
assert.equal(ranges(create('```json\n{\n  "incomplete": 0')).length, 0)
assert.equal(ranges(create('```json\n{\n  "incomplete": [\n    0\n```')).length, 1, '缺少结束标记的 JSON 结构仅能整块折叠')
assert.equal(ranges(create('```mermaid\nflowchart TD\nA --> B\n```')).length, 0)

const source = ['第一段', '', '```json', ...body, '```', '', '第二段'].join('\n')
const initial = create(source)
const [whole, outer, inner] = ranges(initial)
const setFold = (state, range) => state.update({ effects: toggleCodeFold.of(range) }).state
let state = setFold(setFold(initial, inner), outer)
assert.equal(state.doc, initial.doc)
state = setFold(state, outer)
assert(!codeFoldsIntersect(state, outer.from, inner.from))
assert(codeFoldsIntersect(state, inner.from, inner.to), '展开外层后保留已折叠的内层')
assert(!codeFoldsIntersect(initial, inner.from, inner.to), '另一个状态不受折叠操作影响')
state = setFold(state, whole)
const hidden = initial.doc.line(6)
state = state.update({ effects: revealCodeFolds.of({ from: hidden.from, to: hidden.to }) }).state
assert(!codeFoldsIntersect(state, whole.from, whole.to), '一次定位展开所有包住命中的范围')

state = setFold(initial, inner)
const relocated = state.update({ changes: { from: 0, insert: '前缀\n' } }).state
assert(codeFoldsIntersect(relocated, inner.from + 3, inner.to + 3), '前面的编辑映射折叠位置')
const outerFence = '~~~text\n'
const reparented = state.update({ changes: { from: 0, insert: outerFence } }).state
assert(!codeFoldsIntersect(reparented, inner.from + outerFence.length, inner.to + outerFence.length), '旧围栏成为另一块的源码后已无可见折叠')
const replaced = state.update({ changes: { from: hidden.from, to: hidden.to, insert: '    3,' } }).state
assert(!codeFoldsIntersect(replaced, whole.from, replaced.doc.length), '代码块发生编辑后展开')
assert(!codeFoldsIntersect(state.update({ selection: { anchor: hidden.from } }).state, inner.from, inner.to), '光标进入隐藏区时展开')

state = setFold(initial.update({ selection: { anchor: inner.to } }).state, inner)
const backspace = state.update({ changes: { from: inner.to - 1, to: inner.to }, userEvent: 'delete.backward' })
assert.equal(backspace.docChanged, false, '折叠边缘退格先展开')
assert(!codeFoldsIntersect(backspace.state, inner.from, inner.to))
const selected = state.update({ selection: { anchor: inner.from, head: inner.to } }).state
const deletion = selected.update({ changes: { from: inner.from, to: inner.to }, userEvent: 'delete.selection' })
assert(deletion.docChanged, '显式选中内容可以正常删除')
assert(!codeFoldsIntersect(state.update({ effects: clearCodeFolds.of(null) }).state, inner.from, inner.to))
console.log('通过：各语言解析器、围栏边界、嵌套折叠、跳转、编辑与字节保真')
