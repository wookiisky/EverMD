// 文件监听验收的可控时钟、监听事件和异步读取，避免依赖操作系统事件时序。
import { basename, dirname, extname } from 'node:path'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['watchFile', 'stopWatching', 'notifyExternalChange'].includes(node.name?.text))
if (functions.length !== 3) throw new Error('未找到文件监听函数')
const compiled = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

// 加载实际监听函数，只有操作系统和 Electron 边界由测试控制。
export function fileWatchingFixture() {
  let now = 0
  let nextTimerId = 0
  const timers = new Map()
  const watchers = []
  const reads = []
  const directoryReads = []
  const events = []
  let destroyed = false
  const state = {
    filePath: '/docs/A.md', browsePath: '/docs', watcher: null, watchVersion: 0,
    isInternalSave: false, lastInternalSaveContent: null, lastKnownMtime: 1,
    debounceTimer: null, siblingsTimer: null
  }
  const win = { isDestroyed: () => destroyed, webContents: { send: (...args) => events.push(args) } }
  const bindings = {
    dirname, basename, extname, MARKDOWN_EXTENSIONS: ['.md'],
    Date: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout: id => timers.delete(id),
    watch: (path, callback) => {
      const watcher = {
        path, callback, closed: false, error: null,
        close() { this.closed = true },
        on(event, callback) { if (event === 'error') this.error = callback }
      }
      watchers.push(watcher)
      return watcher
    },
    readFile: path => new Promise((resolve, reject) => reads.push({ path, resolve, reject })),
    listSiblingFiles: path => new Promise(resolve => directoryReads.push({ path, resolve })),
    fileMtimeMs: () => 20,
    existsSync: () => true
  }
  bindings.getState = () => state
  const { watchFile, stopWatching, notifyExternalChange } = new Function(...Object.keys(bindings),
    compiled + '\nreturn { watchFile, stopWatching, notifyExternalChange }')(...Object.values(bindings))

  return {
    state, events, reads, watchers, timers, directoryReads,
    start: () => watchFile(win, state),
    stop: () => stopWatching(state),
    notify: path => notifyExternalChange(win, path),
    switchTo(path) { state.filePath = path; watchFile(win, state) },
    destroy() { destroyed = true },
    advance(ms) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    change(event = 'change', filename = 'A.md') { watchers.at(-1).callback(event, filename) },
    async settle() { await Promise.resolve(); await Promise.resolve() }
  }
}
