#!/usr/bin/env node
// 编辑器状态基准，不包含 DOM 或界面绘制；--output /tmp/before.json 可保存比较结果。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { performanceDocument, timingSummary, writePerformanceReport } from './performance-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: {
    contents: `export {stateExtensions} from './src/renderer/editor/state';
      export {livePreview,setEditorFocus} from './src/renderer/editor/live-preview';
      export {setHideBlankLinesEffect} from './src/renderer/editor/blank-line-visibility';
      export {EditorState} from '@codemirror/state';`,
    resolveDir: root
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
})
const { stateExtensions, livePreview, setEditorFocus, setHideBlankLinesEffect, EditorState } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const results = []
const sampleCount = 30
const warmupCount = 5

for (const paragraphs of [100, 1000, 4000]) {
  const doc = performanceDocument(paragraphs)
  for (const hideBlankLines of [false, true]) {
    let state = EditorState.create({ doc, extensions: [stateExtensions(), livePreview] })
    state = state.update({ effects: [setEditorFocus.of(true), setHideBlankLinesEffect.of(hideBlankLines)] }).state
    const selection = [], typing = []
    for (let index = 0; index < sampleCount + warmupCount; index++) {
      const started = performance.now()
      state = state.update({ selection: { anchor: 10 + index % 8 } }).state
      if (index >= warmupCount) selection.push(performance.now() - started)
    }
    assert.equal(state.doc.toString(), doc, '选区变化不得修改正文')
    for (let index = 0; index < sampleCount + warmupCount; index++) {
      const started = performance.now()
      state = state.update({ changes: { from: 10, insert: '字' }, userEvent: 'input.type' }).state
      if (index >= warmupCount) typing.push(performance.now() - started)
    }
    assert.equal(state.doc.toString(), doc.slice(0, 10) + '字'.repeat(sampleCount + warmupCount) + doc.slice(10))
    results.push({ paragraphs, characters: doc.length, hideBlankLines,
      selection: timingSummary(selection), typing: timingSummary(typing) })
  }
}

writePerformanceReport({ boundary: 'EditorState，仅状态计算，不含 DOM 与绘制',
  node: process.version, platform: process.platform, arch: process.arch, sampleCount, warmupCount, results })
