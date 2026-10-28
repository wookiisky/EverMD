// 导航历史只存位置：在无 DOM 环境验证容量、去重、防抖与成功后提交。
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [new URL('../src/renderer/navigation-history.ts', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
})
const { NavigationHistory } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

// 测试锚点保留选区方向，各用例只改与行为有关的字段。
const point = (head = 0, options = {}) => ({
  filePath: '/a.md', tabId: 'tab-a', anchor: head, head,
  line: 1, column: head, anchorLine: 1, anchorColumn: head,
  viewportFraction: 1 / 3, ...options
})
let passed = 0
const check = (name, run) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try { run(); passed++; console.log('通过：' + name) }
  finally { mock.timers.reset() }
}

check('空历史不能前进后退，失败回放不移动指针', () => {
  const history = new NavigationHistory()
  assert.equal(history.current, null)
  assert.equal(history.peek(-1), null)
  assert.equal(history.commit(-1), false)
  history.record(point())
  history.record(point(100))
  assert.equal(history.peek(-1).head, 0)
  assert.equal(history.current.head, 100)
  assert.equal(history.commit(-1), true)
  assert.equal(history.current.head, 0)
  assert.equal(history.canGoForward, true)
  assert.equal(history.commit(-1), false)
  assert.equal(history.commit(1), true)
  assert.equal(history.current.head, 100)
})

check('只保留最新 100 个位置且当前位置算在容量内', () => {
  const history = new NavigationHistory()
  for (let i = 0; i < 120; i++) history.record(point(i * 100))
  assert.equal(history.size, 100)
  assert.equal(history.current.head, 11900)
  let count = 0
  while (history.commit(-1)) count++
  assert.equal(count, 99)
  assert.equal(history.current.head, 2000)
})

check('相同和微小位置合并，累计移动使用固定基准', () => {
  const history = new NavigationHistory()
  history.record(point())
  assert.equal(history.record(point()), false)
  assert.equal(history.record(point(30)), false)
  assert.equal(history.record(point(60)), false)
  assert.equal(history.current.head, 60)
  assert.equal(history.size, 1)
  assert.equal(history.record(point(80)), true)
  assert.equal(history.size, 2)
  const lines = new NavigationHistory()
  lines.record(point(0))
  assert.equal(lines.record(point(4, { line: 5 })), false)
  assert.equal(lines.record(point(5, { line: 6 })), true)
})

check('文件身份优先于标签，同文件不同标签相邻去重，A B A 保留', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(0, { tabId: 'another-tab' }))
  assert.equal(history.size, 1)
  history.record(point(0, { filePath: '/b.md' }))
  history.record(point())
  assert.equal(history.size, 3)
  assert.equal(history.peek(-1).filePath, '/b.md')
})

check('普通移动只有停稳 500ms 才记最终位置', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.schedule(point(100))
  mock.timers.tick(499)
  assert.equal(history.size, 1)
  history.schedule(point(200))
  mock.timers.tick(499)
  assert.equal(history.size, 1)
  mock.timers.tick(1)
  assert.equal(history.size, 2)
  assert.equal(history.current.head, 200)
  mock.timers.tick(1000)
  assert.equal(history.size, 2)
})

check('切文件前 flush 不丢起点，输入或销毁取消候选', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.schedule(point(100))
  assert.equal(history.flush(), true)
  history.record(point(0, { filePath: '/b.md' }))
  assert.equal(history.peek(-1).head, 100)
  history.schedule(point(200, { filePath: '/b.md' }))
  history.cancelPending()
  mock.timers.tick(1000)
  assert.equal(history.size, 3)
  history.schedule(point(300, { filePath: '/b.md' }))
  history.dispose()
  mock.timers.tick(1000)
  assert.equal(history.size, 3)
})

check('微小移动与当前位置刷新保留前进分支，有效跳转才截断', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(100))
  history.record(point(200))
  history.commit(-1)
  history.record(point(110))
  assert.equal(history.canGoForward, true)
  history.updateCurrent(point(120, { anchor: 115 }))
  assert.equal(history.canGoForward, true)
  assert.equal(history.current.anchor, 115)
  history.record(point(300))
  assert.equal(history.canGoForward, false)
  assert.equal(history.size, 3)
  assert.equal(history.peek(-1).head, 120)
})

check('删除失效文件保持当前项并能继续向后，关闭无路径标签只删自己的记录', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(0, { filePath: '/gone.md' }))
  history.record(point(0, { filePath: '/b.md' }))
  history.removeFile('/gone.md')
  assert.equal(history.current.filePath, '/b.md')
  assert.equal(history.peek(-1).filePath, '/a.md')
  history.record(point(0, { filePath: null, tabId: 'untitled-a' }))
  history.record(point(0, { filePath: null, tabId: 'untitled-b' }))
  history.removeUntitled('untitled-a')
  assert.equal(history.current.tabId, 'untitled-b')
  assert.equal(history.peek(-1).filePath, '/b.md')
  history.removeUntitled('untitled-b')
  assert.equal(history.current.filePath, '/b.md')
})

