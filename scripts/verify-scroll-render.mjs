#!/usr/bin/env node
// 滚动渲染验收：滚到长文档没解析过的地方，那几行必须是**渲染过的**，不能是原始源码。
//
// 为什么需要它：装饰是从语法树上读出来的，而语法树按视口惰性解析。用户滚到还没解析的
// 区域时，CodeMirror 会照常把那几行渲染出来，但装饰里没有它们，于是屏幕上显示
// `- **加粗**` 这种原始标记，要点一下才会恢复正常（2026-09-26 报的「长文档只渲染了前面，
// 点击一下就渲染了」）。这个脚本就是盯这件事：每个滚动位置，视口里不许出现原始标记。
//
// 用法: npm run verify:scroll-render（先 npm run build）
// 窗口放在屏幕外，不占用屏幕。
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
assertBuildFresh()
const { dir: WORK, udd } = verifyWorkdir('scroll-render')

/** 文档要足够长，长到「打开时解析到的那一段」离尾部很远。 */
const ROWS = 1200
const POSITIONS = [0, 30000, 60000, 999999]

function fixture() {
  const lines = ['# 滚动渲染验收', '']
  for (let i = 1; i <= ROWS; i++) {
    lines.push(`- **第 ${i} 条**：这一段带加粗和\`行内代码\`，用来检查尾部有没有被装饰。`)
    lines.push('')
  }
  return lines.join('\n')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const msgId = ++id
          pending.set(msgId, { res, rej })
          ws.send(JSON.stringify({ id: msgId, method, params }))
        })
      },
      close: () => ws.close()
    }))
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    ws.addEventListener('error', () => reject(new Error(`连接不上 ${url}`)))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitTarget(port, predicate, ms = 30000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find(predicate)
      if (hit) return hit
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等不到调试目标')
}

function evaluate(client, expression) {
  return client.send('Runtime.evaluate', {
    expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
    return result.result?.value
  })
}

/** 视口里那几行：有几个还带着原始标记，有几个带内容装饰。 */
const PROBE = `(() => {
  const s = document.querySelector(".cm-scroller")
  const sr = s.getBoundingClientRect()
  const lines = [...document.querySelectorAll("#editor .cm-line")]
    .filter((l) => { const r = l.getBoundingClientRect(); return r.bottom > sr.top && r.top < sr.bottom })
  return JSON.stringify({
    top: Math.round(s.scrollTop),
    rows: lines.length,
    raw: lines.filter((l) => /\\*\\*/.test(l.textContent)).length,
    decorated: lines.filter((l) => /cm-md-(li|strong|hidden|code)/.test(l.className)).length,
    first: (lines[0]?.textContent ?? "").slice(0, 18)
  })
})()`

/** 模拟测量退出时视口已更新，但最后一次正文重画被跳过。 */
async function verifyStaleViewport(renderer) {
  const result = await evaluate(renderer, `(async () => {
    const scroller = document.querySelector('#editor .cm-scroller')
    const view = scroller.querySelector('.cm-content').cmTile.root.view
    const { doc, selection } = view.state
    const overlap = () => {
      const top = scroller.getBoundingClientRect().top + scroller.clientTop
      const bottom = top + scroller.clientHeight
      return Math.max(0, ...[...view.contentDOM.querySelectorAll(':scope > .cm-gap')].map(gap => {
        const rect = gap.getBoundingClientRect()
        return Math.min(bottom, rect.bottom) - Math.max(top, rect.top)
      }))
    }
    const docView = view.docView
    const redraw = docView.update
    const before = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        docView.update = redraw
        scroller.removeEventListener('scrollend', stop, true)
        reject(new Error('滚动未结束'))
      }, 2000)
      const stop = () => {
        clearTimeout(timeout)
        docView.update = redraw
        resolve({ gap: overlap(), top: scroller.scrollTop })
      }
      scroller.addEventListener('scrollend', stop, { capture: true, once: true })
      docView.update = () => false
      scroller.scrollTop = 30000
    })
    let updates = 0
    docView.update = function (update) {
      if (update.transactions.length) updates++
      return redraw.call(this, update)
    }
    try {
      await new Promise(resolve => setTimeout(resolve, 450))
      return {
        before,
        after: { gap: overlap(), top: scroller.scrollTop },
        updates,
        unchanged: view.state.doc === doc && view.state.selection.eq(selection),
      }
    } finally {
      docView.update = redraw
    }
  })()`)
  const { before, after, updates, unchanged } = result
  const ok = before.gap >= 150 && after.gap <= 2 && Math.abs(before.top - after.top) <= 2
    && updates === 1 && unchanged
  console.log(`${ok ? '✓' : '✗'} 停稳后的屏内占位：${before.gap}px → ${after.gap}px，` +
    `滚动位置 ${before.top} → ${after.top}，同步 ${updates} 次，原文和选区${unchanged ? '一致' : '变化'}`)
  return ok
}

async function main() {
  mkdirSync(WORK, { recursive: true })
  const source = join(WORK, 'big.md')
  writeFileSync(source, fixture(), 'utf8')

  const port = 9960 + Math.floor(Math.random() * 30)
  const child = spawn('npx', ['electron', 'scripts/offscreen-window.cjs', source, `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ], {
    cwd: APP, stdio: 'ignore', detached: true,
    env: { ...process.env, EVERMD_STARTUP_HOME: join(WORK, 'home') },
  })

  let failures = 0
  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const renderer = await connect(page.webSocketDebuggerUrl)
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    for (let i = 0; i < 80; i++) {
      const lines = await evaluate(renderer, `document.querySelectorAll('#editor .cm-line').length`)
      if (Number(lines) > 5) break
      await sleep(250)
    }

    for (const position of POSITIONS) {
      await evaluate(renderer, `document.querySelector(".cm-scroller").scrollTop = ${position}`)
      // 装饰是从语法树上读的，而语法树按视口惰性解析：滚过去之后要等它铺到视口。
      // 机器忙的时候这一步会慢，所以轮询等它稳定，而不是睡一个固定时长
      // （2026-09-26：固定 1600ms 在连续跑测试时会假红）。
      let state = null
      const started = Date.now()
      for (let i = 0; i < 25; i++) {
        state = JSON.parse(await evaluate(renderer, PROBE))
        if (state.raw === 0 && state.decorated > 0) break
        await sleep(200)
      }
      const waited = Date.now() - started
      const ok = state.raw === 0 && state.decorated > 0
      if (!ok) failures++
      console.log(`${ok ? '✓' : '✗'} 滚到 ${String(position).padStart(6)}：` +
        `视口 ${state.rows} 行，原始标记 ${state.raw} 行，有装饰 ${state.decorated} 行，` +
        `等了 ${waited}ms，首行「${state.first}」`)
    }
    if (!await verifyStaleViewport(renderer)) failures++
  } finally {
    stopVerifyApp(udd)
    await sleep(300)
    rmSync(WORK, { recursive: true, force: true })
  }

  if (failures) {
    console.log(`\n✗ ${failures} 项滚动渲染检查失败`)
    process.exitCode = 1
  } else {
    console.log(`\n✓ ${POSITIONS.length + 1} 项滚动渲染检查通过`)
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
})
