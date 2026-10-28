// 验证当前主进程监听函数的文档归属，异步事件和读取顺序由夹具控制。
import assert from 'node:assert/strict'
import { fileWatchingFixture } from './file-watching-test-fixture.mjs'

let passed = 0
// 每个用例独立监听状态，失败时保留具体操作与断言。
async function check(name, run) {
  const fixture = fileWatchingFixture()
  fixture.start()
  fixture.advance(301)
  await run(fixture)
  passed++
  console.log('通过：' + name)
}

await check('外部修改发送正文并更新修改时间，自己的写入不回放', async f => {
  f.change()
  f.advance(100)
  assert.equal(f.reads[0].path, '/docs/A.md')
  f.reads[0].resolve('外部正文')
  await f.settle()
  assert.deepEqual(f.events, [['file-changed', '外部正文', '/docs/A.md']])
  assert.equal(f.state.lastKnownMtime, 20)
  f.state.lastInternalSaveContent = '自己的写入'
  f.change()
  f.advance(100)
  f.reads[1].resolve('自己的写入')
  await f.settle()
  assert.equal(f.events.length, 1)
})

await check('切换文件取消前一个文件尚未开始的读取', async f => {
  f.change()
  f.switchTo('/docs/B.md')
  f.advance(100)
  assert.equal(f.reads.length, 0)
  assert.equal(f.timers.size, 0)
})

await check('切换文件后忽略已经开始的旧读取，不污染新文件基线', async f => {
  f.change()
  f.advance(100)
  f.switchTo('/docs/B.md')
  f.state.lastKnownMtime = 50
  f.state.lastInternalSaveContent = 'B 的磁盘版本'
  f.reads[0].resolve('A 的旧读取')
  await f.settle()
  assert.deepEqual(f.events, [])
  assert.equal(f.state.lastKnownMtime, 50)
  assert.equal(f.state.lastInternalSaveContent, 'B 的磁盘版本')
})

await check('A 切到 B 再回 A，第一次 A 的迟到读取不能覆盖新读取', async f => {
  f.change()
  f.advance(100)
  f.switchTo('/docs/B.md')
  f.switchTo('/docs/A.md')
  f.advance(301)
  f.change()
  f.advance(100)
  f.reads[1].resolve('A 的新版本')
  await f.settle()
  f.reads[0].resolve('A 的旧版本')
  await f.settle()
  assert.deepEqual(f.events, [['file-changed', 'A 的新版本', '/docs/A.md']])
})

await check('停止监听取消正文与目录定时器，旧监听器不得重新安排读取', async f => {
  f.change()
  f.change('change', 'sibling.md')
  const old = f.watchers[0]
  f.stop()
  assert.equal(old.closed, true)
  assert.equal(f.state.debounceTimer, null)
  assert.equal(f.state.siblingsTimer, null)
  old.callback('change', 'A.md')
  old.callback('change', 'sibling.md')
  old.error()
  f.advance(500)
  assert.equal(f.reads.length, 0)
  assert.equal(f.directoryReads.length, 0)
  assert.equal(f.watchers.length, 1)
})

await check('停止监听与窗口销毁后都不发送正在读取的结果', async f => {
  f.change()
  f.advance(100)
  f.stop()
  f.reads[0].resolve('停止前的结果')
  await f.settle()
  assert.deepEqual(f.events, [])
  f.start()
  f.advance(301)
  f.change()
  f.advance(100)
  f.destroy()
  f.reads[1].resolve('销毁前的结果')
  await f.settle()
  assert.deepEqual(f.events, [])
})

await check('原子替换重连监听仍发送本次更新，读取失败可由后续事件恢复', async f => {
  f.change('rename')
  assert.equal(f.watchers.length, 2)
  f.advance(100)
  f.reads[0].resolve('原子替换后的内容')
  await f.settle()
  assert.deepEqual(f.events, [['file-changed', '原子替换后的内容', '/docs/A.md']])
  f.advance(301)
  f.change()
  f.advance(100)
  f.reads[1].reject(new Error('文件正在替换'))
  await f.settle()
  f.change()
  f.advance(100)
  f.reads[2].resolve('后续正常内容')
  await f.settle()
  assert.deepEqual(f.events.at(-1), ['file-changed', '后续正常内容', '/docs/A.md'])
})

await check('切换后忽略旧目录列表读取，旧监听器错误不能替换新监听器', async f => {
  f.change('change', 'sibling.md')
  f.advance(300)
  const old = f.watchers[0]
  f.switchTo('/docs/B.md')
  const current = f.state.watcher
  old.error()
  f.directoryReads[0].resolve([{ path: '/docs/sibling.md' }])
  await f.settle()
  assert.deepEqual(f.events, [])
  assert.equal(f.state.watcher, current)
  assert.equal(current.closed, false)
})

await check('保存探测的迟到读取也不能跨越 A 到 B 再到 A 的绑定', async f => {
  f.notify('/docs/A.md')
  f.switchTo('/docs/B.md')
  f.switchTo('/docs/A.md')
  f.state.lastKnownMtime = null
  f.reads[0].resolve('旧 A 的保存探测结果')
  await f.settle()
  assert.deepEqual(f.events, [])
  assert.equal(f.state.lastKnownMtime, null)
  f.notify('/docs/A.md')
  f.reads[1].resolve('当前 A 的保存探测结果')
  await f.settle()
  assert.deepEqual(f.events, [['file-changed', '当前 A 的保存探测结果', '/docs/A.md']])
  assert.equal(f.state.lastKnownMtime, 20)
})

await check('保存探测发现外部版本后刷新普通修改时间基线，保留版本不会重复冲突', async f => {
  assert.equal(f.state.lastKnownMtime, 1)
  f.notify('/docs/A.md')
  f.reads[0].resolve('监听事件遗漏时的外部版本')
  await f.settle()
  assert.deepEqual(f.events, [['file-changed', '监听事件遗漏时的外部版本', '/docs/A.md']])
  assert.equal(f.state.lastKnownMtime, 20)
})

console.log(`文件监听验收通过：${passed} 项`)
