// 检查真正生成的 DOCX 内部 XML，避免只验证解析器而漏掉导出接线。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import JSZip from 'jszip'

const bundle = await build({
  entryPoints: ['src/main/docx-export.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'docx-runtime', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'native-image' }))
    build.onLoad({ filter: /.*/, namespace: 'native-image' }, () => ({ contents: 'export const nativeImage = {}' }))
    build.onResolve({ filter: /^(unified|remark-parse|remark-gfm|docx)$/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
  } }],
})
const { markdownToDocx } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

// 提取每个实际 Word 文本段及其格式，代码路径不需要图片原生模块。
async function exportRuns(markdown) {
  const bytes = await markdownToDocx({ content: markdown, sourcePath: null })
  const zip = await JSZip.loadAsync(bytes)
  const xml = await zip.file('word/document.xml').async('string')
  const runs = [...xml.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map(([run]) => ({
    text: [...run.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => match[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join(''),
    bold: /<w:b(?:\s[^>]*)?\/>/.test(run),
    italic: /<w:i(?:\s[^>]*)?\/>/.test(run),
  }))
  return { text: runs.map(run => run.text).join(''), runs, xml }
}

const cases = [
  ['原始中文标点问题', '**结果与边界：**不恢复', '结果与边界：不恢复', [['结果与边界：', true, false]]],
  ['括号边界', '前文**（结果）**后文', '前文（结果）后文', [['（结果）', true, false]]],
  ['斜体', '前文*（结果）*后文', '前文（结果）后文', [['（结果）', false, true]]],
  ['加粗斜体', '前文***（结果）***后文', '前文（结果）后文', [['（结果）', true, true]]],
  ['内部嵌套', '**外层 *内层*：**后文', '外层 内层：后文', [['内层', true, true], ['：', true, false]]],
  ['外部嵌套', '*外层 **内层：**后文*', '外层 内层：后文', [['内层：', true, true], ['后文', false, true]]],
  ['链接', '[**结果：**后文](https://example.com)', '结果：后文', [['结果：', true, false]]],
  ['表格', '| 标题 |\n| --- |\n| **结果：**后文 |', '标题结果：后文', [['结果：', true, false]]],
  ['补充平面汉字', '𠀀**(结果)**𠀁', '𠀀(结果)𠀁', [['(结果)', true, false]]],
  ['连续中文强调', '**甲：**正文**乙！**后文', '甲：正文乙！后文', [['甲：', true, false], ['乙！', true, false]]],
  ['中文与英文相接', '**结果：**next', '结果：next', [['结果：', true, false]]],
  ['日文', 'かな**(結果)**カナ', 'かな(結果)カナ', [['(結果)', true, false]]],
  ['韩文', '한**(결과)**글', '한(결과)글', [['(결과)', true, false]]],
  ['标题', '# **结果：**后文', '结果：后文', [['结果：', true, false]]],
  ['列表', '- **结果：**后文', '• 结果：后文', [['结果：', true, false]]],
  ['英文加粗兼容', '**bold** text', 'bold text', [['bold', true, false]]],
  ['英文混合星号兼容', '***a**b*', 'ab', [['a', true, true], ['b', false, true]]],
  ['英文下划线兼容', '__bold__ text', 'bold text', [['bold', true, false]]],
  ['英文标点兼容', '**foo:**bar', '**foo:**bar', []],
  ['下划线兼容', '__结果：__后文', '__结果：__后文', []],
  ['内侧空白', '**结果： **后文', '**结果： **后文', []],
  ['内侧尾换行', '**甲\n**乙', '**甲\n**乙', []],
  ['内侧首换行', '甲**\n乙**', '甲**\n乙**', []],
  ['未闭合', '**结果：后文', '**结果：后文', []],
  ['强调不可跨段', '**结果：\n\n**后文', '**结果：**后文', []],
  ['转义', '\\*\\*结果：\\*\\*后文', '**结果：**后文', []],
  ['行内代码', '`**结果：**后文`', '**结果：**后文', []],
  ['围栏代码', '```md\n**结果：**后文\n```', '**结果：**后文', []],
]
let failures = 0
for (const [name, markdown, expected, styled] of cases) {
  try {
    const { text, runs, xml } = await exportRuns(markdown)
    assert.equal(text, expected, '导出正文')
    for (const [fragment, bold, italic] of styled) {
      assert(runs.some(run => run.text === fragment && run.bold === bold && run.italic === italic), `格式不符：${fragment}`)
    }
    if (styled.length === 0) assert(runs.every(run => !run.bold && !run.italic), '普通文字和代码不能变成强调')
    if (name === '链接') assert(xml.includes('<w:hyperlink '), '保留 Word 超链接')
    if (name === '表格') assert(xml.includes('<w:tbl>'), '保留 Word 表格')
    console.log('通过：' + name)
  } catch (error) {
    failures++
    console.error('失败：' + name + '\n' + error.message)
  }
}
assert.equal(failures, 0, `${failures} 个 Word 强调用例失败`)
