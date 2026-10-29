// 使用真实扫描器与可控调度队列证明分块边界、取消和最终发布行为。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { statisticsTestScheduler } from './statistics-test-scheduler.mjs'

const bundle = await build({
  stdin: { contents: `
    export { computeDocumentStatistics, DocumentStatisticsScan } from './src/renderer/document-statistics';
    export { DocumentStatisticsScheduler } from './src/renderer/document-statistics-scheduler';
  `, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
})
const { computeDocumentStatistics, DocumentStatisticsScan, DocumentStatisticsScheduler } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const boundaryText = "甲\r\n\r\n don't foo\\bar 12,345.67 a--b 😀\u2000\n\nあ한"
for (let size = 1; size <= boundaryText.length; size++) {
  const scan = new DocumentStatisticsScan(boundaryText)
  let result
  while (!(result = scan.advance(size))) { /* 边界大小故意覆盖每个 UTF-16 位置。 */ }
  assert.deepEqual(result, computeDocumentStatistics(boundaryText), `分块大小 ${size}`)
}
assert.deepEqual(new DocumentStatisticsScan('').advance(), { characters: 0, tokens: 0, paragraphs: 0 })

const queue = statisticsTestScheduler()
const scheduler = new DocumentStatisticsScheduler(queue.schedule)
const large = boundaryText.repeat(50000)
const published = []
scheduler.request(large, value => published.push(['旧', value]))
assert.equal(published.length, 0, '请求本身不得扫描全文或发布结果')
queue.runOne()
assert.equal(published.length, 0, '第一分块不发布不完整统计')
scheduler.request('新文档\r\n\r\nnew text', value => published.push(['新', value]))
queue.runOne(true)
assert.equal(published.length, 0, '即使取消任务已进入队列，也不能发布旧文本结果')
queue.drain()
assert.deepEqual(published, [['新', computeDocumentStatistics('新文档\r\n\r\nnew text')]])

const beforeCache = queue.scheduled
scheduler.request('新文档\r\n\r\nnew text', value => published.push(['换语言', value]))
assert.equal(queue.scheduled, beforeCache, '相同正文复用已完成统计')
assert.equal(published.at(-1)[0], '换语言')

scheduler.request(large, () => assert.fail('同正文新请求应该替换发布回调'))
queue.runOne()
const during = queue.scheduled
scheduler.request(large, value => published.push(['最终', value]))
assert.equal(queue.scheduled, during, '相同正文请求保留进行中的分块进度')
queue.drain()
assert.deepEqual(published.at(-1), ['最终', computeDocumentStatistics(large)])
assert(queue.scheduled > during + 1, '大文档确实经过多个独立任务')

scheduler.request(large + '变更', () => assert.fail('取消后不得发布'))
queue.runOne()
scheduler.cancel()
queue.runOne(true)
queue.drain()
console.log('通过：分块词边界、CRLF、UTF-16、完整结果发布、新文档取消、已排队旧任务隔离、同文本复用与显式取消')
