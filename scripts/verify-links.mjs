#!/usr/bin/env node
// Run after npm run build. --unit skips the isolated Electron window.
// The harness uses its own home/userData and never opens the user's documents.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { assertBuildFresh } from './build-freshness.mjs'
import { build, transform } from 'esbuild'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv.includes('--unit')) assertBuildFresh()

const WORK = mkdtempSync(join(tmpdir(), 'colamd-verify-links-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`) }
// macOS turns Ctrl+left-click into a right-click, so the modifier has to be Cmd there.
const MOD = process.platform === 'darwin' ? 4 : 2

async function unitChecks() {
  for (const [name, entry] of [['paths', 'src/main/markdown-link.ts'], ['headings', 'src/renderer/editor/heading-anchor.ts']]) {
    await build({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: join(WORK, `${name}.cjs`) })
  }
  const { resolveMarkdownLink } = require(join(WORK, 'paths.cjs'))
  const { headingAnchorLine } = require(join(WORK, 'headings.cjs'))
  const source = join(WORK, 'notes', 'source.md')
  for (const [href, expected] of [
    ['01-索引.md', join(WORK, 'notes', '01-索引.md')],
    ['./中文%20空格.md', join(WORK, 'notes', '中文 空格.md')],
    ['../parent.MD', join(WORK, 'parent.MD')],
    ['child/next.markdown', join(WORK, 'notes', 'child', 'next.markdown')],
    ['hash%23percent%25.md', join(WORK, 'notes', 'hash#percent%.md')],
    [pathToFileURL(join(WORK, '中文 空格.md')).href, join(WORK, '中文 空格.md')],
    [join(WORK, 'absolute.md'), join(WORK, 'absolute.md')],
  ]) check(`resolve ${href}`, () => assert.equal(resolveMarkdownLink(href, source).path, expected))
  check('fragment stays separate', () => assert.equal(resolveMarkdownLink('next.md#中文', source).fragment, '中文'))
  for (const href of ['next.md:147', './中文%20空格.md:147', pathToFileURL(join(WORK, 'next.md')).href + ':147', join(WORK, 'next.md') + ':147']) {
    check(`source line ${href}`, () => {
      const link = resolveMarkdownLink(href, source)
      assert.equal(link.line, 147)
      assert(link.path.endsWith('.md'))
    })
  }
  check('line and heading remain separate', () => {
    const link = resolveMarkdownLink('next.md:147#heading', source)
    assert.equal(link.line, 147); assert.equal(link.fragment, 'heading')
  })
  check('encoded filename colon is not a line suffix', () => assert.equal(resolveMarkdownLink('part%3A147.md', source).line, undefined))
  for (const href of ['next.md:0', 'next.md:9007199254740992', 'next.md:-1', 'next.md:abc']) {
    check(`reject invalid line ${href}`, () => assert.equal(resolveMarkdownLink(href, source), null))
  }
  for (const href of ['#local', 'https://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'run.exe']) {
    check(`reject non-Markdown target ${href}`, () => assert.equal(resolveMarkdownLink(href, source), null))
  }
  check('untitled relative link', () => assert.equal(resolveMarkdownLink('next.md', null), null))
  check('invalid percent encoding', () => assert.throws(() => resolveMarkdownLink('bad%ZZ.md', source)))
  const md = '# **中文 标题**\n\n```md\n# Fake\n```\n\n## Repeat\n\n## Repeat\n\nSetext\n======\n'
  for (const [fragment, expected] of [['%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98', 0], ['fake', null], ['repeat', 6], ['repeat-1', 8], ['setext', 10], ['absent', null]]) {
    check(`heading ${fragment}`, () => assert.equal(headingAnchorLine(md, fragment), expected))
  }
  check('HTML anchors do not pollute the heading slug', () => {
    assert.equal(headingAnchorLine('## 中文标题 <a id="explicit"></a>\n', '中文标题'), 0)
  })
  for (const title of ['follow_person', '**follow_person**', '*follow_person*', '__follow_person__', '_follow_person_', '`follow_person`', 'follow\\_person', '[follow_person](target.md)']) {
    check(`标题下划线保留：${title}`, () => assert.equal(headingAnchorLine(`### ${title}\n`, 'follow_person'), 0))
  }
  check('行内代码中的格式符号属于标题内容', () => {
    assert.equal(headingAnchorLine('### `a_*b*`\n', 'a_b'), 0)
  })
  const distinctHeadings = '### follow_person\n\n### followperson\n\n### follow_person\n\n### **follow_person**\n'
  for (const [fragment, expected] of [['follow_person', 0], ['followperson', 2], ['follow_person-1', 4], ['follow_person-2', 6]]) {
    check(`下划线标题独立编号：${fragment}`, () => assert.equal(headingAnchorLine(distinctHeadings, fragment), expected))
  }
  // Exercise the real tab opener with a failed save, not a copy of its logic.
  const code = readFileSync(join(ROOT, 'src/renderer/main.ts'), 'utf8')
  const start = code.indexOf('async function openFileInNewTabNow(')
  const end = code.indexOf('\n// 文件列表与历史重开', start)
  assert(start >= 0 && end > start, '未找到实际文件打开函数，测试入口需要同步')
  const { code: compiled } = await transform(code.slice(start, end), { loader: 'ts' })
  const current = { filePath: source, dirty: true }
  let opens = 0
  const context = { tabs: [current], activeTab: () => current, captureActiveTab: () => {},
    saveTabForLeaving: async () => false, window: { electronAPI: { navigateToFile: async () => { opens++ } } } }
  vm.runInNewContext(compiled, context)
  await context.openFileInNewTabNow(join(WORK, 'other.md'))
  check('failed save preserves current tab', () => { assert.equal(current.filePath, source); assert.equal(opens, 0) })

  // Verify tableCellStart (supports indented & unbordered tables, #153)
  const editorCode = readFileSync(join(ROOT, 'src/renderer/editor/editor.ts'), 'utf8')
  const tStart = editorCode.indexOf('function tableCellStart(')
  const tEnd = editorCode.indexOf('\n}\n', tStart) + 3
  const { code: compiledTableCell } = await transform(editorCode.slice(tStart, tEnd), { loader: 'ts' })
  const tableContext = {}
  vm.runInNewContext(compiledTableCell, tableContext)
  const { tableCellStart } = tableContext
  check('tableCellStart standard', () => {
    assert.equal(tableCellStart('| A | B |', 0, 0), 1)
    assert.equal(tableCellStart('| A | B |', 0, 1), 5)
  })
  check('tableCellStart indented', () => {
    assert.equal(tableCellStart('  | A | B |', 0, 0), 3)
    assert.equal(tableCellStart('  | A | B |', 0, 1), 7)
  })
  check('tableCellStart unbordered', () => {
    assert.equal(tableCellStart('A | B', 0, 0), 0)
    assert.equal(tableCellStart('A | B', 0, 1), 3)
  })

  // Verify renderCode (strips closing fence without leaking backticks)
  const cleanHtmlCode = readFileSync(join(ROOT, 'src/renderer/editor/clean-html.ts'), 'utf8')
  const rStart = cleanHtmlCode.indexOf('function isCodeFenceStart(')
  const rEnd = cleanHtmlCode.indexOf('\nfunction renderGroup(', rStart)
  const { code: compiledCleanHtml } = await transform(cleanHtmlCode.slice(rStart, rEnd), { loader: 'ts' })
  const cleanContext = { escapeText: (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
  vm.runInNewContext(compiledCleanHtml, cleanContext)
  const { renderCode } = cleanContext
  const mockLine = (text, classes = []) => {
    const set = new Set(classes)
    return { textContent: text, classList: { contains: (c) => set.has(c) } }
  }
  check('renderCode strips fences', () => {
    const res = renderCode([
      mockLine('```js', ['cm-md-codeblock', 'cm-md-codeblock-first']),
      mockLine('const a = 1;', ['cm-md-codeblock']),
      mockLine('```', ['cm-md-codeblock', 'cm-md-codeblock-last']),
    ])
    assert.equal(res, '<pre><code>const a = 1;</code></pre>')
  })
  check('renderCode preserves partial selection', () => {
    const res = renderCode([
      mockLine('const a = 1;', ['cm-md-codeblock']),
      mockLine('const b = 2;', ['cm-md-codeblock']),
    ])
    assert.equal(res, '<pre><code>const a = 1;\nconst b = 2;</code></pre>')
  })

  // 导出使用真实装饰状态，不能把正在编辑的链接源码带进输出。
  const previewBundle = await build({
    stdin: {
      contents: `export { stateExtensions } from './src/renderer/editor/state';
        export { livePreview, livePreviewField, setCleanExport } from './src/renderer/editor/live-preview';
        export { EditorState } from '@codemirror/state';`,
      resolveDir: ROOT,
    },
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  })
  const { stateExtensions, livePreview, livePreviewField, setCleanExport, EditorState } =
    await import('data:text/javascript;base64,' + Buffer.from(previewBundle.outputFiles[0].text).toString('base64'))
  const tableText = '正文\n\n| [表格链接](https://example.com) |\n| --- |\n| 内容 |'
  let state = EditorState.create({ doc: tableText, selection: { anchor: tableText.indexOf('表格链接') }, extensions: [stateExtensions(), livePreview] })
  const tableLinks = () => {
    const hrefs = []
    state.field(livePreviewField).between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.class === 'cm-md-link') hrefs.push(decoration.spec.attributes?.['data-href'])
    })
    return hrefs
  }
  const doc = state.doc, selection = state.selection
  check('表格编辑状态不添加可导航链接装饰', () => assert.deepEqual(tableLinks(), []))
  state = state.update({ effects: setCleanExport.of(true) }).state
  check('干净导出恢复表格链接装饰', () => assert.deepEqual(tableLinks(), ['https://example.com']))
  state = state.update({ effects: setCleanExport.of(false) }).state
  check('导出结束恢复表格链接源码', () => assert.deepEqual(tableLinks(), []))
  check('导出切换不修改文档和选区', () => { assert.equal(state.doc, doc); assert.equal(state.selection, selection) })
  state = state.update({ selection: { anchor: 0 } }).state
  check('光标离开表格后恢复链接装饰', () => assert.deepEqual(tableLinks(), ['https://example.com']))
}

async function connect(port) {
  let page
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && p.url.includes('index.html')) } catch { /* starting */ }
    if (page) break
    await sleep(200)
  }
  assert(page, 'Electron renderer did not start')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await once(ws, 'open')
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data), item = pending.get(msg.id)
    if (!item) return
    pending.delete(msg.id); clearTimeout(item.timer)
    msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timeout: ${method}`)) }, 10000)
    pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}

async function runtimeChecks() {
  const notes = join(WORK, 'notes'), home = join(WORK, 'home'), profile = join(WORK, 'profile')
  for (const dir of [notes, join(notes, 'child'), home, profile]) mkdirSync(dir, { recursive: true })
  const source = join(notes, 'source.md'), target = join(notes, '中文 空格.md'), childFile = join(notes, 'child', 'child.md')
  const lineFile = join(notes, 'lines.md'), largeFile = join(notes, 'large.md')
  const anchorFile = join(notes, 'anchors.md')
  const identifierFile = join(notes, 'heading-identifiers.md')
  const editingFile = join(notes, 'table-editing.md')
  const lineText = ['---', 'title: Lines', '---', ...Array.from({ length: 143 }, (_, i) => `Paragraph ${i}.`), 'LINE_147_TARGET', 'Last line.'].join('\r\n')
  const largeText = [...Array.from({ length: 146 }, () => 'Long wrapped paragraph. '.repeat(180)), 'LARGE_147_TARGET', 'Last line.'].join('\n')
  const targetText = '# Destination\n\n' + 'Paragraph.\n\n'.repeat(100) + '## 目标标题\n\nTail.\n'
  const tableSource = '| [表格网页](https://example.com) | 说明 |\n| --- | --- |\n| [表格链接](中文%20空格.md) | 编辑入口 |\n| [表格文内](#source) | 正文 |\n| [空地址]() | 空地址 |'
  const nestedLinks = [
    '[**加粗文字**](https://example.com/bold)',
    '[`代码文字`](https://example.com/code)',
    '[![图片文字](pixel.png)](https://example.com/image)',
    '[<em>HTML文字</em>](https://example.com/html)',
    '[$x^2$](https://example.com/math)',
    '[==高亮文字==](https://example.com/highlight)',
  ]
  const nestedTableSource = '| 嵌套链接 | 说明 |\n| --- | --- |\n' + nestedLinks.map(link => `| ${link} | 嵌套编辑入口 |`).join('\n')
  const sourceText = '# Source\n\n[相对链接](中文%20空格.md)\n\n[子目录](child/child.md)\n\n[标题](中文%20空格.md#目标标题)\n\n' +
    `[行号](lines.md:147)\n\n[文件行号](${pathToFileURL(lineFile).href}:147)\n\n[源码行号](large.md:147)\n\n[越界行号](lines.md:9999)\n\n` +
    `[File URL](${pathToFileURL(target).href})\n\n[网页](https://example.com)\n\n[缺失](missing.md)\n\n[文内](#source)\n\n[HTML锚点](anchors.md#1-先区分五类对象)\n\n` +
    '| [表格网页](https://example.com) |\n| --- |\n| [表格链接](中文%20空格.md) |\n| [表格文内](#source) |\n| [follow_person](heading-identifiers.md#follow_person) |\n| [空地址]() |\n\n' +
    '<div><a href="中文%20空格.md">HTML块链接</a></div>\n'
  const anchorText = '# Anchors\n\n' +
    '[文内显式](#1-先区分五类对象) · [块内显式](#deep-block) · [标题显式](#heading-explicit) · [未闭合](#unclosed) · [实体](#a%26b) · [外壳同名](#titlebar) · [无目标](#missing-anchor)\n\n' +
    'Paragraph before anchors.\n\n'.repeat(100) +
    '<a id="1-先区分五类对象"></a>ANCHOR_TARGET\n\n' +
    '## HTML_HEADING_TARGET <a id="heading-explicit"></a>\n\n' +
    '<a id="unclosed">\nUNCLOSED_TARGET\n\n' +
    '<a id="a&amp;b">ENTITY_TARGET</a>\n\n' +
    '<a id="titlebar">EDITOR_TITLEBAR_TARGET</a>\n\n' +
    '<div>\n' + '<p>Block paragraph.</p>\n'.repeat(100) +
    '<a id="deep-block">DEEP_BLOCK_TARGET</a>\n</div>\n'
  writeFileSync(source, sourceText); writeFileSync(target, targetText); writeFileSync(childFile, '# Child\n\n[上级](../source.md)\n')
  writeFileSync(lineFile, lineText); writeFileSync(largeFile, largeText); writeFileSync(anchorFile, anchorText)
  writeFileSync(editingFile, '# Edit\n\n' + tableSource + '\n\n' + nestedTableSource + '\n')
  writeFileSync(identifierFile, '# Identifiers\n\n| [文内下划线](#follow_person) |\n| --- |\n\n' + 'Paragraph before identifier.\n\n'.repeat(100) + '### follow_person\n\n' + 'Tail.\n\n'.repeat(30))
  writeFileSync(join(notes, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))
  const before = new Map([source, target, childFile, lineFile, largeFile, anchorFile, editingFile, identifierFile].map(file => [file, { bytes: readFileSync(file), mtime: statSync(file).mtimeMs }]))
  const anchorBundle = await build({ entryPoints: [join(ROOT, 'src/renderer/editor/document-anchor.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'anchorChecks', write: false })
  const themeBundle = await build({ entryPoints: [join(ROOT, 'src/renderer/themes/theme-manager.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'themeChecks', write: false })
  const events = join(WORK, 'events.jsonl'), harness = join(WORK, 'main.cjs')
  const port = 18000 + Math.floor(Math.random() * 2000)
  // Stub only OS browser launching/error dialogs; real IPC, file IO and tab UI run.
  writeFileSync(harness, `const { app, shell, dialog } = require('electron');
    const fs = require('fs');
    app.setPath('home', ${JSON.stringify(home)}); app.setPath('userData', ${JSON.stringify(profile)});
    shell.openExternal = async url => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({external:url})+'\\n');
    dialog.showMessageBox = async (...args) => { fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({error:args.at(-1).message})+'\\n'); return {response:0}; };
    process.argv = [process.execPath, ${JSON.stringify(ROOT)}, ${JSON.stringify(source)}];
    require(${JSON.stringify(join(ROOT, 'scripts/offscreen-window.cjs'))});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(require('electron'), [harness, `--remote-debugging-port=${port}`], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; proc.stdout.on('data', x => { output += x }); proc.stderr.on('data', x => { output += x })
  let client
  try {
    client = await connect(port)
    const { send, evaluate } = client
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await evaluate(anchorBundle.outputFiles[0].text)
    await evaluate(themeBundle.outputFiles[0].text)
    for (const [name, markdown, fragment, expected] of [
      ['double quotes', '<a id="中文"></a>', '%E4%B8%AD%E6%96%87', '中文'],
      ['single quotes', "<a id='single'></a>", 'single', 'single'],
      ['unquoted', '<a id=plain></a>', 'plain', 'plain'],
      ['multiline uppercase', '<A\n ID="multiline"></A>', 'multiline', 'multiline'],
      ['attribute entity', '<a id="a&amp;b"></a>', 'a%26b', 'a&b'],
      ['literal percent', '<a id="a%20b"></a>', 'a%2520b', 'a%20b'],
      ['heading child', '## Text <a id="child"></a>', 'child', 'child'],
      ['code fence', '```html\n<a id="fake"></a>\n```', 'fake', null],
      ['inline code', '`<a id="fake"></a>`', 'fake', null],
      ['comment', '<!-- <a id="fake"></a> -->', 'fake', null],
      ['data-id is not id', '<a data-id="fake"></a>', 'fake', null],
      ['case-sensitive id', '<a id="MixedCase"></a>', 'mixedcase', null],
      ['blocked HTML', '<script><a id="fake"></a></script>', 'fake', null],
      ['frontmatter', '---\nid: <a id="fake"></a>\n---\n\nBody.', 'fake', null],
      ['missing target', '<a id="real"></a>', 'absent', null],
    ]) {
      const found = await evaluate(`anchorChecks.documentAnchor(${JSON.stringify(markdown)}, ${JSON.stringify(fragment)})`)
      check(`HTML resolution: ${name}`, () => assert.equal(found?.id ?? null, expected))
    }
    for (const [name, markdown, fragment, expectedFrom] of [
      ['explicit id precedes heading fallback', '# chosen\n\n<a id="chosen"></a>', 'chosen', 10],
      ['duplicate ids use the first', '<a id="same"></a>\n\n<a id="same"></a>', 'same', 0],
    ]) {
      const found = await evaluate(`anchorChecks.documentAnchor(${JSON.stringify(markdown)}, ${JSON.stringify(fragment)})`)
      check(`HTML resolution: ${name}`, () => assert.equal(found?.from, expectedFrom))
    }
    const wait = async (expression, label) => {
      for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await sleep(100) }
      throw new Error(`Timed out: ${label}`)
    }
    await wait(`document.title==='source.md' && !!document.querySelector('[data-href]')`, 'source loaded')
    const openSource = async () => {
      await evaluate(`window.electronAPI.openExternal(${JSON.stringify(source)})`)
      await wait(`document.title==='source.md'`, 'return to source')
      await sleep(150)
    }
    const click = async (label, modifiers = 0) => {
      // Links outside CM6's viewport have no DOM yet; reveal the link before clicking it.
      await evaluate(`document.querySelector('#editor .cm-scroller').scrollTop=0`)
      await sleep(100)
      let point
      for (let i = 0; i < 40 && !point; i++) {
        point = await evaluate(`(() => {
        const a=[...document.querySelectorAll('#editor [data-href], #editor a[href]')].find(a=>a.textContent===${JSON.stringify(label)});
        if(!a)return null; a.scrollIntoView({block:'center',behavior:'instant'});
        const r=[...a.getClientRects()].find(r=>r.width>2&&r.height>2);
        return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;
      })()`)
        if (!point) {
          await evaluate(`document.querySelector('#editor .cm-scroller').scrollTop+=innerHeight/2`)
          await sleep(50)
        }
      }
      assert(point, `Link not rendered: ${label}`)
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1, modifiers })
    }
    const identifierVisible = `document.title==='heading-identifiers.md' && [...document.querySelectorAll('#editor .cm-line')].some(e=>e.textContent.includes('follow_person')&&e.getBoundingClientRect().top>=document.querySelector('#editor .cm-scroller').getBoundingClientRect().top&&e.getBoundingClientRect().bottom<=document.querySelector('#editor .cm-scroller').getBoundingClientRect().bottom)`
    await click('follow_person')
    await wait(identifierVisible, '表格链接在新标签中定位到屏外下划线标题')
    check('表格链接在新标签中定位到下划线标题', () => {})
    const identifierTabCount = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    await evaluate(`document.querySelector('#editor .cm-scroller').scrollTop=0`)
    await wait(`!(${identifierVisible})`, '已有目标标签先离开下划线标题')
    await openSource(); await click('follow_person')
    await wait(identifierVisible, '表格链接在已有标签中定位到下划线标题')
    const reusedIdentifierTabCount = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    check('下划线锚点复用已有标签', () => assert.equal(reusedIdentifierTabCount, identifierTabCount))
    await click('文内下划线')
    await wait(identifierVisible, '表格文内链接定位到下划线标题')
    check('表格文内链接保留下划线锚点', () => {})
    const toggleRightSidebar = async () => {
      const point = await evaluate(`(() => { const r=document.querySelector('#right-sidebar-toggle').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    const sidebarWasHidden = await evaluate(`document.querySelector('#right-sidebar').hidden`)
    if (sidebarWasHidden) await toggleRightSidebar()
    await wait(`!document.querySelector('#right-sidebar').hidden && [...document.querySelectorAll('#right-sidebar .outline-list button')].some(e=>e.textContent==='follow_person')`, '右侧大纲保留标题下划线')
    check('右侧大纲显示 follow_person', () => {})
    await evaluate(`document.querySelector('#editor .cm-scroller').scrollTop=0`)
    await sleep(100)
    const outlinePoint = await evaluate(`(() => { const button=[...document.querySelectorAll('#right-sidebar .outline-list button')].find(e=>e.textContent==='follow_person'); const r=button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...outlinePoint, button: 'left', clickCount: 1 })
    await wait(identifierVisible, '点击大纲定位到下划线标题')
    check('点击大纲定位到 follow_person', () => {})
    if (sidebarWasHidden) {
      await toggleRightSidebar()
      await wait(`document.querySelector('#right-sidebar').hidden`, '恢复右侧栏显隐')
    }
    await openSource()
    await click('标题')
    await wait(`document.title==='中文 空格.md' && [...document.querySelectorAll('.cm-line')].some(e=>e.textContent.includes('目标标题')&&e.getBoundingClientRect().y>=0&&e.getBoundingClientRect().bottom<innerHeight)`, 'heading in a newly opened document')
    check('plain click opens a new file at an offscreen heading', () => {})
    await openSource(); await click('相对链接')
    await wait(`document.title==='中文 空格.md'`, 'plain click local link')
    check('plain click opens a Chinese/space filename', () => {})
    const count = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    await openSource(); await click('相对链接', MOD)
    await wait(`document.title==='中文 空格.md'`, 'modifier click existing link')
    const nextCount = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    check('modifier click still reuses an existing tab', () => assert.equal(nextCount, count))
    await openSource(); await click('子目录')
    await wait(`document.title==='child.md'`, 'child')
    await click('上级'); await wait(`document.title==='source.md'`, 'parent')
    check('child and parent directories', () => {})
    await click('标题')
    await wait(`document.title==='中文 空格.md' && [...document.querySelectorAll('.cm-line')].some(e=>e.textContent.includes('目标标题')&&e.getBoundingClientRect().y>=0&&e.getBoundingClientRect().bottom<innerHeight)`, 'offscreen heading')
    check('cross-file heading outside the initial viewport', () => {})
    await openSource(); await click('File URL'); await wait(`document.title==='中文 空格.md'`, 'file URL')
    check('file URL', () => {})
    for (const label of ['行号', '文件行号']) {
      await openSource(); await click(label)
      await wait(`document.title==='lines.md' && document.querySelector('.cm-md-jump-flash')?.textContent==='LINE_147_TARGET'`, label)
      check(`${label}: exact line with CRLF and frontmatter`, () => {})
    }
    await openSource(); await click('越界行号')
    await wait(`document.title==='lines.md' && document.querySelector('.cm-md-jump-flash')?.textContent==='Last line.'`, 'line past EOF')
    check('line past EOF clamps to last line', () => {})
    await openSource(); await click('源码行号')
    await wait(`(() => { const s=document.querySelector('#source-editor'); return document.title==='large.md' && s.classList.contains('visible') && s.value.slice(s.selectionStart,s.selectionEnd)==='LARGE_147_TARGET' && s.scrollTop>0; })()`, 'source mode line')
    check('large source document selects line after wrapped paragraphs', () => {})
    await openSource(); await click('网页'); await sleep(150)
    check('web link still uses the OS browser', () => assert.match(readFileSync(events, 'utf8'), /"external":"https:\/\/example.com"/))
    await openSource(); await click('缺失'); await sleep(200)
    check('missing file reports an error', () => assert.match(readFileSync(events, 'utf8'), /"error":/))
    assert.equal(await evaluate('document.title'), 'source.md')
    await openSource(); await click('文内', 0)
    await wait(`!!document.querySelector('.cm-md-jump-flash')`, 'in-document heading')
    check('in-document anchor', () => {})
    await openSource(); await click('表格文内')
    await wait(`document.querySelector('.cm-md-jump-flash')?.textContent.includes('Source')`, 'plain click table anchor')
    check('plain click a table anchor jumps within the document', () => {})
    const visibleText = text => `(() => {
      const walker=document.createTreeWalker(document.querySelector('#editor .cm-content'), NodeFilter.SHOW_TEXT);
      let n; while(n=walker.nextNode()) { if(n.textContent.includes(${JSON.stringify(text)}))break; }
      if(!n)return false; const r=n.parentElement.getBoundingClientRect(), s=document.querySelector('#editor .cm-scroller').getBoundingClientRect();
      return r.bottom>s.top && r.top<s.bottom;
    })()`
    await openSource(); await click('HTML锚点')
    await wait(`document.title==='anchors.md' && ${visibleText('ANCHOR_TARGET')}`, 'cross-file explicit anchor in a new tab')
    check('plain click opens a file at an offscreen HTML anchor', () => {})
    const anchorTabCount = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    await openSource(); await click('HTML锚点')
    await wait(`document.title==='anchors.md' && ${visibleText('ANCHOR_TARGET')}`, 'cross-file explicit anchor in an existing tab')
    const reusedAnchorTabCount = await evaluate(`document.querySelectorAll('.tab-entry').length`)
    check('cross-file HTML navigation reuses its tab', () => assert.equal(reusedAnchorTabCount, anchorTabCount))
    for (const [label, text] of [
      ['文内显式', 'ANCHOR_TARGET'], ['标题显式', 'HTML_HEADING_TARGET'], ['未闭合', 'UNCLOSED_TARGET'],
      ['实体', 'ENTITY_TARGET'], ['外壳同名', 'EDITOR_TITLEBAR_TARGET'], ['块内显式', 'DEEP_BLOCK_TARGET'],
    ]) {
      await click(label)
      await wait(visibleText(text), `HTML target visible: ${label}`)
      const sourceVisible = await evaluate(`!![...document.querySelectorAll('#editor .cm-line')].find(e=>e.textContent.includes('<a id='))`)
      check(`HTML navigation stays rendered: ${label}`, () => assert.equal(sourceVisible, false))
    }
    await click('无目标')
    const noTargetScroll = await evaluate(`document.querySelector('#editor .cm-scroller').scrollTop`)
    await sleep(200)
    const settledNoTargetScroll = await evaluate(`document.querySelector('#editor .cm-scroller').scrollTop`)
    check('missing anchor keeps the link location', () => assert.equal(settledNoTargetScroll, noTargetScroll))
    for (const theme of ['light', 'dark']) {
      await evaluate(`themeChecks.applyTheme(${JSON.stringify(theme)})`)
      await wait(`document.body.classList.contains('theme-${theme}')`, `${theme} theme applied`)
      await openSource()
      await wait(`!!document.querySelector('.cm-md-table-widget')`, `${theme}: table rendered`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
      const tableStyles = await evaluate(`(() => {
        const table = document.querySelector('.cm-md-table-widget');
        const probe = document.createElement('span');
        probe.style.color = 'var(--link-color)'; table.appendChild(probe);
        const linkColor = getComputedStyle(probe).color; probe.remove();
        return [...table.querySelectorAll('a')].map(a => {
          const style = getComputedStyle(a);
          return { label: a.textContent, active: a.hasAttribute('data-href'),
            underline: style.textDecorationLine.includes('underline'), color: style.color,
            cursor: style.cursor, hovered: a.matches(':hover'), linkColor };
        });
      })()`)
      check(`${theme}: 表头和正文中的三类链接均已渲染`, () => {
        assert.deepEqual(tableStyles.filter(a => a.active).map(a => a.label), ['表格网页', '表格链接', '表格文内', 'follow_person'])
      })
      for (const style of tableStyles) {
        check(`${theme}: ${style.label}默认展示正确`, () => {
          assert.equal(style.hovered, false)
          assert.equal(style.underline, style.active)
          if (style.active) {
            assert.equal(style.color, style.linkColor)
            assert.equal(style.cursor, 'pointer')
          } else {
            assert.notEqual(style.cursor, 'pointer')
          }
        })
      }
      await evaluate(`window.electronAPI.openExternal(${JSON.stringify(editingFile)})`)
      await wait(`document.title==='table-editing.md' && document.querySelectorAll('.cm-md-table-widget').length===2`, `${theme}: editing fixture loaded`)
      for (const [entry, rawSource] of [['编辑入口', tableSource], ['嵌套编辑入口', nestedTableSource]]) {
        const point = await evaluate(`(() => {
          const cell = [...document.querySelectorAll('.cm-md-table-widget td')].find(e => e.textContent === ${JSON.stringify(entry)});
          cell.scrollIntoView({block:'center',behavior:'instant'});
          const r = cell.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
        })()`)
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
        await wait(`!!document.querySelector('#editor .cm-md-table')`, `${theme}: ${entry} enters source editing`)
        const editing = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('#editor .cm-md-table')];
          return {text:rows.map(e=>e.textContent).join('\\n'), links:rows.flatMap(e=>[...e.querySelectorAll('a[href],[data-href],.cm-md-link')]).length,
            widgets:rows.flatMap(e=>[...e.querySelectorAll('.cm-md-image,.cm-md-html,.cm-md-math')]).length,
            rendered:document.querySelectorAll('.cm-md-table-widget').length};
        })()`)
        check(`${theme}: ${entry}完整显示表格链接源码`, () => assert.equal(editing.text, rawSource))
        check(`${theme}: ${entry}源码没有导航入口，其他表格继续渲染`, () => {
          assert.equal(editing.links, 0); assert.equal(editing.widgets, 0); assert.equal(editing.rendered, 1)
        })
        const eventsBefore = readFileSync(events, 'utf8')
        const rawLinkPoint = await evaluate(`(() => {
          const row = [...document.querySelectorAll('#editor .cm-md-table')].find(e=>e.textContent.includes('https://example.com'));
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          let node; while(node=walker.nextNode()) {
            const at=node.textContent.indexOf('https://'); if(at<0)continue;
            const range=document.createRange(); range.setStart(node,at); range.setEnd(node,at+5);
            row.scrollIntoView({block:'center',behavior:'instant'});
            const r=range.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
          }
        })()`)
        assert(rawLinkPoint, '未找到可点击的链接地址源码')
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...rawLinkPoint, button: 'left', clickCount: 1 })
        await sleep(150)
        const selection = await evaluate(`(() => {
          const node=window.getSelection()?.anchorNode;
          const element=node?.nodeType===Node.ELEMENT_NODE ? node : node?.parentElement;
          return {title:document.title, inTable:!!element?.closest('.cm-md-table')};
        })()`)
        check(`${theme}: ${entry}点击源码地址只放光标`, () => {
          assert.equal(readFileSync(events, 'utf8'), eventsBefore)
          assert.equal(selection.title, 'table-editing.md'); assert.equal(selection.inTable, true)
        })
        const headingPoint = await evaluate(`(() => {
          const heading=[...document.querySelectorAll('#editor .cm-line')].find(e=>e.textContent==='Edit');
          heading.scrollIntoView({block:'center',behavior:'instant'});
          const r=heading.getBoundingClientRect(); return {x:r.x+10,y:r.y+r.height/2};
        })()`)
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...headingPoint, button: 'left', clickCount: 1 })
        await wait(`document.querySelectorAll('.cm-md-table-widget').length===2 && !document.querySelector('#editor .cm-md-table')`, `${theme}: ${entry} returns to rendering`)
        check(`${theme}: ${entry}点走恢复表格链接`, () => {})
      }
      await openSource()
      for (const [label, selector] of [['表格链接', '.cm-md-table-widget'], ['HTML块链接', '.cm-md-html a[href]']]) {
        await openSource(); await click(label)
        await wait(`document.title==='中文 空格.md'`, `${theme}: plain click ${label}`)
        await openSource()
        await wait(`[...document.querySelectorAll('#editor ${selector}')].some(e=>e.textContent.includes(${JSON.stringify(label)}))`, `${theme}: ${label} stays rendered`)
        check(`${theme}: plain click ${label} opens its file without source editing`, () => {})
      }
      const externalCount = readFileSync(events, 'utf8').split('\n').filter(line=>line.includes('"external":')).length
      await click('表格网页'); await sleep(150)
      const nextExternalCount = readFileSync(events, 'utf8').split('\n').filter(line=>line.includes('"external":')).length
      check(`${theme}: 单击表格网页链接调用浏览器`, () => assert.equal(nextExternalCount, externalCount + 1))
      await click('表格文内')
      await wait(`document.querySelector('.cm-md-jump-flash')?.textContent.includes('Source')`, `${theme}: table anchor`)
      check(`${theme}: 单击表格文内链接跳转到标题`, () => {})
      await click('HTML锚点')
      await wait(`document.title==='anchors.md' && ${visibleText('ANCHOR_TARGET')}`, `${theme}: cross-file HTML anchor`)
      for (const [label, text] of [['标题显式', 'HTML_HEADING_TARGET'], ['块内显式', 'DEEP_BLOCK_TARGET']]) {
        await click(label)
        await wait(visibleText(text), `${theme}: ${label} visible`)
        const sourceVisible = await evaluate(`!![...document.querySelectorAll('#editor .cm-line')].find(e=>e.textContent.includes('<a id='))`)
        check(`${theme}: ${label} stays rendered`, () => assert.equal(sourceVisible, false))
      }
    }
    for (const [file, old] of before) check(`navigation preserves ${fileURLToPath(pathToFileURL(file)).split(/[\\/]/).pop()}`, () => {
      assert.deepEqual(readFileSync(file), old.bytes); assert.equal(statSync(file).mtimeMs, old.mtime)
    })
    await evaluate('window.close()')
  } catch (error) {
    if (client) console.error(await client.evaluate(`JSON.stringify({title:document.title,tabs:[...document.querySelectorAll('.tab-entry')].map(x=>x.textContent)})`))
    if (client) console.error(await client.evaluate(`JSON.stringify({scroll:document.querySelector('#editor .cm-scroller')?.scrollTop,html:[...document.querySelectorAll('#editor .cm-md-html')].map(e=>({from:e.dataset.sourceFrom,to:e.dataset.sourceTo,top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height,ids:[...e.querySelectorAll('[id]')].map(a=>({id:a.id,top:a.getBoundingClientRect().top}))}))})`))
    console.error(output.slice(-2000)); throw error
  } finally {
    client?.close()
    if (proc.exitCode === null) {
      proc.kill()
      await Promise.race([once(proc, 'exit'), sleep(5000)])
    }
  }
}

try {
  await unitChecks()
  if (!process.argv.includes('--unit')) await runtimeChecks()
  console.log(`\n${passed} checks passed`)
} finally {
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
