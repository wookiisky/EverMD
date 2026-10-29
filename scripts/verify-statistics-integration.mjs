// 运行外壳实际统计更新函数，覆盖文档已变但下一帧尚未执行的发布竞态。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'updateWordCount')
assert(node, '外壳必须存在统计更新入口')
const code = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const frames = [], requests = [], published = []
let content = '第一份', chinese = true
const labels = JSON.parse(readFileSync(new URL('../src/shared/document-statistics-labels.json', import.meta.url), 'utf8'))
const update = new Function('requestAnimationFrame', 'getContent', 'documentStatistics', 'statisticsLabels', 'isChinese', 'setToolbarTip', 'wordCountEl',
  'let statisticsQueued = false;\n' + code + '\nreturn updateWordCount')(
  callback => frames.push(callback), () => content,
  { request: (text, publish) => requests.push({ text, publish }) }, labels, () => chinese,
  (_element, label) => published.push(label), () => null,
)
update()
update()
assert.equal(frames.length, 1, '同一帧只请求一次统计')
frames.shift()()
assert.equal(requests[0].text, content)
content = '第二份'
update()
requests[0].publish({ characters: 3, tokens: 3, paragraphs: 1 })
assert.equal(published.length, 0, '下一帧尚未处理时也不能显示旧正文的结果')
frames.shift()()
chinese = false
const value = { characters: 31, tokens: 17, paragraphs: 2 }
requests[1].publish(value)
const expected = labels.en.statistics.replace('{characters}', String(value.characters))
  .replace('{tokens}', String(value.tokens)).replace('{paragraphs}', String(value.paragraphs))
assert.deepEqual(published, [expected], '完成时采用当前语言及完整统计')
content = '第三份'
update()
content = '第四份'
update()
frames.shift()()
assert.equal(requests.at(-1).text, '第四份', '快速连续切换时帧回调读取当前文档')
console.log('通过：外壳帧合并、切换后旧结果隔离、连续切换与完成时语言同步')
