// 直接验证实际主进程握手、真实恢复文件及冲突保存的函数边界。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowCloseFixture, concurrentCloseFixture, beforeQuitFixture, recoveredCopyFixture, externalConflictFixture } from './document-lifecycle-test-fixture.mjs'

// 旧 HEAD 只运行冲突回归，便于确认该断言确实能识别原缺陷。
if (process.argv.includes('--baseline-conflict')) {
  const test = externalConflictFixture(true)
  test.keep()
  assert.equal(test.clock.timers.size, 1, '保留本地版本后应重新安排自动保存')
  process.exit(0)
}

// 微任务落定后观察 Promise 是否完成，不能把尚未 resolve 当成结果为 null。
async function observed(promise) {
  const result = { settled: false, value: undefined }
  promise.then(value => { result.settled = true; result.value = value })
  await Promise.resolve()
  return result
}

{
  const test = windowCloseFixture()
  const promise = test.request(), result = await observed(promise)
  assert.equal(result.settled, false)
  test.clock.advance(2999)
  await Promise.resolve()
  assert.equal(result.settled, false)
  test.clock.advance(1)
  assert.equal(await promise, null, '握手前超时必须明确报告失去响应')
  assert.equal(test.pending.size, 0)
  assert.equal(test.win.webContents.listenerCount('destroyed'), 0)
  assert.equal(test.win.webContents.listenerCount('render-process-gone'), 0)
}
console.log('通过：关闭请求握手前超时返回 null，并清除请求与生命周期监听')

for (const approved of [true, false]) {
  const test = windowCloseFixture()
  const promise = test.request(), result = await observed(promise)
  const requestId = test.sent[0][1]
  test.emit('window-close-started', requestId)
  test.clock.advance(60000)
  await Promise.resolve()
  assert.equal(result.settled, false, '握手后的用户保存过程不应被 3 秒超时截断')
  test.emit('window-close-response', requestId, approved)
  assert.equal(await promise, approved)
  assert.equal(test.pending.size, 0)
  assert.equal(test.clock.timers.size, 0)
}
console.log('通过：握手后持续等待用户保存，接受批准或取消并清理请求')

{
  const test = windowCloseFixture()
  const promise = test.request(), result = await observed(promise)
  const requestId = test.sent[0][1]
  test.emit('window-close-started', requestId, undefined, 99)
  test.emit('window-close-response', requestId, true, 99)
  test.emit('window-close-response', requestId, 'true')
  await Promise.resolve()
  assert.equal(result.settled, false, '其他窗口和非布尔响应不能批准关闭')
  test.clock.advance(3000)
  assert.equal(await promise, null, '错误 sender 的握手不能解除超时')
  test.emit('window-close-response', requestId, true)
  assert.equal(test.pending.size, 0, '迟到响应不重新创建请求')
}
console.log('通过：忽略错误窗口、无效响应与已超时请求的迟到响应')

for (const event of ['destroyed', 'render-process-gone']) {
  const test = windowCloseFixture()
  const promise = test.request()
  const requestId = test.sent[0][1]
  test.emit('window-close-started', requestId)
  test.win.webContents.emit(event)
  assert.equal(await promise, null)
  assert.equal(test.pending.size, 0)
  assert.equal(test.clock.timers.size, 0)
  assert.equal(test.win.webContents.listenerCount('destroyed'), 0)
  assert.equal(test.win.webContents.listenerCount('render-process-gone'), 0)
}
console.log('通过：渲染层销毁或崩溃时结束等待，握手后也不悬挂')

{
  const test = concurrentCloseFixture(), state = { closePromise: null }, win = {}
  const first = test.confirmWindowClose(win, state)
  const second = test.confirmWindowClose(win, state)
  assert.equal(first, second, '重复关闭共享同一个 Promise')
  assert.equal(test.calls, 1)
  test.finish(false)
  assert.equal(await first, false)
  assert.equal(state.closePromise, null)
  const retry = test.confirmWindowClose(win, state)
  assert.equal(test.calls, 2, '取消后仍能重新发起关闭')
  test.finish(true)
  assert.equal(await retry, true)
}
console.log('通过：重复关闭共享一次确认，取消后可以重新关闭')

