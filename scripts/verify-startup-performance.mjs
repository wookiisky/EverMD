#!/usr/bin/env node
// 串行启动真实离屏 Electron。新配置与复用配置分别记录，不把进程重启称为冷磁盘启动。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'
import { writePerformanceReport } from './performance-fixture.mjs'
import { preparePackagedStartup } from './startup-packaged-probe.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const sampleCount = Number(option('--samples', 7))
assert(Number.isInteger(sampleCount) && sampleCount > 0, '--samples 必须为正整数')
const baseline = args.includes('--baseline')
const verifyConcurrent = args.includes('--verify-concurrent')
if (baseline) console.error('基线模式：使用已保留的构建，不声称包含当前源码。')
else assertBuildFresh()

const root = fileURLToPath(new URL('..', import.meta.url))
const appPath = args.includes('--app') ? resolve(option('--app')) : null
const compareDist = args.includes('--compare-dist') ? resolve(option('--compare-dist')) : null
assert(!appPath || process.platform === 'darwin', '--app 只支持本机 macOS 应用')
assert(!appPath || !args.includes('--dist'), '--app 和 --dist 不能同时使用')
assert(!appPath || !compareDist, '--app 和 --compare-dist 不能同时使用')
const dist = appPath ? join(appPath, 'Contents/Resources/app.asar/dist') : resolve(option('--dist', join(root, 'dist')))
if (!appPath && !baseline) {
  assert.equal(realpathSync(dist), realpathSync(join(root, 'dist')),
    '自定义构建必须显式使用 --baseline；普通模式只验证当前 dist')
}
const buildPath = appPath ? join(appPath, 'Contents/Resources/app.asar') : join(dist, 'main/index.js')
let appExecutable
if (appPath) {
  const executableDir = join(appPath, 'Contents/MacOS')
  const entries = readdirSync(executableDir).filter(name => !name.startsWith('.'))
  assert.equal(entries.length, 1, '无法确定 .app 的唯一主程序')
  appExecutable = join(executableDir, entries[0])
  if (!baseline) assert(statSync(buildPath).mtimeMs >= statSync(join(root, 'dist/main/index.js')).mtimeMs,
    '本地包比当前 dist 旧，请重新打包或显式使用 --baseline')
}
const require = createRequire(import.meta.url)
const { dir } = verifyWorkdir('startup-performance')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = "document.querySelector('#editor .cm-content')?.cmTile?.root?.view"
const report = { baseline, platform: process.platform, arch: process.arch, sampleCount, warmupCount: 1,
  launchMode: appPath ? 'packaged-inspector' : 'dist', appPath,
  dist, buildMtime: statSync(buildPath).mtime.toISOString(),
  boundary: '从 spawn 到 CDP 观察到可编辑 DOM、启动正文完整并读取同步布局；包含调试连接和轮询开销，不代表显示器首帧或清空系统磁盘缓存后的启动。输入撤销在计时结束后另行断言。',
  mainLoadBoundary: 'dist 模式在离屏壳 require 主入口前后用同一进程时钟计时，包含同步模块加载及主入口初始化，不含 Electron 启动或异步 app.whenReady 工作；原生模式记为 null。',
  packagedBoundary: appPath ? '原生 .app 在主模块入口暂停，接入相同的隔离及离屏壳后继续执行。总观察值包含 inspector 暂停和接入成本，仅能与同样测法的原生包比较，不能与无入口暂停的 dist 数值混比。' : null,
  results: [] }
