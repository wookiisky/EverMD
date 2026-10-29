// 大纲的文本缓存与可见内容比较；真实按钮和跳转由 Electron 侧栏验收覆盖。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({ stdin: { contents: "export { DocumentOutline, sameOutlineLabels } from './src/renderer/document-outline'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { DocumentOutline, sameOutlineLabels } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const outline = new DocumentOutline()
const text = '# 标题\n\n普通正文\n\n## [下一节](target.md) **加粗**\n\n```js\n# 代码标题\n```\n'
const first = outline.read(text)
assert.deepEqual(first, [{ level: 1, title: '标题', line: 0 }, { level: 2, title: '下一节 加粗', line: 4 }])
assert.equal(outline.read(text), first, '同一内容只解析一次')
const shifted = outline.read(text.replace('普通正文', '普通正文\n\n新增正文'))
assert.equal(shifted[1].line, 6, '正文换行更新标题位置')
assert(sameOutlineLabels(first, shifted), '位置变化不需要重建标题按钮')
assert(!sameOutlineLabels(shifted, outline.read(text.replace('## ', '### '))), '级别变化需要更新按钮')
assert(!sameOutlineLabels(first, outline.read(text.replace('标题', '新标题'))), '标题文字变化需要更新按钮')
assert.deepEqual(outline.read('````md\n# 隐藏\n```\n# 仍隐藏\n````\n# 显示'), [{ level: 1, title: '显示', line: 5 }])
assert.deepEqual(outline.read('# 标题\r\n\r\n## 第二节'), [{ level: 1, title: '标题', line: 0 }, { level: 2, title: '第二节', line: 2 }])
assert.deepEqual(outline.read('普通正文'), [])
console.log('通过：标题解析、围栏保护、CRLF、内容缓存、正文行号变化、标题变化')
