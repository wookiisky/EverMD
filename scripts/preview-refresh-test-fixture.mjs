// 保留真实 EditorState 与解析插件，仅替代窗口分发和定时器以确定性检查重复刷新。
export function previewRefreshHarness(state, extension, refreshEffect) {
  const timers = new Map()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let timerId = 0
  let refreshes = 0
  let plugin
  const view = {
    state,
    viewport: { from: 0, to: state.doc.length },
    dom: { isConnected: true },
    dispatch(spec) {
      const startState = this.state
      const transaction = this.state.update(spec)
      if (transaction.effects.some(effect => effect.is(refreshEffect))) refreshes++
      this.state = transaction.state
      plugin.update({ state: this.state, startState, view: this, docChanged: transaction.docChanged, viewportChanged: false })
    },
  }
  plugin = extension.create(view)
  globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId }
  globalThis.clearTimeout = id => { timers.delete(id) }
  return {
    view,
    get refreshes() { return refreshes },
    get pending() { return timers.size },
    update(nextState = view.state) {
      const startState = view.state
      view.state = nextState
      view.viewport = { from: 0, to: nextState.doc.length }
      plugin.update({ state: nextState, startState, view, docChanged: nextState.doc !== startState.doc, viewportChanged: true })
    },
    flush() {
      let runs = 0
      while (timers.size && runs++ < 100) {
        const [id, callback] = timers.entries().next().value
        timers.delete(id)
        callback()
      }
      if (timers.size) throw new Error('解析刷新定时器没有收敛')
    },
    destroy() { plugin.destroy?.() },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}