if (compareDist) report.comparison = {
  beforeDist: compareDist, beforeBuildMtime: statSync(join(compareDist, 'main/index.js')).mtime.toISOString(),
  order: '每组配置各预热一次，随后每次交替 before/after 和 after/before；两份构建使用独立 home 与 userData。'
}
const fixtures = [
  { name: 'empty', text: null, body: JSON.parse(readFileSync(join(root, 'src/shared/app-config.json'), 'utf8')).labels.en.welcome },
  { name: 'markdown', text: '---\r\ntitle: Startup benchmark\r\n---\r\n# Startup benchmark\r\n\r\n普通正文 **mixed English**。\r\n',
    body: '---\ntitle: Startup benchmark\n---\n# Startup benchmark\n\n普通正文 **mixed English**。\n' },
  { name: 'math', text: '# Formula\n\nInline $a^2+b^2=c^2$.\n\n$$\nE=mc^2\n$$\n',
    body: '# Formula\n\nInline $a^2+b^2=c^2$.\n\n$$\nE=mc^2\n$$\n' }
]
for (const item of fixtures) {
  if (item.text === null) continue
  item.path = join(dir, `${item.name}.md`)
  writeFileSync(item.path, item.text)
  item.mtime = statSync(item.path).mtimeMs
}

// 断线和调试异常不能被当成应用就绪，所有请求都有自己的超时。
async function connect(port, child) {
  let target
  for (let attempt = 0; attempt < 1500 && !target; attempt++) {
    assert(child.exitCode === null, '启动进程提前退出')
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = targets.find(item => item.type === 'page')
    } catch { /* Chromium 尚未开放调试端口。 */ }
    if (!target) await pause(10)
  }
  assert(target, '未找到渲染调试目标')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('调试目标提前关闭'))
    }
    pending.clear()
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`调试请求超时：${method}`)) }, 15000)
        pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close()
  }
}

// 只读取页面的可序列化状态，表达式异常直接失败。
async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails))
  return response.result.value
}

// 函数成功时返回真实观测值，固定等待不能替代正文或事件断言。
async function waitFor(read, message) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    const value = await read()
    if (value) return value
    await pause(10)
  }
  throw new Error(message)
}

// 一次只运行一个应用实例；home 和 userData 都在本脚本的临时目录内。
async function launch(item, profileDir, concurrent = false, launchDist = dist) {
  const home = join(profileDir, 'home'), userData = join(profileDir, 'udd-main')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'language.json'), JSON.stringify({ language: 'en' }))
  const env = { ...process.env, EVERMD_STARTUP_HOME: home, EVERMD_STARTUP_UDD: userData,
    EVERMD_STARTUP_DIST: launchDist, EVERMD_STARTUP_CONCURRENT: concurrent ? '1' : '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const port = 31000 + Math.floor(Math.random() * 10000)
  const inspectPort = port + 11000
  const events = []
  let output = '', partial = '', client
  const started = performance.now()
  const child = spawn(appExecutable ?? require('electron'), [...(appPath ? [] : ['scripts/startup-performance-window.cjs']), ...(item.path ? [item.path] : []),
    `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`,
    ...(appPath ? [`--inspect-brk=${inspectPort}`] : []),
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', data => {
    partial += data.toString()
    const lines = partial.split('\n')
    partial = lines.pop()
    for (const line of lines) {
      if (line.startsWith('EVERMD_STARTUP_PROBE ')) events.push(JSON.parse(line.slice('EVERMD_STARTUP_PROBE '.length)))
    }
  })
  child.stderr.on('data', data => { output = (output + data.toString()).slice(-12000) })
  try {
    const preparation = appPath ? await preparePackagedStartup(child, inspectPort) : null
    if (concurrent) {
      await waitFor(() => events.some(event => event.event === 'configuration-request' && event.channel === 'list-theme-definitions'),
        '语言和文件管理器响应挂起时，没有发出主题请求')
      const channels = events.filter(event => event.event === 'configuration-request').map(event => event.channel)
      assert(channels.includes('get-language') && channels.includes('get-file-manager-name'), '三个启动配置请求没有同时进入')
    }
    client = await connect(port, child)
    const editorObservedMs = await waitFor(async () => await evaluate(client,
      `Boolean(${view} && document.querySelector('#editor .cm-content')?.isContentEditable)`) && performance.now() - started,
    '编辑器没有变为可编辑')
    await waitFor(() => evaluate(client, `${view}?.state.doc.toString() === ${JSON.stringify(item.body)}`), '启动正文不完整')
    if (item.name === 'math') await waitFor(() => evaluate(client, 'document.querySelectorAll(".katex").length >= 2'), '启动公式未渲染')
    await evaluate(client, "document.querySelector('#editor .cm-content').getBoundingClientRect(); true")
    const documentObservedMs = performance.now() - started
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await evaluate(client, `${view}.focus(); true`)
    await client.send('Input.insertText', { text: 'Z' })
    await waitFor(() => evaluate(client, `${view}.state.doc.length === ${item.body.length + 1}`), '真实输入没有进入编辑器')
    const modifiers = process.platform === 'darwin' ? 4 : 2
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers })
    await waitFor(() => evaluate(client, `${view}.state.doc.toString() === ${JSON.stringify(item.body)}`), '撤销没有恢复原文')
    child.stdin.write('state\n')
    const state = await waitFor(() => events.find(event => event.event === 'state'), '未收到隔离路径确认')
    assert.equal(realpathSync(state.home), realpathSync(home), 'home 未隔离')
    assert.equal(realpathSync(state.userData), realpathSync(userData), 'userData 未隔离')
    assert.equal(state.saveRequests, 0, '输入及撤销期间发生意外保存')
    assert.equal(state.isPackaged, Boolean(appPath), '应用运行模式与测量声明不一致')
    report.electron ??= state.electron
    const isolated = await waitFor(() => events.find(event => event.event === 'isolated'), '未收到主入口加载记录')
    assert(appPath ? isolated.mainLoadMs === null : Number.isFinite(isolated.mainLoadMs), '主入口计时边界无效')
    if (item.path) {
      assert.equal(readFileSync(item.path, 'utf8'), item.text, '启动或输入撤销改变了磁盘字节')
      assert.equal(statSync(item.path).mtimeMs, item.mtime, '启动或输入撤销改变了磁盘 mtime')
    }
    return { editorObservedMs, documentObservedMs, mainLoadMs: isolated.mainLoadMs, preparation }
  } catch (error) {
    throw new Error(`${item.name} 启动验收失败：${error.message}\n${output}`, { cause: error })
  } finally {
    client?.close()
    stopVerifyApp(userData)
    child.kill()
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
  }
}

