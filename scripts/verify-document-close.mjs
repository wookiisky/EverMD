// 在保存边界验证关窗流程，不删除标签，也不将后台正文交给活动文件保存。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: ['src/renderer/document-close.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { prepareDocumentsForClose } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

// 每个测试保留独立标签和选择，模拟可取消的真实保存边界。
function host(choices, saveResult = true) {
  const tabs = [{ id: 'untitled', path: null, content: '后台正文', dirty: true }, { id: 'active', path: '/active.md', content: '当前正文', dirty: false }]
  let active = 'active'
  const calls = []
  return { tabs, calls, get active() { return active },
    options: {
      activeId: () => active,
      dirtyIds: () => tabs.filter(tab => tab.dirty).map(tab => tab.id),
      activate: async id => { calls.push(['activate', id]); active = id; return true },
      confirm: async () => { calls.push(['confirm', active]); return choices.shift() ?? 'cancel' },
      save: async () => { calls.push(['save', active]); if (saveResult) tabs.find(tab => tab.id === active).dirty = false; return saveResult }
    }
  }
}

for (const [choice, saveResult, expected] of [['cancel', true, false], ['save', false, false], ['save', true, true], ['discard', true, true]]) {
  const test = host([choice], saveResult)
  assert.equal(await prepareDocumentsForClose(test.options), expected)
  assert.equal(test.active, 'active', '结束时恢复原活动标签')
  assert.equal(test.tabs.length, 2, '确认和保存不删除标签')
  assert.deepEqual(test.calls.filter(call => call[0] === 'save'), choice === 'save' ? [['save', 'untitled']] : [])
  if (choice !== 'save' || !saveResult) assert(test.tabs[0].dirty, '取消或备份丢弃仍保留内存正文')
}
const multiple = host(['save', 'cancel'])
multiple.tabs[1].dirty = true
assert.equal(await prepareDocumentsForClose(multiple.options), false)
assert.equal(multiple.tabs[0].dirty, false)
assert.equal(multiple.tabs[1].dirty, true)
assert.equal(multiple.tabs.length, 2)

const missing = host(['save'])
missing.options.activate = async () => false
assert.equal(await prepareDocumentsForClose(missing.options), false)
assert.equal(missing.calls.length, 0, '不能激活时不确认或保存另一篇正文')
console.log('通过：后台未命名标签、保存成功/失败/取消、备份丢弃、多标签中止、激活失败与标签保留')
