// 保存序列化缓存必须跟随实际正文、行尾和前置内容，不能借用用户编辑计数判定。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { timingSummary } from './performance-fixture.mjs'

const bundle = await build({ entryPoints: ['src/renderer/document-file-content.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { DocumentFileContent } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const cache = new DocumentFileContent()
const original = (body, ending, front) => front + (ending === '\r\n' ? body.replace(/\r?\n/g, '\r\n') : body)
const inputs = ['', '正文', '甲\n乙\n', '甲\r\n乙\r\n', '甲\r\n乙\n丙\r末尾', '\n\n', '😀\n𠀀']
for (const body of inputs) {
  for (const ending of ['\n', '\r\n']) {
    for (const front of ['', '---\r\ntitle: 保留字节\r\n---\r\n']) {
      assert.equal(cache.read(body, ending, front), original(body, ending, front))
      assert.equal(cache.read(body, ending, front), original(body, ending, front), '重复快照返回相同字节')
    }
  }
}
// 同一文件的编辑、撤销、外部重载，以及不同标签来回恢复都使用真实内容。
for (const body of ['第一份\n', '第一份编辑\n', '第一份\n', '磁盘新版本\n', '第二份\n', '第一份\n']) {
  assert.equal(cache.read(body, '\r\n', ''), body.replace(/\n/g, '\r\n'))
}
assert.equal(cache.read('相同正文\n', '\n', ''), '相同正文\n')
assert.equal(cache.read('相同正文\n', '\r\n', ''), '相同正文\r\n', '行尾切换不沿用旧副本')
assert.equal(cache.read('相同正文\n', '\r\n', '属性\n'), '属性\n相同正文\r\n', '前置内容按原字节拼接')
console.log('通过：保存字节、混合行尾、正文更新、撤销恢复、热更新、标签切换及前置内容失效')

// 重复读当前正文的真实序列化成本，不用机器耗时作为正确性门槛。
const body = '正文 mixed words 123\n'.repeat(550000)
const cachedTimes = [], originalTimes = []
cache.read(body, '\r\n', '')
for (let index = 0; index < 10; index++) {
  let start = performance.now()
  const expected = original(body, '\r\n', '')
  originalTimes.push(performance.now() - start)
  start = performance.now()
  const actual = cache.read(body, '\r\n', '')
  cachedTimes.push(performance.now() - start)
  assert.equal(actual, expected)
}
console.log(JSON.stringify({ utf16Units: body.length, original: timingSummary(originalTimes), cached: timingSummary(cachedTimes) }))