{
  const test = beforeQuitFixture()
  test.add(1); test.add(2)
  test.quit(); test.quit()
  assert.deepEqual(test.calls, [1], '重复退出不能启动第二组窗口确认')
  assert.equal(test.prevented, 2)
  test.add(3)
  test.approve(1, true); await test.settle()
  assert.deepEqual(test.calls, [1, 2])
  test.quit()
  assert.deepEqual(test.calls, [1, 2], '等待第二个窗口时重复退出仍共享同组确认')
  test.approve(2, true); await test.settle()
  assert.deepEqual(test.calls, [1, 2, 3], '确认期间新建的窗口也必须确认')
  assert.equal(test.quitCalls, 0, '新窗口未批准时不可退出进程')
  test.approve(3, true); await test.settle()
  assert.equal(test.quitCalls, 1)
  assert.equal(test.state.quitting, true)
  assert.equal(test.state.inProgress, false)
  assert(test.windows.every(win => win.sent.length === 0), '批准退出时不发送取消关闭')
}
console.log('通过：退出期间新增窗口也需确认，重复退出只执行一组逐窗确认')

{
  const test = beforeQuitFixture()
  const first = test.add(1), second = test.add(2)
  test.quit()
  test.approve(1, true); await test.settle()
  const third = test.add(3)
  test.approve(2, false); await test.settle()
  assert.equal(test.quitCalls, 0)
  assert.equal(test.state.quitting, false)
  assert.equal(test.state.inProgress, false)
  for (const win of [first, second, third]) assert.deepEqual(win.sent, [['cancel-window-close']], '任一窗口取消都要解除其他窗口的关闭锁')
  test.quit()
  assert.deepEqual(test.calls, [1, 2, 1], '取消退出后可以开始新一轮确认')
  test.approve(1, false); await test.settle()
  assert.equal(test.state.inProgress, false)
}
console.log('通过：任一窗口取消时释放已批准及新建窗口，之后允许重新退出')

const work = await mkdtemp(join(tmpdir(), 'colamd-lifecycle-'))
try {
  const recoveryDir = join(work, 'recovered'), test = recoveredCopyFixture(recoveryDir)
  const first = await test.keepRecoveredCopy('/a/同名.md', '第一份正文')
  const second = await test.keepRecoveredCopy('/b/同名.md', '第二份正文')
  assert(first && second)
  assert.notEqual(first, second, '同名文档在同秒内必须有独立恢复文件')
  assert.equal(await readFile(first, 'utf8'), '第一份正文')
  assert.equal(await readFile(second, 'utf8'), '第二份正文')
  for (const content of ['', ' \t\n']) {
    const path = await test.keepRecoveredCopy('未命名', content)
    assert(path, '空白内容也是用户内容，应成功保存')
    assert.equal(await readFile(path, 'utf8'), content)
  }
  assert.equal((await readdir(recoveryDir)).length, 4)
  const blocker = join(work, 'not-a-directory')
  await writeFile(blocker, '禁止覆盖')
  const failing = recoveredCopyFixture(blocker)
  assert.equal(await failing.keepRecoveredCopy('/a/文档.md', '必须保留'), null, '实际写入失败时返回 null')
  assert.equal(await readFile(blocker, 'utf8'), '禁止覆盖')
  assert.equal(failing.errors.length, 1)
} finally {
  await rm(work, { recursive: true, force: true })
}
console.log('通过：真实文件写入保留同名同秒副本和空白内容，失败返回 null 且不覆盖阻塞文件')

{
  const test = externalConflictFixture()
  test.keep()
  assert.equal(test.state.pending, false)
  assert.equal(test.clock.timers.size, 1, '保留本地版本后应重新安排自动保存')
  test.clock.advance(999)
  assert.equal(test.saves, 0)
  test.clock.advance(1)
  assert.equal(test.saves, 1, '正常延迟后执行自动保存')
}
for (const condition of ['clean', 'untitled']) {
  const test = externalConflictFixture()
  if (condition === 'clean') test.state.dirty = false
  else test.state.path = null
  test.keep()
  assert.equal(test.clock.timers.size, 0, '干净文档或未命名文档不应安排自动保存')
}
console.log('通过：保留我的版本后恢复自动保存，干净和未命名文档保持原契约')
