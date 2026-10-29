// 文档分析在真实 Text/Tree 边界验证，选区不应触发重算，惰性树推进必须使显示分析失效。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { previewRefreshHarness } from './preview-refresh-test-fixture.mjs'

const bundle = await build({
  stdin: { contents: `
    export { documentText } from './src/renderer/editor/document-text';
    export { documentAnalysis, previewAnalysis } from './src/renderer/editor/document-analysis';
    export { markdownParser, stateExtensions } from './src/renderer/editor/state';
    export { scanMath, excludedRanges, frontmatterRange } from './src/renderer/editor/math-scan';
    export { footnoteDefinitions, footnoteNumbers } from './src/renderer/editor/footnotes';
    export { livePreview, livePreviewField, decorationsRefreshEffect } from './src/renderer/editor/live-preview';
    export { EditorState, Text } from '@codemirror/state';
    export { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
    export { Tree } from '@lezer/common';
  `, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
})
const { documentText, documentAnalysis, previewAnalysis, markdownParser, scanMath, excludedRanges,
  frontmatterRange, footnoteDefinitions, footnoteNumbers, Text, Tree, EditorState, stateExtensions,
  livePreview, livePreviewField, decorationsRefreshEffect, syntaxTree, ensureSyntaxTree } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const source = '---\ntitle: 测试\n---\n\n正文[^a] 与 [^b]\n\n[^a]: 脚注\n  续行\n\n[^b]: 第二项\n\n```\n$x$\n```\n\n$y$\n'
const doc = Text.of(source.split('\n'))
assert.equal(documentText(doc), source, '全文读取保留原始文本')
const analysis = documentAnalysis(doc)
assert.deepEqual(analysis.front, frontmatterRange(source))
assert.deepEqual(analysis.footnoteNumbers, footnoteNumbers(source))
assert.deepEqual(analysis.footnoteDefinitions, footnoteDefinitions(source))
assert.deepEqual(analysis.footnoteReferences.map(reference => reference.label), ['a', 'b', 'a', 'b'])
assert.deepEqual(analysis.footnoteDefinitionLines, [doc.line(7).from, doc.line(10).from])
assert.equal(documentAnalysis(doc), analysis, '同一不可变文档复用纯文本分析')

const fullTree = markdownParser.parse(source)
const partial = previewAnalysis(doc, Tree.empty)
const complete = previewAnalysis(doc, fullTree)
assert.notEqual(complete, partial, '同一文本的树推进后重新计算显示分析')
assert.equal(previewAnalysis(doc, fullTree), complete, '同一文本和语法树复用显示分析')
assert.deepEqual(complete.excluded, excludedRanges(source, fullTree))
assert.deepEqual(complete.math, scanMath(source, excludedRanges(source, fullTree)))
assert(partial.math.some(range => range.code === 'x'), '未解析区域尚不能排除代码公式')
assert(!complete.math.some(range => range.code === 'x'), '树推进后代码内部公式被排除')
assert(complete.math.some(range => range.code === 'y'), '正文公式仍可渲染')
assert.equal(documentAnalysis(doc), analysis, '树推进不使纯文本分析失效')

const next = doc.replace(doc.length, doc.length, Text.of(['新增[^c]', '[^c]: 第三项']))
assert.notEqual(documentAnalysis(next), analysis, '文本改变后独立生成分析')
assert.equal(documentAnalysis(next).footnoteNumbers.get('c'), 3)
assert.equal(documentAnalysis(doc), analysis, '旧标签或撤销版本的结果不被新文档覆盖')
assert.equal(documentAnalysis(Text.empty).footnoteReferences.length, 0)
assert.equal(previewAnalysis(Text.empty, Tree.empty).math.length, 0)
console.log('通过：文本、属性区、脚注与公式结果保持原语义，缓存随文本和语法树分别失效')

// 使用真实懒解析状态推进，避免只用人为替换的 Tree 验证缓存键。
const prefix = Array.from({ length: 1200 }, (_, index) => `正文第${index}段\n\n`).join('')
const lateSource = prefix + '```\n$hidden$\n```\n\n$visible$\n'
let state = EditorState.create({ doc: lateSource, extensions: [stateExtensions(), livePreview] })
const beforeTree = syntaxTree(state)
const beforeAnalysis = previewAnalysis(state.doc, beforeTree)
assert(ensureSyntaxTree(state, state.doc.length, 1000), '测试文档可完整解析')
state = state.update({ effects: decorationsRefreshEffect.of(null) }).state
const afterTree = syntaxTree(state)
const afterAnalysis = previewAnalysis(state.doc, afterTree)
assert.notEqual(beforeTree, afterTree, '测试覆盖真实惰性语法树推进')
assert.notEqual(beforeAnalysis, afterAnalysis)
const formulas = []
state.field(livePreviewField).between(prefix.length, state.doc.length, (_from, _to, decoration) => {
  const widget = decoration.spec.widget
  if (widget && typeof widget.code === 'string') formulas.push(widget.code)
})
assert(!formulas.includes('hidden'), '真实显示装饰不保留代码里的旧公式缓存')
assert(formulas.includes('visible'), '真实显示装饰保留正文公式')
console.log('通过：滚动所需的真实语法树推进会使预览分析失效并刷新装饰')

const refreshDocument = Array.from({ length: 4000 }, (_, index) => `第${index}段 **强调**\n\n`).join('')
const freshState = text => EditorState.create({ doc: text, extensions: [stateExtensions(), livePreview] })
const refresh = previewRefreshHarness(freshState(refreshDocument), livePreview.at(-1), decorationsRefreshEffect)
try {
  refresh.update()
  refresh.flush()
  assert.equal(syntaxTree(refresh.view.state).length, refreshDocument.length)
  assert.equal(refresh.refreshes, 1, '一次完整解析推进只刷新一次装饰，不因同步 update 重入排队')
} finally { refresh.restore() }

const switched = previewRefreshHarness(freshState(refreshDocument), livePreview.at(-1), decorationsRefreshEffect)
try {
  switched.update()
  switched.update(freshState('新文件\n\n$y$'))
  switched.flush()
  assert.equal(switched.view.state.doc.toString(), '新文件\n\n$y$', '排队期间切换文档使用当前状态')
  assert.equal(switched.refreshes, 1)
} finally { switched.restore() }

const destroyed = previewRefreshHarness(freshState(refreshDocument), livePreview.at(-1), decorationsRefreshEffect)
try {
  destroyed.update()
  assert.equal(destroyed.pending, 1)
  destroyed.destroy()
  destroyed.flush()
  assert.equal(destroyed.refreshes, 0, '插件销毁后不向旧视图派发事务')
} finally { destroyed.restore() }

const edited = previewRefreshHarness(freshState('普通正文\n\n下一段'), livePreview.at(-1), decorationsRefreshEffect)
try {
  edited.update()
  edited.flush()
  edited.view.dispatch({ changes: { from: 2, insert: '新' } })
  assert.equal(edited.pending, 0, '事务已按新树构造装饰时不再额外排队重建')
} finally { edited.restore() }
console.log('通过：解析推进刷新合并、切文档读取当前状态、销毁取消排队')
