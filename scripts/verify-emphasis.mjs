// 在真实编辑器解析器上验证中文标点强调，比较节点范围以保护源码位置。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: `export { markdownParser, createState } from './src/renderer/editor/state';
      export { syntaxTree } from '@codemirror/language';
      export { parser, GFM } from '@lezer/markdown';`,
    resolveDir: new URL('..', import.meta.url).pathname
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
})
const { markdownParser, createState, syntaxTree, parser, GFM } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
)

// 同时断言节点类型与完整源码范围，嵌套节点按语法树顺序排列。
function emphasisNodes(tree, text) {
  const nodes = []
  tree.iterate({ enter(node) {
    if (node.name === 'StrongEmphasis' || node.name === 'Emphasis') {
      nodes.push([node.name, text.slice(node.from, node.to)])
      const marks = node.node.getChildren('EmphasisMark')
      assert.equal(marks.length, 2, '强调有且仅有起止标记')
      assert.equal(marks[0].from, node.from)
      assert.equal(marks[1].to, node.to)
    }
  } })
  return nodes
}

const original = '**结果与边界：**不恢复、不自动续局，不能刚结束人机球局就拨人收好的球。'
const cases = [
  ['原例', original, [['StrongEmphasis', '**结果与边界：**']]],
  ['括号两侧紧接中文', '前文**（结果）**后文', [['StrongEmphasis', '**（结果）**']]],
  ['中文引号', '前文**「结果」**后文', [['StrongEmphasis', '**「结果」**']]],
  ['中文接半角标点', '前文**(结果:)**后文', [['StrongEmphasis', '**(结果:)**']]],
  ['全角标点接英文', '**结果：**next', [['StrongEmphasis', '**结果：**']]],
  ['句号', '**结果。**后文', [['StrongEmphasis', '**结果。**']]],
  ['连续强调', '**甲：**正文**乙！**后文', [['StrongEmphasis', '**甲：**'], ['StrongEmphasis', '**乙！**']]],
  ['斜体', '前文*（结果）*后文', [['Emphasis', '*（结果）*']]],
  ['加粗斜体', '前文***（结果）***后文', [['Emphasis', '***（结果）***'], ['StrongEmphasis', '**（结果）**']]],
  ['内部斜体', '**外层 *内层*：**后文', [['StrongEmphasis', '**外层 *内层*：**'], ['Emphasis', '*内层*']]],
  ['外部斜体', '*外层 **内层：**后文*', [['Emphasis', '*外层 **内层：**后文*'], ['StrongEmphasis', '**内层：**']]],
  ['补充平面汉字', '𠀀**(结果)**𠀁', [['StrongEmphasis', '**(结果)**']]],
  ['假名', 'かな**(結果)**カナ', [['StrongEmphasis', '**(結果)**']]],
  ['韩文', '한**(결과)**글', [['StrongEmphasis', '**(결과)**']]],
  ['链接文字', '[**结果：**后文](https://example.com)', [['StrongEmphasis', '**结果：**']]],
  ['表格', '| 标题 |\n| --- |\n| **结果：**后文 |', [['StrongEmphasis', '**结果：**']]],
  ['列表和引用', '- **结果：**后文\n\n> **边界：**后文', [['StrongEmphasis', '**结果：**'], ['StrongEmphasis', '**边界：**']]],
  ['段落不能跨越', '**结果：\n\n**后文', []],
  ['未闭合', '**结果：后文', []],
  ['内侧尾空格', '**结果： **后文', []],
  ['内侧首空格', '前文** 结果**后文', []],
  ['内侧尾换行', '**甲\n**乙', []],
  ['内侧首换行', '甲**\n乙**', []],
  ['转义', '\\*\\*结果：\\*\\*后文', []],
  ['行内代码', '`**结果：**后文`', []],
  ['围栏代码', '```md\n**结果：**后文\n```', []],
  ['缩进代码', '    **结果：**后文', []],
  ['链接地址', '[地址](https://example.com/**结果：**后文)', []]
]
let failures = 0
for (const [name, text, expected] of cases) {
  try {
    assert.deepEqual(emphasisNodes(markdownParser.parse(text), text), expected)
    console.log('通过：' + name)
  } catch (error) {
    failures++
    console.error('失败：' + name + '\n' + error.message)
  }
}

// 扩展只接管星号的中文边界，英文、emoji 和下划线与同版本标准解析器一致。
const standard = parser.configure(GFM)
const unchanged = [
  '**bold** text', '*italic* text', '***both*** text', '**foo:**bar', 'foo**(bar)**baz',
  'a***b***c', '***a**b*', '*a**b***', 'a****b***c', '**a *b* c**', '**a** **b**',
  'a * b * c', '** **', '****', '**a\\**b**', '`**a**`', '**a `*b*` c**',
  '**a [b](https://example.com) c**', '**a:**😀', '😀**(a)**b',
  '_italic_ and __bold__', 'snake_case_name', 'local_upload / external_api',
  '__结果：__后文', '前文_（结果）_后文', '前文___结果___后文'
]
for (const text of unchanged) {
  assert.equal(markdownParser.parse(text).toString(), standard.parse(text).toString(), text)
}
console.log(`通过：${unchanged.length} 个英文、混合星号、代码和下划线兼容用例`)

// 从 EditorState 增量编辑，确保不是只有一次性解析能识别。
let state = createState(original)
assert.deepEqual(emphasisNodes(syntaxTree(state), original), [['StrongEmphasis', '**结果与边界：**']])
assert.equal(state.doc.toString(), original, '初始化不改写原文')
const close = original.indexOf('**', 2)
state = state.update({ changes: { from: close, to: close + 2 } }).state
assert.deepEqual(emphasisNodes(syntaxTree(state), state.doc.toString()), [])
state = state.update({ changes: { from: close, insert: '**' } }).state
assert.deepEqual(emphasisNodes(syntaxTree(state), state.doc.toString()), [['StrongEmphasis', '**结果与边界：**']])
assert.equal(state.doc.toString(), original, '补回标记后原文逐字相同')
console.log('通过：删除和补回标记时增量解析更新，原文字节不变')

assert.equal(failures, 0, `${failures} 个强调用例失败`)