check('删除两端与全部记录时边界正确，候选也随文件移除', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(0, { filePath: '/b.md' }))
  history.commit(-1)
  history.removeFile('/b.md')
  assert.equal(history.canGoForward, false)
  history.schedule(point(200))
  history.removeFile('/a.md')
  mock.timers.tick(1000)
  assert.equal(history.current, null)
  assert.equal(history.size, 0)
  history.record(point(1, { filePath: '/c.md' }))
  assert.equal(history.canGoBack, false)
})

check('移除中间失效文件后，相邻重复位置合并并保留当前落点', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(0, { filePath: '/gone.md' }))
  history.record(point(10))
  history.removeFile('/gone.md')
  assert.equal(history.size, 1)
  assert.equal(history.current.head, 10)
  assert.equal(history.canGoBack, false)
})

check('另存为按文档身份迁移，不误改同标签曾装过的文件', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(0, { filePath: '/b.md' }))
  history.schedule(point(100, { filePath: '/b.md' }))
  history.renameDocument({ filePath: '/b.md', tabId: 'tab-a' }, { filePath: '/saved.md', tabId: 'tab-a' })
  assert.equal(history.current.filePath, '/saved.md')
  assert.equal(history.peek(-1).filePath, '/a.md')
  history.flush()
  assert.equal(history.current.filePath, '/saved.md')
})

check('编辑映射已存位置、比较基准与候选，不新增或截断历史', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(100))
  history.record(point(0, { filePath: '/b.md' }))
  history.commit(-1)
  history.updateDocument({ filePath: '/a.md', tabId: 'unused' }, anchor => ({ ...anchor, anchor: anchor.anchor + 20, head: anchor.head + 20 }))
  assert.equal(history.current.head, 120)
  assert.equal(history.peek(-1).head, 20)
  assert.equal(history.peek(1).filePath, '/b.md')
  history.record(point(190))
  assert.equal(history.canGoForward, true)
  history.record(point(200))
  assert.equal(history.canGoForward, false)
})

check('外部持有的锚点不能修改栈内位置，状态改变通知菜单', () => {
  let notifications = 0
  const history = new NavigationHistory(() => notifications++)
  const initial = point()
  history.record(initial)
  initial.head = 999
  history.current.head = 999
  assert.equal(history.current.head, 0)
  history.record(point(100))
  history.peek(-1).head = 888
  assert.equal(history.peek(-1).head, 0)
  history.commit(-1)
  assert(notifications >= 3)
})

check('长输入更新比较基准，之后微移不记历史且保留前进分支', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(100))
  history.commit(-1)
  history.updateCurrent(point(1000), true)
  assert.equal(history.record(point(1001)), false)
  assert.equal(history.size, 2)
  assert.equal(history.canGoForward, true)
  assert.equal(history.current.head, 1001)
  assert.equal(history.record(point(1080)), true)
  assert.equal(history.canGoForward, false)
})

check('回放固定目标记录，删除当前位置后仍采用映射后的目标并正确提交', () => {
  const history = new NavigationHistory()
  history.record(point(0, { filePath: '/earlier.md' }))
  history.record(point(120))
  history.record(point(0, { filePath: null, tabId: 'blank' }))
  assert.equal(history.beginReplay(-1).head, 120)
  history.removeUntitled('blank')
  history.updateDocument({ filePath: '/a.md', tabId: 'unused' }, anchor => ({ ...anchor, head: anchor.head + 20 }))
  assert.equal(history.replayTarget.head, 140)
  assert.equal(history.commitReplay(), true)
  assert.equal(history.current.head, 140)
  assert.equal(history.peek(-1).filePath, '/earlier.md')
  assert.equal(history.canGoForward, false)
  assert.equal(history.replayTarget, null)
})

check('删除中间项合并目标时保留去重规则，回放仍能提交到保留下来的记录', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(0, { filePath: null, tabId: 'blank' }))
  history.record(point(10))
  history.commit(-1)
  assert.equal(history.beginReplay(1).head, 10)
  history.removeUntitled('blank')
  assert.equal(history.size, 1)
  assert.equal(history.replayTarget.head, 0, '合并保留原有的当前位置优先规则')
  assert.equal(history.commitReplay(), true)
  assert.equal(history.current.head, 0)
  assert.equal(history.canGoBack, false)
  assert.equal(history.canGoForward, false)
})

check('回放目标被删除或回放取消后不能提交过期目标', () => {
  const history = new NavigationHistory()
  history.record(point())
  history.record(point(0, { filePath: '/b.md' }))
  history.beginReplay(-1)
  history.removeFile('/a.md')
  assert.equal(history.replayTarget, null)
  assert.equal(history.commitReplay(), false)
  assert.equal(history.current.filePath, '/b.md')
  history.record(point(100, { filePath: '/b.md' }))
  history.beginReplay(-1)
  history.endReplay()
  assert.equal(history.commitReplay(), false)
  assert.equal(history.current.head, 100)
})

console.log(`导航历史验证完成：${passed} 项通过。`)