// 小样本报告中位数和范围，同时保存全部观察值，避免将最大值称为稳定 P95。
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), valuesMs: values }
}

if (verifyConcurrent) {
  await launch(fixtures[1], join(dir, 'concurrent'), true)
  console.log('通过：语言和文件管理器响应挂起时，主题请求已发出；正文、真实输入、撤销及隔离目录正确。')
} else {
  const builds = compareDist ? [{ name: 'before', dist: compareDist }, { name: 'after', dist }] : [{ name: 'current', dist }]
  for (const item of fixtures) for (const configuration of ['fresh', 'reused']) {
    const samplesByBuild = new Map(builds.map(build => [build.name, []]))
    for (let index = 0; index <= sampleCount; index++) {
      const order = index % 2 ? [...builds].reverse() : builds
      for (const build of order) {
        const profileDir = join(dir, `${item.name}-${configuration}-${build.name}`)
        if (configuration === 'fresh') rmSync(profileDir, { recursive: true, force: true })
        const result = await launch(item, profileDir, false, build.dist)
        if (index > 0) samplesByBuild.get(build.name).push(result)
      }
    }
    for (const build of builds) {
      const samples = samplesByBuild.get(build.name)
      report.results.push({ fixture: item.name, configuration, build: build.name,
        editor: summary(samples.map(sample => sample.editorObservedMs)),
        document: summary(samples.map(sample => sample.documentObservedMs)),
        mainLoad: appPath ? null : summary(samples.map(sample => sample.mainLoadMs)),
        inspector: appPath ? summary(samples.map(sample => sample.preparation.inspectorPreparationMs)) : null,
        inspectorPreparation: appPath ? samples.map(sample => sample.preparation) : undefined })
      console.error(`完成：${item.name}/${configuration}/${build.name}，正文中位 ${Math.round(report.results.at(-1).document.medianMs)} ms`)
    }
  }
  writePerformanceReport(report)
}
