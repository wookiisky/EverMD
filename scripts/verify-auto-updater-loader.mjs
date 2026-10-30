// 更新器延迟加载契约：禁用无加载、并发初始化一次、错误可见且允许显式重试。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
import { createUpdaterFixture } from './auto-updater-loader-test-fixture.mjs'

const source = readFileSync(new URL('../src/main/auto-updater-loader.ts', import.meta.url), 'utf8')
// 把动态导入转成异步 require，仅替换模块边界，测试的控制流来自真实 TypeScript。
const { code } = await transform(source, {
  loader: 'ts', format: 'cjs', target: 'es2022', supported: { 'dynamic-import': false }
})

for (const options of [{ isPackaged: false }, { updatesEnabled: false }]) {
  const { loadAutoUpdater, state } = createUpdaterFixture(code, options)
  assert.equal(await loadAutoUpdater(() => assert.fail('关闭更新时不得初始化')), null)
  assert.equal(state.imports, 0, '开发模式或禁用更新时不得加载更新器')
}

{
  const { loadAutoUpdater, state } = createUpdaterFixture(code)
  let initialized = 0
  const initialize = updater => {
    initialized++
    updater.configured = true
  }
  const pending = [loadAutoUpdater(initialize), loadAutoUpdater(initialize), loadAutoUpdater(initialize)]
  assert.equal(state.imports, 0, '首次调用不应同步加载重模块')
  const results = await Promise.all(pending.map(result => result.then(updater => {
    assert.equal(updater.configured, true, '调用方收到实例前初始化必须完成')
    return updater
  })))
  assert(results.every(result => result === state.updater), '所有并发入口共用更新器实例')
  assert.equal(state.imports, 1)
  assert.equal(initialized, 1, '并发检查与下载不得重复配置和注册监听')
  assert.equal(await loadAutoUpdater(() => assert.fail('已初始化不再配置')), state.updater)
  assert.equal(state.imports, 1, '后续调用复用已完成的加载任务')
}

{
  const { loadAutoUpdater, state } = createUpdaterFixture(code)
  const error = new Error('模块载入失败')
  state.importError = error
  const pending = [loadAutoUpdater(() => assert.fail('载入失败不初始化')), loadAutoUpdater(() => {})]
  for (const result of await Promise.allSettled(pending)) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, error, '保留原始载入错误')
  }
  assert.equal(state.imports, 1, '失败任务也由并发调用共享')
  state.importError = null
  assert.equal(await loadAutoUpdater(() => {}), state.updater, '失败后新的显式调用可重试')
  assert.equal(state.imports, 2)
}

{
  const { loadAutoUpdater, state } = createUpdaterFixture(code)
  const error = new Error('初始化失败')
  await assert.rejects(loadAutoUpdater(() => { throw error }), received => received === error)
  let initialized = false
  assert.equal(await loadAutoUpdater(() => { initialized = true }), state.updater)
  assert.equal(initialized, true, '初始化失败后不得返回未配置实例')
}

console.log('通过：开发及禁用更新无加载、并发初始化一次、初始化完成后交付、错误传播与显式重试')
