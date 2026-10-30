#!/usr/bin/env node
// 执行实际的文档队列和链接入口，验证文件载入与定位共用一次导航边界。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transform } from 'esbuild'

const code = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8')
const queueStart = code.indexOf('function enqueueDocumentOperation<')
const queueEnd = code.indexOf('\n// 公开入口负责排队', queueStart)
const openStart = code.indexOf('function openFileInNewTab(')
const openEnd = code.indexOf('\n// 批量关闭', openStart)
const bindStart = code.indexOf('function bindTabBar(')
const bindEnd = code.indexOf('\n  // Tabs are also created', bindStart)
assert(queueStart >= 0 && queueEnd > queueStart && openStart >= 0 && openEnd > openStart && bindStart >= 0 && bindEnd > bindStart,
  '实际文档队列或链接入口已移动，需要同步测试入口')
const { code: compiled } = await transform([
  code.slice(queueStart, queueEnd), code.slice(openStart, openEnd),
  code.slice(bindStart, bindEnd) + '\n  globalThis.openLink = enqueueTabOpen\n}',
  'bindTabBar({})',
].join('\n'), { loader: 'ts' })

// 只替换磁盘和编辑器边界；被验证的入口、串行队列和历史提交顺序来自实际源码。
function harness() {
  const history = [{ path: '/source.md', position: 500 }]
  const source = { readOnly: false, focus() {} }
  const frames = []
  let activeOpens = 0, maxOpens = 0
  const context = {
    currentFilePath: '/source.md', position: 500, activeTabId: 'source', sourceModeActive: false,
    documentOperationQueue: Promise.resolve(), documentOperationActive: false,
    failOpen: false, failSave: false, frames, history, console,
    sourceEl: () => source, setEditorEditable() {}, isPresenting: () => false,
    getEditorView: () => null,
    requestAnimationFrame: action => { frames.push(action) },
    getMarkdown: () => Array.from({ length: 100 }, () => '正文').join('\n'),
    exitSourceMode: () => { context.sourceModeActive = false },
    async openFileInNewTabNow(path) {
      activeOpens++
      maxOpens = Math.max(maxOpens, activeOpens)
      await Promise.resolve()
      if (!context.failOpen && !context.failSave && context.currentFilePath !== path) {
        context.currentFilePath = path
        context.position = 0
      }
      activeOpens--
    },
    jumpToHeading(fragment) { jump(fragment === 'missing' ? context.position : 1200) },
    jumpToLine(line) { jump(line * 100) },
    jumpToSourceLine(_source, line) { jump((line - 1) * 100) },
    navigation: {
      beforeSwitch() {
        history.at(-1).position = context.position
      },
      afterSwitch(recordJump = false) {
        const point = { path: context.currentFilePath, position: context.position }
        if (history.at(-1).path !== point.path || recordJump && history.at(-1).position !== point.position) history.push(point)
        else Object.assign(history.at(-1), point)
      },
    },
  }
  function jump(position) {
    const changed = context.position !== position
    context.position = position
    if (changed && !context.documentOperationActive) history.push({ path: context.currentFilePath, position })
  }
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return {
    context,
    async settle() {
      // 不执行 rAF：隐藏窗口即使没有动画帧，也必须完成导航及历史提交。
      for (let i = 0; i < 30; i++) await Promise.resolve()
      await context.documentOperationQueue
    },
    get maxOpens() { return maxOpens },
  }
}

{
  const host = harness()
  host.context.openLink('/skills.md', 'follow_person')
  await host.settle()
  assert.deepEqual(host.context.history, [
    { path: '/source.md', position: 500 }, { path: '/skills.md', position: 1200 },
  ], '文件开头不能形成额外的返回步骤，隐藏窗口也应提交最终标题位置')
  assert.equal(host.context.frames.length, 0, '定位不留下会覆盖后续回退的延迟动画帧')
}
{
  const host = harness()
  host.context.openLink('/source.md', 'follow_person')
  await host.settle()
  assert.deepEqual(host.context.history, [
    { path: '/source.md', position: 500 }, { path: '/source.md', position: 1200 },
  ], '同文档显式链接仍形成独立跳转，原位置可回退')
}
for (const reason of ['failOpen', 'failSave']) {
  const host = harness()
  host.context[reason] = true
  host.context.openLink('/skills.md', 'follow_person')
  await host.settle()
  assert.equal(host.context.currentFilePath, '/source.md', `${reason} 保留原文件`)
  assert.equal(host.context.position, 500, `${reason} 不执行目标定位`)
  assert.equal(host.context.history.length, 1, `${reason} 不新增历史`)
}
for (const sourceMode of [false, true]) {
  const host = harness()
  host.context.sourceModeActive = sourceMode
  host.context.openLink('/skills.md', 'ignored', 15)
  await host.settle()
  assert.deepEqual(host.context.history, [
    { path: '/source.md', position: 500 }, { path: '/skills.md', position: 1400 },
  ], `${sourceMode ? '源码' : '渲染'}行号优先于标题，并在同一次操作中提交`)
}
{
  const host = harness()
  host.context.openLink('/first.md', 'follow_person')
  host.context.openLink('/second.md', undefined, 20)
  await host.settle()
  assert.deepEqual(host.context.history, [
    { path: '/source.md', position: 500 }, { path: '/first.md', position: 1200 }, { path: '/second.md', position: 1900 },
  ], '连续链接请求按调用顺序记录各自最终落点')
  assert.equal(host.maxOpens, 1, '连续链接请求共用文档队列，不交叉打开')
}
console.log('通过：跨文件标题只记一次、无帧完成、同文档跳转、读取与保存失败、两种模式行号定位、连续链接串行。')
