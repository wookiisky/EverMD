// 每个用例单独加载真实模块，替换 Electron 与更新器边界，不触发网络或真实应用。
export function createUpdaterFixture(code, { isPackaged = true, updatesEnabled = true } = {}) {
  const state = { imports: 0, importError: null, updater: {} }
  const fakeRequire = name => {
    if (name === 'electron') return { app: { isPackaged } }
    if (name === '../shared/app-config.json') return { updatesEnabled }
    if (name === 'electron-updater') {
      state.imports++
      if (state.importError) throw state.importError
      return { autoUpdater: state.updater }
    }
    throw new Error(`未配置测试依赖：${name}`)
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(fakeRequire, module, module.exports)
  return { state, loadAutoUpdater: module.exports.loadAutoUpdater }
}
