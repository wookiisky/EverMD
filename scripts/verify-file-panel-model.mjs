// 文件列表只验证数据刷新与异步顺序；真实节点复用由侧栏窗口验收覆盖。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({ stdin: { contents: "export { FilePanelModel } from './src/renderer/file-panel-model'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { FilePanelModel } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const dir = path => ({ path, name: path.split('/').pop(), kind: 'directory' })
const file = path => ({ path, name: path.split('/').pop(), kind: 'file' })
const pending = []
let updates = 0
const model = new FilePanelModel(path => new Promise((resolve, reject) => pending.push({ path, resolve, reject })), () => updates++)
await model.replaceRoot([dir('/a'), dir('/b')])
model.toggle('/a')
assert.equal(pending.length, 1)
assert.equal(model.rows()[0].expanded, true)
pending.shift().resolve([file('/a/one.md'), dir('/a/nested')])
await new Promise(resolve => setImmediate(resolve))
assert.equal(model.rows()[1].file.path, '/a/one.md')
model.toggle('/a/nested')
pending.shift().resolve([])
await new Promise(resolve => setImmediate(resolve))
assert(model.rows().some(row => row.empty), '成功读取的空目录显示空行')
model.toggle('/b')
pending.shift().reject(new Error('没有权限'))
await new Promise(resolve => setImmediate(resolve))
assert(!model.rows().some(row => row.empty && row.file.path === '/b'), '读取失败不能伪装为空目录')
const first = model.replaceRoot([dir('/a'), dir('/b')])
const old = pending.splice(0)
const second = model.replaceRoot([dir('/a'), dir('/b')])
const current = pending.splice(0)
for (const request of current) request.resolve(request.path === '/a' ? [file('/a/new.md')] : [])
await second
for (const request of old) request.resolve([file('/a/stale.md')])
await first
assert(model.rows().some(row => row.file.path === '/a/new.md'))
assert(!model.rows().some(row => row.file.path === '/a/stale.md'), '旧一轮读取不能覆盖新结果')
const beforeSwitch = model.replaceRoot([dir('/a')])
const previousRoot = pending.splice(0)
await model.replaceRoot([file('/other/root.md')])
for (const request of previousRoot) request.resolve([file('/a/late.md')])
await beforeSwitch
assert.deepEqual(model.rows().map(row => row.file.path), ['/other/root.md'], '旧目录迟到结果不能回流')
assert(updates > 0)
console.log('通过：展开、空目录、失败隔离、刷新乱序、目录切换迟到读取')

// 折叠期间的刷新不读隐藏子树，重新展开后必须更新仍保持展开状态的后代。
const contents = new Map([
  ['/parent', [dir('/parent/child')]],
  ['/parent/child', [file('/parent/child/old.md')]],
])
const reads = []
const nested = new FilePanelModel(async path => { reads.push(path); return contents.get(path) ?? [] }, () => {})
const settle = () => new Promise(resolve => setImmediate(resolve))
await nested.replaceRoot([dir('/parent')])
nested.toggle('/parent'); await settle()
nested.toggle('/parent/child'); await settle()
nested.toggle('/parent')
contents.set('/parent/child', [file('/parent/child/new.md')])
await nested.replaceRoot([dir('/parent')])
reads.length = 0
nested.toggle('/parent'); await settle()
assert.deepEqual(reads, ['/parent', '/parent/child'], '重开父目录重新读取可见且展开的后代')
assert(nested.rows().some(row => row.file.path === '/parent/child/new.md'))
assert(!nested.rows().some(row => row.file.path === '/parent/child/old.md'))
console.log('通过：父目录折叠期间的后代变化，在重新展开时正确刷新')

// 一个目录未返回时，已经完成的目录必须独立通知视图。
const delayed = new Map()
let visiblePaths = []
const independent = new FilePanelModel(path => new Promise(resolve => delayed.set(path, resolve)), () => {
  visiblePaths = independent.rows().map(row => row.file.path)
})
await independent.replaceRoot([dir('/fast'), dir('/slow')])
independent.toggle('/fast')
independent.toggle('/slow')
delayed.get('/fast')([file('/fast/old.md')])
delayed.get('/slow')([file('/slow/old.md')])
await settle()
const refreshing = independent.replaceRoot([dir('/fast'), dir('/slow')])
delayed.get('/fast')([file('/fast/new.md')])
await settle()
assert(visiblePaths.includes('/fast/new.md'), '慢目录未完成时，快速目录的新结果已经通知视图')
assert(!visiblePaths.includes('/fast/old.md'))
delayed.get('/slow')([])
await refreshing
console.log('通过：慢目录不阻塞其他目录已经完成的刷新')
