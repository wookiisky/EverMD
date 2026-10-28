// 只替代 Electron 和时钟；被测函数与监听器全部从当前 TypeScript 源码提取。
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import ts from 'typescript'

// 从 AST 查找声明和调用，不靠文本截取函数结束位置。
function sourceParts(file, baseline = false) {
  const source = baseline ? execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' })
    : readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  return {
    functions(names) {
      const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
      if (nodes.length !== names.length) throw new Error(`没有找到实际函数：${names.join(', ')}`)
      return nodes.map(node => node.getText(ast)).join('\n')
    },
    registration(method, event) {
      let result = null
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === method
          && (!event || ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === event)) result = node.getText(ast)
        ts.forEachChild(node, visit)
      }
      visit(ast)
      if (!result) throw new Error(`没有找到实际监听器：${event ?? method}`)
      return result
    },
  }
}

// 编译选中的真实源码，测试边界通过显式参数注入。
function load(source, bindings, exports) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(bindings), compiled + '\nreturn ' + exports)(...Object.values(bindings))
}

// 可控时钟能证明超过握手超时后仍等待用户，而不需要真实等待数秒。
export function lifecycleClock() {
  let now = 0, nextId = 0
  const timers = new Map()
  return {
    timers,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const until = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at
        timers.delete(id)
        timer.callback()
      }
      now = until
    },
  }
}

// 真实关闭请求使用可控 IPC 和事件发射器，验证 sender、计时器及退出清理。
export function windowCloseFixture() {
  const parts = sourceParts('src/main/index.ts')
  const clock = lifecycleClock(), handlers = new Map(), sent = []
  const webContents = new EventEmitter()
  Object.assign(webContents, { id: 42, send: (...args) => sent.push(args) })
  const win = { webContents }
  const body = `let nextWindowCloseRequestId = 0; const pendingWindowCloseRequests = new Map();\n`
    + parts.functions(['requestWindowClose']) + '\n'
    + parts.registration('on', 'window-close-started') + '\n' + parts.registration('on', 'window-close-response')
  const { requestWindowClose, pending } = load(body, {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ipcMain: { on: (event, callback) => handlers.set(event, callback) },
  }, '({requestWindowClose, pending:pendingWindowCloseRequests})')
  return {
    clock, win, sent, pending,
    request: () => requestWindowClose(win),
    emit(event, requestId, approved, sender = webContents.id) { handlers.get(event)({ sender: { id: sender } }, requestId, approved) },
  }
}

// 复用实际确认函数，以可控 Promise 观察重复关窗是否共享同一次工作。
export function concurrentCloseFixture() {
  const parts = sourceParts('src/main/index.ts')
  let calls = 0, finish
  const { confirmWindowClose } = load(parts.functions(['confirmWindowClose']), {
    handleWindowClose: () => { calls++; return new Promise(resolve => { finish = resolve }) },
  }, '({confirmWindowClose})')
  return { confirmWindowClose, get calls() { return calls }, finish: value => finish(value) }
}

// 实际退出监听器逐窗确认；窗口集合和每次确认 Promise 由测试控制。
export function beforeQuitFixture() {
  const parts = sourceParts('src/main/index.ts')
  const handlers = new Map(), windows = [], calls = [], approvals = new Map()
  let quitCalls = 0, prevented = 0
  const app = {
    on: (event, callback) => handlers.set(event, callback),
    quit() { quitCalls++; handlers.get('before-quit')({ preventDefault() { prevented++ } }) },
  }
  const state = load('let isQuitting=false, quitInProgress=false;\n' + parts.registration('on', 'before-quit'), {
    app, BrowserWindow: { getAllWindows: () => windows }, getState: win => win.state,
    confirmWindowClose: win => { calls.push(win.id); return new Promise(resolve => approvals.set(win.id, resolve)) },
  }, '({get quitting(){return isQuitting}, get inProgress(){return quitInProgress}})')
  return {
    windows, calls, state, get quitCalls() { return quitCalls }, get prevented() { return prevented },
    add(id) {
      const sent = [], win = { id, state: {}, destroyed: false, isDestroyed() { return this.destroyed }, webContents: { send: (...args) => sent.push(args) }, sent }
      windows.push(win)
      return win
    },
    quit() { handlers.get('before-quit')({ preventDefault() { prevented++ } }) },
    approve(id, value) {
      const resolve = approvals.get(id)
      if (!resolve) throw new Error(`窗口尚未请求关闭：${id}`)
      approvals.delete(id)
      resolve(value)
    },
    async settle() { await Promise.resolve(); await Promise.resolve() },
  }
}

// 恢复文件写入真实临时目录，只固定时间以复现同名同秒碰撞边界。
export function recoveredCopyFixture(recoveryDir) {
  const parts = sourceParts('src/main/index.ts')
  const fixedTime = new Date('2026-10-28T12:00:00+08:00').valueOf()
  class FixedDate extends Date {
    constructor() { super(fixedTime) }
  }
  const errors = []
  const { keepRecoveredCopy } = load(parts.functions(['keepRecoveredCopy']), {
    recoveryDir, join, basename, extname, randomUUID, mkdir, writeFile,
    Date: FixedDate, console: { error: (...args) => errors.push(args) },
  }, '({keepRecoveredCopy})')
  return { keepRecoveredCopy, errors }
}

// 冲突监听器和保存调度器共享同一组真实局部状态，旧 HEAD 可单独验证失败。
export function externalConflictFixture(baseline = false) {
  const parts = sourceParts('src/renderer/main.ts', baseline)
  const clock = lifecycleClock(), handlers = {}, statuses = []
  let saves = 0
  const source = `let currentFilePath='/docs/A.md', externalConflictPending=true, autosaveTimer=null, dirty=true, windowClosePreparing=false;\n`
    + parts.functions(['scheduleAutosave']) + '\n' + parts.registration('onExternalConflictResult')
  const state = load(source, {
    api: { onExternalConflictResult: callback => { handlers.conflict = callback } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    runAutosave: () => { saves++ }, showSaveStatus: value => statuses.push(value),
    applyContent: () => {}, navigation: null, resetDirty: () => {}, updateWordCount: () => {},
    scheduleOutlineUpdate: () => {}, showRecoveryHint: () => {},
  }, '({ get pending(){return externalConflictPending}, get timer(){return autosaveTimer}, set dirty(value){dirty=value}, set path(value){currentFilePath=value} })')
  return { clock, state, statuses, get saves() { return saves }, keep: () => handlers.conflict({ action: 'keep' }) }
}
