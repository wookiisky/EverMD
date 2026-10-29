// 虚拟列表用实际测量高度计算偏移；混合行、视口末尾和空列表都不能漏项。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({ entryPoints: ['src/renderer/file-panel-window.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent' })
const { FilePanelWindow } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const row = (kind, empty = false) => ({ file: { kind, name: kind, path: `/${kind}` }, depth: 0,
  expanded: false, expandable: kind === 'directory', empty })
const rows = [row('parent'), row('directory'), row('directory', true), ...Array.from({ length: 10000 }, () => row('file'))]
const dimensions = { normal: 28.1875, parent: 32.1875, empty: new Map([[0, 25.5], [10, 50.5]]), gap: 1 }
const window = new FilePanelWindow(rows, dimensions)
assert.equal(window.top(0), 0)
assert.equal(window.top(1), dimensions.parent + dimensions.gap)
assert.equal(window.top(3), dimensions.parent + dimensions.normal + dimensions.empty.get(0) + dimensions.gap * 3)
assert.equal(window.height, dimensions.parent + dimensions.empty.get(0) + dimensions.normal * 10001 + dimensions.gap * 10002)
const deep = new FilePanelWindow([{ ...row('directory', true), depth: 10 }, row('file')], dimensions)
assert.equal(deep.top(1), 51.5, '深层空目录采用自身换行高度，而不是浅层提示高度')
assert.deepEqual(window.range(0, 20, 0), { from: 0, to: 1 })
assert.deepEqual(window.range(window.top(2), 20, 0), { from: 2, to: 3 })
assert.deepEqual(window.range(window.height - 20, 20, 0), { from: rows.length - 1, to: rows.length })
const middle = window.range(window.top(5000), 500, 200)
assert(middle.from < 5000 && middle.to > 5000 && middle.to - middle.from < 40)
assert.deepEqual(new FilePanelWindow([], dimensions).range(0, 500, 200), { from: 0, to: 0 })
assert.equal(new FilePanelWindow([], dimensions).height, 0)
console.log('通过：混合行高度、间距累计、首尾边界、视口缓冲与空列表')
