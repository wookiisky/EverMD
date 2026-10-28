// 在纯配置边界验证迁移、无效输入和窄窗口分配，不依赖 DOM。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({ entryPoints: ['src/renderer/sidebar-preferences.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { loadSidebarPreferences, sidebarWidths, clampSidebarWidth, SIDEBAR_STORAGE_KEY } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const storage = values => ({ getItem: key => values[key] ?? null })
const defaults = { left: { content: 'files', visible: false, width: 220 }, right: { content: 'outline', visible: false, width: 220 } }
assert.deepEqual(loadSidebarPreferences(storage({})), defaults)
for (const oldSide of ['left', 'right']) {
  assert.deepEqual(loadSidebarPreferences(storage({ 'file-panel-hidden': '0', 'file-panel-width': '280', 'colamd-panel-side': oldSide })), { ...defaults, left: { content: 'files', visible: true, width: 280 } })
}
const custom = { left: { content: 'outline', visible: true, width: 300 }, right: { content: 'files', visible: true, width: 260 } }
assert.deepEqual(loadSidebarPreferences(storage({ [SIDEBAR_STORAGE_KEY]: JSON.stringify(custom) })), custom)
assert.deepEqual(loadSidebarPreferences(storage({ [SIDEBAR_STORAGE_KEY]: '{' })), defaults)
assert.deepEqual(loadSidebarPreferences(storage({ [SIDEBAR_STORAGE_KEY]: 'null' })), defaults)
assert.deepEqual(loadSidebarPreferences(storage({ [SIDEBAR_STORAGE_KEY]: JSON.stringify({ left: { content: 'unknown', visible: 'false', width: -2 }, right: { content: 'files', visible: true, width: 1000 } }) })), { left: { content: 'files', visible: false, width: 180 }, right: { content: 'files', visible: true, width: 420 } })
assert.equal(clampSidebarWidth(NaN), 220)
assert.equal(clampSidebarWidth(Infinity), 220)
assert.deepEqual(sidebarWidths(defaults, 1000), { left: 0, right: 0 })
assert.deepEqual(sidebarWidths(custom, 1200), { left: 300, right: 260 })
const narrow = sidebarWidths(custom, 600)
assert.equal(narrow.left + narrow.right, 280)
assert.equal(narrow.left / narrow.right, 300 / 260)
assert.deepEqual(custom.left, { content: 'outline', visible: true, width: 300 })
assert.deepEqual(sidebarWidths(custom, 1200), { left: 300, right: 260 })
assert.deepEqual(sidebarWidths({ ...custom, right: { ...custom.right, visible: false } }, 600), { left: 280, right: 0 })
assert.deepEqual(sidebarWidths(custom, 200), { left: 0, right: 0 })
console.log('通过：侧栏配置默认值、旧配置迁移、内容对调、无效输入、独立宽度和窄窗口恢复')
