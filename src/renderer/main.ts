import { createEditor, focusEditor, getMarkdown, getEditorView, getEditorScroller, onEditorJumpPhase, setMarkdown, setEditorEditable, getEditorState, restoreEditorState, applyMarkdownStyle, runFormatCommand, jumpToLine, jumpToHeading, setCleanExport, setDocumentFileUrl, setEditorHideBlankLines, type FormatCommandId } from './editor/editor'
import { markdownForWord } from './editor/mermaid-export'
import { withDiagramZoomPaused } from './editor/mermaid-bridge'
import { jumpToSourceLine, sourcePositionTop } from './editor/source-line'
import { EditorView } from '@codemirror/view'
import { documentHTMLFrom } from './editor/clean-html'
import { isPresenting, startSlideshow, stopSlideshow } from './slideshow'
import { enterPrintLayout, exitPrintLayout } from './slides-export'
import { enterPaperLayout, exitPaperLayout } from './print-layout'
import { SearchPanel } from './editor/search-panel'
import { applyTheme, loadSavedTheme, getCurrentThemeDefinition, getThemeDefinitions, setThemeDefinitions, registerThemeDefinition } from './themes/theme-manager'
import { showThemeSettingsPanel } from './themes/theme-settings-panel'
import type { ThemeDefinition } from '../shared/theme-config'
import { setUiLanguage, isChinese, type UiLanguage } from './ui-language'
import { Sidebars } from './sidebars'
import { DocumentOutline, sameOutlineLabels, type OutlineItem } from './document-outline'
import { FilePanelModel } from './file-panel-model'
import { FilePanelView } from './file-panel-view'
import { DocumentFileContent } from './document-file-content'
import { DocumentStatisticsScheduler } from './document-statistics-scheduler'
import statisticsLabels from '../shared/document-statistics-labels.json'
import appConfig from '../shared/app-config.json'
import { EditorNavigation } from './editor-navigation'
import { prepareDocumentsForClose } from './document-close'
import type { NavigationAnchor } from './navigation-history'
import type { SidebarSide } from '../shared/sidebar-config'
import { applyEditorFont, clearEditorFont, loadSavedEditorFont, resetEditorFontSize, showFontSettingsModal, stepEditorFontSize } from './editor/font-settings'
import './themes/base.css'
import './themes/editor-preview.css'
import './themes/document.css'
import './themes/theme-settings.css'

let sourceModeActive = false
const editorEl = () => document.getElementById('editor') as HTMLElement
// 正文的滚动在 .cm-scroller 上，不在 #editor 上；见 editor.ts 的 getEditorScroller。
const editorScroller = () => getEditorScroller() ?? editorEl()
const sourceEl = () => document.getElementById('source-editor') as HTMLTextAreaElement
const fileListEls = () => Array.from(document.querySelectorAll<HTMLElement>('.file-list'))
const outlineListEls = () => Array.from(document.querySelectorAll<HTMLElement>('.sidebar[data-content="outline"][aria-hidden="false"] .outline-list'))
const sidebars = new Sidebars(side => {
  renderOutline(side)
  scheduleFileListRender()
})
const sourceToggleBtnEl = () => document.getElementById('source-toggle-btn') as HTMLButtonElement
const wordCountEl = () => document.getElementById('word-count') as HTMLElement
const saveStatusEl = () => document.getElementById('save-status') as HTMLElement
const updateBannerEl = () => document.getElementById('update-banner') as HTMLElement
const updateBannerTextEl = () => document.getElementById('update-banner-text') as HTMLElement
const updateBannerActionEl = () => document.getElementById('update-banner-action') as HTMLButtonElement

// --- Same-directory file panel ---
let currentFilePath: string | null = null
// 当前文档的 file:// URL：图片的相对路径按它解析（文件里存的那串路径不动）。
let currentFileUrl: string | null = null
let fileManagerName: import('../preload/index').FileManagerName = 'file-manager'
let dirty = false
// The active document's YAML frontmatter. It is carried here instead of inside
// the editor: the rich text parser would rewrite it on the way back out, and it
// belongs in the file exactly as it was written (issue #109).
let activeFrontmatter = ''
// The line ending the file on disk uses. The editor hands back `\n` whatever the
// file was written with, and rewriting a Windows file from top to bottom on the
// next save is a change nobody asked for.
let activeLineEnding = '\n'
// Programmatic Markdown replacement dispatches a synchronous ProseMirror
// transaction. Suppress only that transaction, never a time window of input.
let applyingProgrammaticChange = false
// The editor emits updates while it is being built: the initial document plus
// the trailing paragraph it inserts. Those are not user edits, so a document
// must not start out dirty, or closing an untouched new window would ask to
// save it.
let editorReady = false
let outlineUpdateQueued = false
// Outline doubles as a reading-progress view (#64): the entry for the section
// currently at the top of the viewport is highlighted and kept visible.
// 标题位置与按钮显示分开：正文换行只更新位置，不销毁现有按钮。
const documentOutline = new DocumentOutline()
const outlineLabelsByList = new WeakMap<HTMLElement, readonly OutlineItem[]>()
let outlineItems: readonly OutlineItem[] = []
let outlineRevealQueued = false
let outlineActiveIndex = -1
let outlineSyncQueued = false
// While an outline click drives a smooth scroll, scrollspy updates are paused
// so the in-flight scroll events cannot overwrite the clicked entry; the lock
// is released on `scrollend` or by a fallback timer when no scroll happens.
let outlineJumping = false
let outlineJumpTimer: ReturnType<typeof setTimeout> | null = null
let outlineJumpStartTop = 0

// The reading column's width, three fixed steps chosen from the View menu. The
// preference is a body class rather than an inline style, so the same class
// travels inside the export snapshot and an exported image keeps the column the
// author was reading. `standard` needs no class: it is what body already carries.
const PAGE_WIDTH_KEY = 'colamd-page-width'

const PAGE_WIDTH_CLASSES: Record<string, string> = {
  narrow: 'page-width-narrow',
  standard: '',
  wide: 'page-width-wide'
}

function applyPageWidth(width: string): void {
  const next = width in PAGE_WIDTH_CLASSES ? width : 'standard'
  for (const className of Object.values(PAGE_WIDTH_CLASSES)) {
    if (className) document.body.classList.toggle(className, className === PAGE_WIDTH_CLASSES[next])
  }
  localStorage.setItem(PAGE_WIDTH_KEY, next)
  window.electronAPI?.reportPageWidth?.(next)
}

applyPageWidth(localStorage.getItem(PAGE_WIDTH_KEY) ?? 'standard')

const WIDE_MEDIA_KEY = 'colamd-wide-media'

// 只切换样式，不派发文档事务，偏好也不随标签页快照恢复。
function applyWideMedia(enabled: boolean): void {
  document.body.classList.toggle('wide-media', enabled)
  localStorage.setItem(WIDE_MEDIA_KEY, enabled ? '1' : '0')
  void window.electronAPI.reportWideMedia(enabled)
  getEditorView()?.requestMeasure()
}

applyWideMedia(localStorage.getItem(WIDE_MEDIA_KEY) === '1')

const HIDE_BLANK_LINES_KEY = 'colamd-hide-blank-lines'
// 偏好属于应用视图，不随某个标签页的 EditorState 快照恢复。
let hideBlankLines = localStorage.getItem(HIDE_BLANK_LINES_KEY) === '1'

// 开关只派发显示效果，不更新正文、不设置 dirty、不调度保存。
function applyHideBlankLines(enabled: boolean): void {
  hideBlankLines = enabled
  localStorage.setItem(HIDE_BLANK_LINES_KEY, enabled ? '1' : '0')
  setEditorHideBlankLines(enabled)
  void window.electronAPI.reportHideBlankLines(enabled)
}

window.addEventListener('storage', (event) => {
  if (event.key === HIDE_BLANK_LINES_KEY) applyHideBlankLines(event.newValue === '1')
  if (event.key === WIDE_MEDIA_KEY) applyWideMedia(event.newValue === '1')
})

function setMarkdownProgrammatically(content: string, flushHistory = false): void {
  // Every way a document can be replaced at once ends up here (open, external
  // write, new file). The deck's pages are positions in the document that is
  // going away, so the presentation has to end with it.
  if (isPresenting()) stopSlideshow()
  applyingProgrammaticChange = true
  try {
    setMarkdown(content, flushHistory, { fileUrl: currentFileUrl, hideBlankLines })
  } finally {
    applyingProgrammaticChange = false
  }
}

// --- Unsaved-state tracking + auto-save ---
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let documentRevision = 0
let saveQueue: Promise<void> = Promise.resolve()

function reportDirty(): void {
  window.electronAPI.reportDirty(dirty || tabs.some(tab => tab.id !== activeTabId && tab.dirty))
}

// --- Save status hint (#49) ---
let saveStatusTimer: ReturnType<typeof setTimeout> | null = null
// True while an external-modification conflict waits for the user's choice;
// autosave stays paused so it cannot silently overwrite the external edit.
let externalConflictPending = false

function showSaveStatus(state: 'dirty' | 'saved'): void {
  const el = saveStatusEl()
  if (!el) return
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  // The dirty hint is gone: the active tab shows a dot for it, and a label in
  // the row was one signal too many. The element stays for the messages that
  // need words, such as an external edit waiting on the user's choice.
  if (state === 'dirty') {
    el.classList.remove('pending')
    el.textContent = ''
  } else {
    el.classList.remove('pending')
    saveStatusTimer = setTimeout(() => {
      el.textContent = ''
    }, 600)
  }
}

function clearSaveStatus(): void {
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  const el = saveStatusEl()
  if (el) {
    el.classList.remove('pending', 'saved')
    el.textContent = ''
    // The slot is plain text by default (pointer-events: none in the markup);
    // the recovery hint is the one message that can be clicked.
    el.removeAttribute('title')
    el.style.pointerEvents = ''
    el.style.cursor = ''
    el.onclick = null
  }
}

// After the disk version is loaded, the dropped version still exists in
// ~/.evermd/recovered. Saying so is the entire point of keeping it, so the hint
// takes the save-status slot for a while and opens the folder when clicked.
function showRecoveryHint(recoveryPath: string): void {
  const el = saveStatusEl()
  if (!el) return
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  el.classList.remove('pending', 'saved')
  el.textContent = isChinese() ? '未保存的内容已存成恢复文件' : 'Unsaved version kept as a recovery file'
  el.title = isChinese() ? '点击在 Finder 中显示' : 'Click to show in the file manager'
  el.style.pointerEvents = 'auto'
  el.style.cursor = 'pointer'
  el.onclick = () => {
    void window.electronAPI?.revealPath?.(recoveryPath)
  }
  saveStatusTimer = setTimeout(() => clearSaveStatus(), 12000)
}

// An external edit landing while the user still has unsaved changes must never
// clobber the editor, and plain autosave would silently overwrite the external
// edit. Pause autosave and let the user choose explicitly.
function raiseExternalConflict(): void {
  if (externalConflictPending) return
  externalConflictPending = true
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  const el = saveStatusEl()
  if (el) {
    if (saveStatusTimer) {
      clearTimeout(saveStatusTimer)
      saveStatusTimer = null
    }
    el.textContent = isChinese() ? '文件已被外部修改' : 'File changed externally'
    el.classList.remove('saved')
    el.classList.add('pending')
  }
  window.electronAPI.reportExternalConflict?.(getFileContent())
}

// --- Tabs (design.md) ---
// Tabs are created by the user (the + button or ⌘T) and never appear on their own.
// The module-level document state above always describes the ACTIVE tab, so every
// existing path (save, autosave, external conflict, outline, source mode) keeps
// working unchanged. Background tabs keep a snapshot of their own state, which
// makes switching a capture/restore pair instead of a second document machine.
interface DocumentTab {
  id: string
  filePath: string | null
  dirty: boolean
  revision: number
  sourceMode: boolean
  sourceText: string
  content: string
  frontmatter: string
  lineEnding: string
  editorState: import('@codemirror/state').EditorState | null
  diskContent: string | null
  scrollTop: number
  scrollSnapshot: ReturnType<EditorView['scrollSnapshot']> | null
}

const tabs: DocumentTab[] = []
let activeTabId: string | null = null
let nextTabId = 1
let switchingTab = false
// 所有文档切换与整次历史回放共用队列，保存和定位不会交叉落到其他文件。
let documentOperationQueue: Promise<void> = Promise.resolve()
// 等待切换期间的控件事件不属于用户在文档内停留的位置。
let documentOperationActive = false
// 关窗确认期间暂停自动保存，批准后保持队列与输入锁定到窗口关闭或退出取消。
let windowClosePreparing = false
let releaseWindowClose: (() => void) | null = null
// 退出被取消后重新读磁盘，不能把确认期间的外部更新当成已经显示过。
const changesDuringClose = new Set<string>()
// 编辑器与首个标签就绪后创建；启动时的文件事件仍可沿用原加载流程。
let navigation: EditorNavigation | null = null

// 串行完成一次文档操作，失败后仍允许后续操作继续。
function enqueueDocumentOperation<T>(operation: () => Promise<T>, record = true, recordJump = false): Promise<T> {
  const result = documentOperationQueue.then(async () => {
    if (record) navigation?.beforeSwitch()
    // 等待保存或读取时不能继续写入即将离开的缓冲区，否则新输入可能在切换时遗失。
    const sourceReadOnly = sourceEl().readOnly
    documentOperationActive = true
    sourceEl().readOnly = true
    setEditorEditable(false)
    try {
      return await operation()
    } finally {
      sourceEl().readOnly = sourceReadOnly
      setEditorEditable(!isPresenting())
      documentOperationActive = false
      if (record) navigation?.afterSwitch(recordJump)
      // 只读期间恢复选区不能获得可编辑焦点；等装饰与 contenteditable 更新后再聚焦。
      if (!isPresenting()) {
        if (sourceModeActive) sourceEl().focus({ preventScroll: true })
        else {
          const view = getEditorView()
          const doc = view?.state.doc
          const tabId = activeTabId
          view?.requestMeasure({
            key: enqueueDocumentOperation,
            read: () => null,
            write: () => queueMicrotask(() => {
              if (!sourceModeActive && activeTabId === tabId && view.state.doc === doc) view.focus()
            }),
          })
        }
      }
    }
  })
  documentOperationQueue = result.then(() => undefined, (error) => { console.error('文档切换失败', error) })
  return result
}

// 公开入口负责排队，内部组合操作调用 Now 版本，避免等待自己。
function openNewTab(): Promise<void> {
  return enqueueDocumentOperation(openNewTabNow)
}

// 标签身份始终与文件身份一同核对。
function activateTab(id: string): Promise<'ok' | 'missing' | 'cancelled'> {
  return enqueueDocumentOperation(() => activateTabNow(id))
}

// 关闭与前进后退共享切换边界。
function closeTab(id: string): Promise<void> {
  return enqueueDocumentOperation(() => closeTabNow(id))
}

// 显式打开与文件列表浏览保持各自的标签约定。
function openFileInNewTab(path: string): Promise<void> {
  return enqueueDocumentOperation(() => openFileInNewTabNow(path))
}

// 批量关闭也作为一次文档操作，取消后不继续关闭。
function closeTabsMatching(keep: (index: number) => boolean): Promise<void> {
  return enqueueDocumentOperation(() => closeTabsMatchingNow(keep))
}

const tabBarEl = () => document.getElementById('tab-bar') as HTMLElement

function activeTab(): DocumentTab | null {
  return tabs.find((tab) => tab.id === activeTabId) ?? null
}

// The label for a document that has no path yet, in the current UI language.
let untitledName = 'Untitled'

function untitledLabel(): string {
  return untitledName
}

// The tab carries the document's name, not its file name. `.md` on every tab is
// noise in a strip that hugs its label, and it lands right where the ellipsis
// cuts — `解读.…` reads as four dots. Mirrors the panel's markdown filter.
const DOCUMENT_SUFFIX = /\.(md|markdown|mdown|mkd)$/i

function tabLabel(tab: DocumentTab): string {
  if (!tab.filePath) return untitledLabel()
  const name = tab.filePath.split(/[\\/]/).pop() || tab.filePath
  return name.replace(DOCUMENT_SUFFIX, '')
}

// Read the live state back into the active tab's record. Called before every
// switch, close and bar render, so the records and the screen cannot disagree.
function captureActiveTab(): void {
  const tab = activeTab()
  if (!tab) return
  // The path is the tab's identity and only changes where a document is really
  // opened or saved; deriving it here would let a stray render rename a tab.
  tab.dirty = dirty
  tab.revision = documentRevision
  tab.sourceMode = sourceModeActive
  tab.frontmatter = activeFrontmatter
  tab.lineEnding = activeLineEnding
  tab.content = getFileContent()
  if (sourceModeActive) {
    tab.sourceText = sourceEl().value
    tab.scrollTop = sourceEl().scrollTop
  } else {
    tab.editorState = getEditorState()
    tab.scrollTop = editorScroller().scrollTop
    tab.scrollSnapshot = getEditorView()?.scrollSnapshot() ?? null
  }
}

// The bar only carries the unsaved mark that the tab already owns; the title bar
// keeps the primary save hint.
function markActiveTabDirty(): void {
  const tab = activeTab()
  if (!tab) return
  tab.dirty = dirty
  const entry = tabBarEl().querySelector(`.tab-entry[data-tab-id="${tab.id}"]`)
  entry?.classList.toggle('dirty', dirty)
}

// --- The floating label ---
// ONE fixed layer for every name the shell has to shorten: a tab (where it also
// carries ⌘W) and a file-panel row. Neither the strip nor the panel can host it
// — both clip their own overflow — so the renderer positions it.
// A tab waits longer: hovering a tab is usually a prelude to clicking it, and a
// label that jumps out immediately is noise. A row is different — the name is
// what was asked for, so it answers sooner.
const TAB_TIP_DELAY = 1000
const ROW_TIP_DELAY = 450

let tipTimer: ReturnType<typeof setTimeout> | undefined

function showTip(anchor: HTMLElement, text: string, side: 'below' | 'left' | 'right'): void {
  const tip = document.getElementById('hover-tip') as HTMLElement | null
  if (!tip) return
  tip.textContent = text
  tip.hidden = false
  const rect = anchor.getBoundingClientRect()
  const width = tip.offsetWidth
  if (side !== 'below') {
    // Beside the panel and level with the row: the label describes the list, so
    // it must not cover it.
    const height = tip.offsetHeight
    const left = side === 'right' ? rect.right + 8 : rect.left - width - 8
    tip.style.left = `${Math.round(Math.max(8, Math.min(left, window.innerWidth - width - 8)))}px`
    tip.style.top = `${Math.round(Math.min(Math.max(8, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 8))}px`
    return
  }
  tip.style.left = `${Math.round(Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8))}px`
  tip.style.top = `${Math.round(rect.bottom + 7)}px`
}

function scheduleTip(anchor: HTMLElement, text: string, side: 'below' | 'left' | 'right', delay: number): void {
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => showTip(anchor, text, side), delay)
}

function hideTip(): void {
  clearTimeout(tipTimer)
  const tip = document.getElementById('hover-tip') as HTMLElement | null
  if (tip) tip.hidden = true
}

// A tab whose name fits says nothing but the shortcut; only a truncated name is
// worth spelling out. The full path never appears on hover: it was the system
// tooltip, and it reads as an accident.
function tabTipText(entry: HTMLElement): string {
  const shortcut = '⌘W'
  const name = entry.querySelector('.tab-entry-name') as HTMLElement | null
  const full = entry.dataset.fullName ?? ''
  if (!name || !full) return shortcut
  return name.scrollWidth > name.clientWidth + 1 ? `${full} · ${shortcut}` : shortcut
}

function hideTabTip(): void {
  hideTip()
}
function closeGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '9')
  svg.setAttribute('height', '9')
  svg.setAttribute('viewBox', '0 0 9 9')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  for (const [x1, y1, x2, y2] of [['1.6', '1.6', '7.4', '7.4'], ['7.4', '1.6', '1.6', '7.4']]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2)
    svg.append(line)
  }
  return svg
}

// Same plus as the title bar button, at the tab strip's scale.

// The plus at the strip's scale, same shape as the icons in the title bar.
function plusGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  for (const [x1, y1, x2, y2] of [['8', '3.1', '8', '12.9'], ['3.1', '8', '12.9', '8']]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2)
    svg.append(line)
  }
  return svg
}

function renderTabBar(): void {
  captureActiveTab()
  const bar = tabBarEl()
  // The strip is always there: with the layout collapsed into the title bar's
  // row it costs no extra height, and one shape for the chrome beats a title bar
  // that changes personality when a second document appears.
  bar.hidden = false
  // The strip lives inside the title bar's row now, so it consumes no height of
  // its own: the editor starts right under the same 40px row either way.
  document.documentElement.style.setProperty('--tab-bar-height', '0px')
  document.documentElement.style.setProperty('--editor-top-gap', '0px')
  bar.innerHTML = ''
  // Hide the hover hint unconditionally, including the path where the whole
  // strip disappears (one tab left): a pending timer would otherwise pop "⌘W"
  // for a tab that no longer exists, and a visible hint would never leave —
  // the strip it belongs to is gone, so no mouseleave can fire (#90).
  hideTabTip()
  for (const tab of tabs) {
    const entry = document.createElement('div')
    entry.className = 'tab-entry'
    entry.dataset.tabId = tab.id
    entry.setAttribute('role', 'tab')
    entry.dataset.fullName = tabLabel(tab)
    if (tab.id === activeTabId) {
      entry.classList.add('active')
      entry.setAttribute('aria-selected', 'true')
    }
    if (tab.dirty) entry.classList.add('dirty')
    const name = document.createElement('span')
    name.className = 'tab-entry-name'
    name.textContent = tabLabel(tab)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tab-entry-close'
    close.setAttribute('aria-label', isChinese() ? '关闭标签页' : 'Close tab')
    close.append(closeGlyph())
    entry.append(name, close)
    bar.append(entry)
  }
  // The plus sits right after the strip, not inside it: inside, a full row of
  // tabs scrolled it out of sight exactly when it was needed. It is one of the
  // row's icon controls, so the shared rule styles it and it keeps its gutter
  // from the last tab.
  bar.parentElement?.querySelector('.tab-new-btn')?.remove()
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'tab-new-btn'
  add.setAttribute('aria-label', isChinese() ? '新建标签页' : 'New tab')
  add.append(plusGlyph())
  add.addEventListener('click', () => void openNewTab())
  add.addEventListener('mouseenter', () => scheduleTip(add, isChinese() ? '新建标签页 · ⌘T' : 'New tab · ⌘T', 'below', TAB_TIP_DELAY))
  add.addEventListener('mouseleave', hideTip)
  bar.after(add)
  const active = bar.querySelector('.tab-entry.active')
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  // Let the main process know which files this window holds in tabs, so opening
  // an already open document can focus that tab instead of duplicating it.
  window.electronAPI.setTabFiles(tabs.map((tab) => tab.filePath).filter((path): path is string => !!path))
  reportDirty()
}

function showBlankDocument(): void {
  if (isPresenting()) stopSlideshow()
  exitSourceMode()
  // A blank document carries no properties block from the one before it.
  activeFrontmatter = ''
  activeLineEnding = '\n'
  applyingProgrammaticChange = true
  try {
    setMarkdown('', true, { fileUrl: currentFileUrl, hideBlankLines })
  } finally {
    applyingProgrammaticChange = false
  }
  updateWordCount()
  resetDirty()
  updateFileTitle()
  updatePanelVisibility()
  void refreshSiblings()
  scheduleOutlineUpdate()
  editorScroller().scrollTop = 0
  sourceEl().scrollTop = 0
}

// Switching away must not lose work. A tab with a path is flushed through the
// usual queue (same rule the file panel already followed); an untitled tab keeps
// its content in its own record and is only decided on when it would really be
// dropped (closing the tab, or closing the window).
async function saveTabForLeaving(tab: DocumentTab | null): Promise<boolean> {
  if (!tab || !tab.dirty || !tab.filePath) return true
  return await saveCurrent()
}

// The window always holds at least one document, so the strip never shows a
// lone plus next to a welcome screen that belongs to no tab: a launch with no
// file seeds the first tab here, and a file that arrives later adopts it.
function ensureTab(): DocumentTab {
  const existing = activeTab()
  if (existing) return existing
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    filePath: null,
    dirty: false,
    revision: documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    frontmatter: '',
    lineEnding: '\n',
    editorState: null,
    diskContent: null,
    scrollTop: 0,
    scrollSnapshot: null
  }
  tabs.push(tab)
  activeTabId = tab.id
  return tab
}

async function openNewTabNow(): Promise<void> {
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    filePath: null,
    dirty: false,
    revision: ++documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    frontmatter: '',
    lineEnding: '\n',
    editorState: null,
    diskContent: null,
    scrollTop: 0,
    scrollSnapshot: null
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  currentFileUrl = null
  // Tell the main process the window is now on an untitled document, otherwise
  // its notion of the active file still points at the previous tab's file.
  await window.electronAPI.activateFile(null)
  showBlankDocument()
  renderTabBar()
  // The new tab exists to be typed in, so the caret goes there without a click.
  focusEditor()
}

/**
 * 换文档时告诉编辑器新的图片基准 URL。
 *
 * 文件里写的是相对路径，浏览器要的是绝对地址；解析在画图那一刻做，
 * 这样保存时写回去的还是用户原本写的那串字符。
 */
function applyDocumentFileUrl(url: string | null): void {
  if (url === currentFileUrl) return
  currentFileUrl = url
  setDocumentFileUrl(url)
}

/** 路径刚变过（另存为、自动保存落盘）时，问主进程要一次 URL。 */
async function refreshDocumentFileUrl(): Promise<void> {
  const url = currentFilePath ? await window.electronAPI.fileUrl(currentFilePath) : null
  applyDocumentFileUrl(url)
}

async function activateTabNow(id: string, savePrevious = true): Promise<'ok' | 'missing' | 'cancelled'> {
  if (id === activeTabId) return 'ok'
  if (switchingTab) return 'cancelled'
  if (isPresenting()) stopSlideshow()
  const target = tabs.find((tab) => tab.id === id)
  if (!target) return 'cancelled'
  const previous = activeTab()
  captureActiveTab()
  if (savePrevious && !await saveTabForLeaving(previous)) return 'cancelled'
  switchingTab = true
  try {
    // Point the window at the incoming document first: this re-points the file
    // watcher, the title and the recent list, and reports whether the file
    // changed while this tab sat in the background. An untitled tab passes null
    // so the window stops pointing at the tab we are leaving.
    const result = target.filePath ? await window.electronAPI.navigateToFile(target.filePath, true) : null
    if (result?.status === 'missing') return 'missing'
    if (result?.status === 'error') return 'cancelled'
    if (!target.filePath) await window.electronAPI.activateFile(null)
    const disk = result?.status === 'ok' ? result : null
    currentFileUrl = result?.status === 'ok' || result?.status === 'cached' ? result.fileUrl : null
    // This document may have been written in a different style than the one we
    // are leaving; its content comes back with it, and the style lives in the
    // content itself, so there is nothing to restore separately.
    activeFrontmatter = target.frontmatter
    activeLineEnding = target.lineEnding
    activeTabId = target.id
    currentFilePath = target.filePath
    documentRevision = target.revision
    dirty = false
    externalConflictPending = false
    const changedOnDisk = !!disk && target.diskContent !== null && disk.content !== target.diskContent
    if (changedOnDisk && !target.dirty) {
      target.diskContent = disk!.content
      setContent(disk!.content, true)
      navigation?.reloaded()
      clearDirty()
      clearSaveStatus()
    } else if (target.sourceMode) {
      enterSourceMode(target.sourceText, 0)
    } else if (target.editorState) {
      exitSourceMode()
      // Swapping in the tab's own editor state is not a user edit. Without this
      // guard the listener fires, the tab flips to 「已编辑」, and an autosave
      // rewrites the file the user never touched.
      applyingProgrammaticChange = true
      try {
        restoreEditorState(target.editorState, { fileUrl: currentFileUrl, hideBlankLines })
      } finally {
        applyingProgrammaticChange = false
      }
    }
    // The tab's own unsaved state decides, never the swap itself.
    dirty = target.dirty
    reportDirty()
    if (dirty) {
      showSaveStatus('dirty')
      if (!changedOnDisk) scheduleAutosave()
    } else {
      clearSaveStatus()
    }
    updateWordCount()
    updateFileTitle()
    updatePanelVisibility()
    void refreshSiblings()
    scheduleOutlineUpdate()
    const view = getEditorView()
    if (target.sourceMode) sourceEl().scrollTop = target.scrollTop
    else if (target.scrollSnapshot && view && view.state.doc === target.editorState?.doc) {
      view.dispatch({ effects: target.scrollSnapshot })
    } else editorScroller().scrollTop = target.scrollTop
    renderTabBar()
    if (documentOperationActive) setEditorEditable(false)
    if (changedOnDisk && target.dirty && !windowClosePreparing) raiseExternalConflict()
    return 'ok'
  } finally {
    switchingTab = false
  }
}

async function closeTabNow(id: string): Promise<void> {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const tab = tabs[index]
  if (tab.id === activeTabId) {
    captureActiveTab()
    if (!await saveTabForLeaving(tab)) return
    if (tab.dirty && !tab.filePath && !confirmDiscardUntitled()) return
  } else if (tab.dirty) {
    // A background tab is not the active document, so it is written straight to
    // its own path; an untitled one cannot be written without a dialog.
    if (tab.filePath) {
      const saved = await window.electronAPI.saveFile(tab.content, tab.filePath, false, false)
      if (!saved) return
      tab.dirty = false
    } else if (!confirmDiscardUntitled()) {
      return
    }
  }
  // 先确认替代标签能激活，再移除当前标签；读取失败仍保留可见文档。
  if (tab.id === activeTabId && tabs.length > 1) {
    const replacement = tabs[index + 1] ?? tabs[index - 1]
    if (await activateTabNow(replacement.id) !== 'ok') return
  }
  tabs.splice(index, 1)
  navigation?.closed(tab.id, tab.filePath)
  if (tabs.length === 0) {
    // The last tab closed: the window falls back to a single blank document and
    // the bar disappears with it — then asks to close (#132). A clean blank
    // window is not a state the user can reach any other way, and ⌘W used to
    // loop here forever: close the blank, get a fresh blank. If the close is
    // denied (the guard never does for a clean window), the fallback remains.
    activeTabId = null
    await openNewTabNow()
    void window.electronAPI.closeWindow()
    return
  }
  renderTabBar()
}

// An untitled tab has nowhere to go on disk, so closing it asks first.
function confirmDiscardUntitled(): boolean {
  return window.confirm(isChinese()
    ? '这个标签页还没有保存，关闭会丢掉里面的内容。'
    : 'This tab has unsaved content. Close it anyway?')
}

// Open a file in a tab of its own. Reuses a blank current tab, and never opens
// the same file twice: an already open document just gets focused.
async function openFileInNewTabNow(path: string): Promise<void> {
  const existing = tabs.find((tab) => tab.filePath === path)
  if (existing) {
    await activateTabNow(existing.id)
    return
  }
  captureActiveTab()
  if (!await saveTabForLeaving(activeTab())) return
  const result = await window.electronAPI.navigateToFile(path)
  if (result.status !== 'ok') return
  const current = activeTab()
  if (current && (current.filePath || current.dirty)) {
    // 只有读取成功才创建标签；中间的空标签不进入导航历史，也不重绑主进程。
    activeTabId = null
    ensureTab()
  }
  applyOpenedFile(result)
}

// 文件列表与历史重开都在当前标签浏览，已打开的目标则激活原标签。
async function openFileInCurrentTabNow(path: string): Promise<'ok' | 'missing' | 'cancelled'> {
  const existing = tabs.find((tab) => tab.filePath === path)
  if (existing) return activateTabNow(existing.id)
  captureActiveTab()
  if (dirty && !await saveCurrent()) return 'cancelled'
  const result = await window.electronAPI.navigateToFile(path)
  if (result.status !== 'ok') return result.status === 'missing' ? 'missing' : 'cancelled'
  applyOpenedFile(result)
  return 'ok'
}

// 历史中的标签可能已装入另一文件，路径优先；无路径文档只能返回仍打开的原标签。
async function openNavigationAnchor(anchor: NavigationAnchor): Promise<'ok' | 'missing' | 'cancelled'> {
  if (anchor.filePath) return openFileInCurrentTabNow(anchor.filePath)
  if (!tabs.some(tab => tab.id === anchor.tabId && !tab.filePath)) return 'missing'
  return activateTabNow(anchor.tabId)
}

// 显式应用一次已成功读取的文件，定位恢复不再与下一帧归零竞争。
function applyOpenedFile(data: { path: string | null; content: string; fileUrl: string | null }): void {
  ensureTab()
  const previous = activeTab()!
  if (!previous.filePath && data.path) navigation?.closed(previous.id, null)
  currentFilePath = data.path
  currentFileUrl = data.fileUrl
  dirty = false
  previous.filePath = data.path
  previous.dirty = false
  previous.diskContent = data.content
  resetDirty()
  previous.revision = documentRevision
  setContent(data.content, true)
  navigation?.reloaded()
  editorScroller().scrollTop = 0
  sourceEl().scrollTop = 0
  updateFileTitle()
  updatePanelVisibility()
  void refreshSiblings()
  scheduleOutlineUpdate()
  renderTabBar()
}

// Closing several tabs runs one at a time: each close may need its own unsaved
// confirmation, and a cancelled one stops the rest.
async function closeTabsMatchingNow(keep: (index: number) => boolean): Promise<void> {
  for (;;) {
    const index = tabs.findIndex((_tab, i) => keep(i))
    if (index < 0) return
    const before = tabs.length
    await closeTabNow(tabs[index].id)
    if (tabs.length === before) return
  }
}

function bindTabBar(api: import('../preload/index').ElectronAPI): void {
  // 文件载入与目标定位共用文档队列，只提交最终落点，不把目标文件开头记成额外一步。
  const enqueueTabOpen = (path: string, fragment?: string, line?: number): void => {
    void enqueueDocumentOperation(async () => {
      await openFileInNewTabNow(path)
      if ((!fragment && line === undefined) || currentFilePath !== path) return
      // 同步设置选区和滚动效果，由编辑器测量时应用；隐藏窗口无须等动画帧才能完成操作。
      if (line !== undefined) {
        if (sourceModeActive) jumpToSourceLine(sourceEl(), line)
        else jumpToLine(Math.min(line, getMarkdown().split('\n').length) - 1)
        return
      }
      if (sourceModeActive) exitSourceMode()
      jumpToHeading(fragment!)
    }, true, !!fragment || line !== undefined).catch(() => { /* 一次打开失败不阻止后续请求。 */ })
  }
  // Tabs are also created from the File menu / ⌘T and from the file list; the
  // strip's own plus is bound above, in renderTabBar.
  api.onMenuNewTab(() => { void openNewTab() })
  api.onMenuCloseTab(() => { if (activeTabId) void closeTab(activeTabId) })
  api.onOpenInNewTab(enqueueTabOpen)
  const handleTabMenuAction = ({ action, tabId }: { action: string; tabId: string }) => {
    if (action === 'close') { void closeTab(tabId); return }
    if (action === 'close-others') { void closeTabsMatching((i) => tabs[i].id !== tabId); return }
    if (action === 'close-right') {
      void closeTabsMatching((i) => i > tabs.findIndex((tab) => tab.id === tabId))
    }
  }
  api.onTabMenuAction(handleTabMenuAction)
  // Chromium re-dispatches hover events after the DOM under the pointer changes,
  // with the same coordinates. Closing a tab rebuilds the strip, so the hint used
  // to re-arm itself under a pointer that never moved and looked like it refused
  // to go away (#90). A real hover always comes with new coordinates.
  let lastHoverPoint = ''
  tabBarEl().addEventListener('mouseover', (e) => {
    const point = `${e.clientX},${e.clientY}`
    if (point === lastHoverPoint) return
    lastHoverPoint = point
    const target = e.target as HTMLElement
    const entry = target.closest('.tab-entry') as HTMLElement | null
    if (entry) scheduleTip(entry, tabTipText(entry), 'below', TAB_TIP_DELAY)
    else hideTabTip()
  })
  tabBarEl().addEventListener('mouseleave', () => {
    // Leaving clears the gate: coming back to the same pixel is a real hover.
    lastHoverPoint = ''
    hideTabTip()
  })
  tabBarEl().addEventListener('contextmenu', (e) => {
    const entry = (e.target as HTMLElement).closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    e.preventDefault()
    void api.showTabContextMenu({
      tabId: id,
      filePath: tabs[index].filePath,
      canCloseOthers: tabs.length > 1,
      canCloseRight: index < tabs.length - 1
    })
  })
  api.onFocusFile((path) => {
    const tab = tabs.find((candidate) => candidate.filePath === path)
    if (tab) void activateTab(tab.id)
  })
  tabBarEl().addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const entry = target.closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    if (target.closest('.tab-entry-close')) {
      void closeTab(id)
      return
    }
    void activateTab(id)
  })
  // Middle click closes, the browser convention; the bar stays free of a
  // permanent close affordance (design.md).
  tabBarEl().addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const entry = (e.target as HTMLElement).closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    e.preventDefault()
    void closeTab(id)
  })
}

// Keep the active tab's record in step with a successful write, so switching
// back to it later can tell whether the file changed underneath us.
function noteTabSaved(content: string): void {
  const tab = activeTab()
  if (!tab) return
  if (tab.filePath !== currentFilePath) {
    navigation?.renamed({ filePath: tab.filePath, tabId: tab.id }, { filePath: currentFilePath, tabId: tab.id })
  }
  tab.diskContent = content
  tab.filePath = currentFilePath
  tab.dirty = dirty
}

function setDirty(): void {
  documentRevision += 1
  dirty = true
  reportDirty()
  showSaveStatus('dirty')
  markActiveTabDirty()
  scheduleAutosave()
}

function clearDirty(): void {
  dirty = false
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  reportDirty()
  markActiveTabDirty()
}

// Invalidate any in-flight save captured from the previous document before
// replacing editor content from disk.
function resetDirty(): void {
  documentRevision += 1
  clearDirty()
  clearSaveStatus()
}

function enqueueSave(operation: () => Promise<string | null>): Promise<string | null> {
  const next = saveQueue.then(operation, operation)
  saveQueue = next.then(() => undefined, () => undefined)
  return next
}

function scheduleAutosave(): void {
  if (!currentFilePath) return
  // Paused while an external-modification conflict is unresolved: the user
  // must decide between their version and the disk version first.
  if (externalConflictPending || windowClosePreparing) return
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    void runAutosave()
  }, 1000)
}

async function runAutosave(): Promise<void> {
  if (!dirty || !currentFilePath) return
  const revision = documentRevision
  const filePath = currentFilePath
  const content = getFileContent()
  // rebuildMenu=false: autosave must never rebuild the app menu (macOS IME)
  // autosave=true: the main process may refuse the write when the file changed
  // on disk since our last read or write, and ask the user instead.
  const path = await enqueueSave(() => window.electronAPI.saveFile(content, filePath, false, true))
  if (path && revision === documentRevision && currentFilePath === filePath) {
    if (path !== filePath) void refreshDocumentFileUrl()
    currentFilePath = path
    clearDirty()
    noteTabSaved(content)
    showSaveStatus('saved')
  }
}

async function saveCurrent(saveAs = false): Promise<boolean> {
  const revision = documentRevision
  const content = getFileContent()
  const expectedPath = currentFilePath
  // '' states plainly that the active document is untitled, so a save can never
  // be written into a file the window happens to have open in another tab.
  const path = await enqueueSave(() => saveAs
    ? window.electronAPI.saveFileAs(content, expectedPath ?? '')
    : window.electronAPI.saveFile(content, expectedPath ?? '', true))
  if (!path || currentFilePath !== expectedPath) return false

  if (path !== expectedPath) void refreshDocumentFileUrl()
  currentFilePath = path
  updateFileTitle()
  refreshSiblings()
  noteTabSaved(content)
  if (path !== expectedPath) renderTabBar()
  if (revision === documentRevision) {
    clearDirty()
    showSaveStatus('saved')
    return true
  }
  if (dirty) scheduleAutosave()
  return false
}

function applyContent(content: string): void {
  // Reached only when the document identity changes (New file, loading a disk
  // version after an external conflict), so the undo stack must not survive.
  setContent(content, true)
}

// --- Document statistics (top-right hover indicator) ---
// 展示请求按帧合并，大文档统计分段让出主线程；保存状态仍同步更新。
let statisticsQueued = false
const documentStatistics = new DocumentStatisticsScheduler()

function setToolbarTip(el: HTMLElement, label: string): void {
  el.setAttribute('aria-label', label)
  const tip = el.querySelector('.toolbar-tip')
  if (tip) tip.textContent = label
}

function updateWordCount(): void {
  if (statisticsQueued) return
  statisticsQueued = true
  requestAnimationFrame(() => {
    statisticsQueued = false
    // 回调读取当前文档，连续切标签不会把前一篇的统计写到新标签上。
    const text = getContent()
    documentStatistics.request(text, statistics => {
      // 新正文的帧回调尚未执行时，旧任务也不能发布到已经切换的文档。
      if (text !== getContent()) return
      const label = statisticsLabels[isChinese() ? 'zh' : 'en'].statistics
        .replace('{characters}', String(statistics.characters))
        .replace('{tokens}', String(statistics.tokens))
        .replace('{paragraphs}', String(statistics.paragraphs))
      setToolbarTip(wordCountEl(), label)
    })
  })
}

// --- Reveal the current file in the OS file manager ---
function fileLocationLabel(): string {
  if (isChinese()) {
    return fileManagerName === 'finder'
      ? '在 Finder 中显示'
      : fileManagerName === 'explorer'
        ? '在资源管理器中显示'
        : '打开所在文件夹'
  }
  return fileManagerName === 'finder'
    ? 'Reveal in Finder'
    : fileManagerName === 'explorer'
      ? 'Reveal in File Explorer'
      : 'Open Containing Folder'
}

// The titlebar is a window drag region, so the button cannot rely on
// `#titlebar:hover`. Its gate lives on the file title instead; this keeps the
// label and the disabled state in sync with the loaded document.
// --- Markdown source / WYSIWYG toggle ---
function updateSourceToggle(): void {
  const btn = sourceToggleBtnEl()
  btn.classList.toggle('active', sourceModeActive)
  const label = sourceModeActive
    ? (isChinese() ? '切换回所见即所得' : 'Switch to WYSIWYG')
    : (isChinese() ? '切换 Markdown 源码' : 'Switch to Markdown source')
  setToolbarTip(btn, label)
}

function updateUiLanguage(): void {
  const zh = isChinese()
  document.documentElement.lang = zh ? 'zh-CN' : 'en'
  document.title = appConfig.name
  untitledName = zh ? '未命名' : 'Untitled'
  sidebars.updateLabels()
  const menuBtn = document.getElementById('app-menu-btn')
  if (menuBtn) setToolbarTip(menuBtn, zh ? '菜单' : 'Menu')
  updateSourceToggle()
  updateWordCount()
  scheduleFileListRender()
}
function scrollRatio(el: HTMLElement): number {
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

function restoreScrollRatio(el: HTMLElement, ratio: number): void {
  const range = el.scrollHeight - el.clientHeight
  el.scrollTop = Math.max(0, Math.min(range, range * ratio))
}

function caretViewportFraction(top: number | null, height: number): number {
  return top !== null && top >= 0 && top < height ? top / height : 1 / 3
}

function caretViewportOffset(fraction: number, height: number, lineHeight: number): number {
  const margin = Math.min(lineHeight * 2, height / 3)
  return Math.max(margin, Math.min(height - margin, fraction * height))
}

// 切换排版只同步位置基线，不产生新的导航动作。
function toggleSourceMode(): void {
  if (navigation) navigation.withoutRecording(toggleSourceModeNow)
  else toggleSourceModeNow()
}

function toggleSourceModeNow(): void {
  if (sourceModeActive) {
    const ta = sourceEl()
    const { selectionStart, selectionEnd, selectionDirection } = ta
    const backward = selectionDirection === 'backward'
    const head = backward ? selectionStart : selectionEnd
    const fraction = caretViewportFraction(sourcePositionTop(ta, head) - ta.scrollTop, ta.clientHeight)
    exitSourceMode()
    setMarkdownProgrammatically(ta.value)
    // 源码与编辑器缓冲区是同一份字节，偏移直接对得上：光标回到源码里停的位置
    const view = getEditorView()
    if (view) {
      view.dispatch({
        selection: { anchor: backward ? selectionEnd : selectionStart, head },
        effects: EditorView.scrollIntoView(head, {
          y: 'start',
          yMargin: caretViewportOffset(fraction, view.scrollDOM.clientHeight, view.defaultLineHeight),
        }),
      })
      const { doc, selection } = view.state
      const tabId = activeTabId
      // Let the newly visible viewport finish drawing before focus creates its
      // native selection. Focus handlers dispatch, so leave CM's write phase.
      view.requestMeasure({
        key: toggleSourceMode,
        read: () => null,
        write: () => queueMicrotask(() => {
          if (!sourceModeActive && activeTabId === tabId && view.state.doc === doc && view.state.selection.eq(selection)) view.focus()
        }),
      })
    }
  } else {
    const view = getEditorView()
    const main = view?.state.selection.main
    const rect = main && view?.coordsAtPos(main.head, main.assoc || 1)
    const scroller = editorScroller()
    const fraction = caretViewportFraction(rect ? rect.top - scroller.getBoundingClientRect().top - scroller.clientTop : null, scroller.clientHeight)
    enterSourceMode(getMarkdown())
    // 写入 value 会把光标挪到文末，焦点给了却停在那儿，一打字就跳到底
    const ta = sourceEl()
    if (main) ta.setSelectionRange(main.from, main.to, main.head < main.anchor ? 'backward' : 'forward')
    ta.focus({ preventScroll: true })
    const head = main?.head ?? ta.selectionEnd
    const style = getComputedStyle(ta)
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize)
    ta.scrollTop = Math.max(0, sourcePositionTop(ta, head) - caretViewportOffset(fraction, ta.clientHeight, lineHeight))
  }
  updateWordCount()
  scheduleOutlineUpdate()
}

// 文件和标签切换只刷新外壳，侧栏偏好不跟随文档变化。
function updatePanelVisibility(): void {
  sidebars.refresh()
}

function outlineVisible(): boolean {
  return sidebars.hasVisibleContent('outline')
}

function renderOutline(side?: SidebarSide): void {
  if (!outlineVisible()) return
  outlineItems = documentOutline.read(getContent())
  const lists = outlineListEls().filter(list => !side || list.closest<HTMLElement>('.sidebar')?.id === `${side}-sidebar`)
  for (const list of lists) {
    const previous = outlineLabelsByList.get(list)
    if (sameOutlineLabels(previous, outlineItems)) continue
    outlineItems.forEach((item, index) => {
      let entry = list.children[index] as HTMLLIElement | undefined
      if (!entry) {
        entry = document.createElement('li')
        const button = document.createElement('button')
        button.dataset.headingIndex = String(index)
        button.type = 'button'
        button.addEventListener('click', () => selectOutlineItem(index))
        entry.append(button)
        list.append(entry)
      }
      const button = entry.firstElementChild as HTMLButtonElement
      if (button.textContent !== item.title) button.textContent = item.title
      button.title = item.title
      button.style.paddingLeft = `${8 + (item.level - 1) * 12}px`
    })
    while (list.children.length > outlineItems.length) list.lastElementChild!.remove()
    outlineLabelsByList.set(list, outlineItems)
  }
  if (outlineItems.length === 0) outlineActiveIndex = -1
  applyOutlineActive()
  scheduleOutlineActiveSync()
}

// 点击读取最新行号，正文换行而标题未变时也能跳到正确位置。
function selectOutlineItem(index: number): void {
  const current = documentOutline.read(getContent())[index]
  if (!current) return
  if (sourceModeActive) {
    navigation?.beforeSwitch()
    beginOutlineJump()
    const source = sourceEl()
    const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24
    source.scrollTop = Math.max(0, current.line * lineHeight - lineHeight)
    source.focus()
    revealSourceHeading(source, current.line)
  } else {
    beginOutlineJump()
    jumpToLine(current.line)
  }
  setActiveOutlineIndex(index)
}

function applyOutlineActive(): void {
  for (const list of outlineListEls()) {
    const buttons = list.querySelectorAll<HTMLButtonElement>('button')
    buttons.forEach((button, index) => button.classList.toggle('active', index === outlineActiveIndex))
  }
  if (outlineRevealQueued) return
  outlineRevealQueued = true
  requestAnimationFrame(() => {
    outlineRevealQueued = false
    // 先批量读取两侧几何，再写滚动位置，避免写入后立即触发布局读取。
    const updates = outlineListEls().flatMap(list => {
      const button = list.querySelectorAll<HTMLButtonElement>('button')[outlineActiveIndex]
      if (!button) return []
      const panel = button.closest<HTMLElement>('.sidebar')!
      const panelTop = panel.getBoundingClientRect().top
      const top = button.getBoundingClientRect().top - panelTop + panel.scrollTop
      const bottom = top + button.offsetHeight
      const scrollTop = top < panel.scrollTop ? top
        : bottom > panel.scrollTop + panel.clientHeight ? bottom - panel.clientHeight : panel.scrollTop
      return [{ panel, scrollTop }]
    })
    for (const { panel, scrollTop } of updates) {
      if (panel.scrollTop !== scrollTop) panel.scrollTop = scrollTop
    }
  })
}

function beginOutlineJump(): void {
  outlineJumping = true
  if (outlineJumpTimer) clearTimeout(outlineJumpTimer)
  outlineJumpStartTop = (sourceModeActive ? sourceEl() : editorScroller()).scrollTop
  // scrollend releases the lock earlier; this fallback exists for the
  // no-scroll case. Re-arming while the position keeps changing keeps long
  // smooth jumps locked for their whole duration (review on #68).
  outlineJumpTimer = setTimeout(releaseOutlineJumpIfSettled, 1500)
}

function releaseOutlineJumpIfSettled(): void {
  if (!outlineJumping) return
  const top = (sourceModeActive ? sourceEl() : editorScroller()).scrollTop
  if (top !== outlineJumpStartTop) {
    outlineJumpStartTop = top
    outlineJumpTimer = setTimeout(releaseOutlineJumpIfSettled, 400)
    return
  }
  endOutlineJump()
}

function endOutlineJump(): void {
  if (!outlineJumping) return
  outlineJumping = false
  if (outlineJumpTimer) {
    clearTimeout(outlineJumpTimer)
    outlineJumpTimer = null
  }
  scheduleOutlineActiveSync()
}

function setActiveOutlineIndex(index: number): void {
  if (index === outlineActiveIndex) return
  outlineActiveIndex = index
  applyOutlineActive()
}

function scheduleOutlineActiveSync(): void {
  if (!outlineVisible()) return
  if (outlineJumping) return
  if (outlineSyncQueued) return
  outlineSyncQueued = true
  requestAnimationFrame(() => {
    outlineSyncQueued = false
    syncOutlineActive()
  })
}

// Scrollspy: highlight the outline entry for the section at the top of the
// viewport so the outline tracks reading progress (#64).
function syncOutlineActive(): void {
  if (outlineItems.length === 0) return
  setActiveOutlineIndex(sourceModeActive ? sourceActiveIndex() : visualActiveIndex())
}

// 视觉模式下的阅读进度：拿每一条标题所在行在正文坐标系里的位置，跟视口顶部比。
//
// 旧实现找的是 DOM 里的 <h1>…<h6> 元素（ProseMirror 会把标题渲成真标签）。CodeMirror 不产
// 生这些元素，标题只是带装饰的一行文字，所以改成用编辑器自己的行位置来算：
// lineBlockAt 给出行在正文坐标系里的 top，减去滚动量就是它相对视口的位置。
function visualActiveIndex(): number {
  const view = getEditorView()
  if (!view) return -1
  const container = editorScroller()
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2
  if (atBottom) return outlineItems.length - 1
  const threshold = Math.min(96, container.clientHeight * 0.2)
  let index = -1
  for (let i = 0; i < outlineItems.length; i += 1) {
    const line = outlineItems[i].line
    if (line === undefined || line >= view.state.doc.lines) continue
    const top = view.lineBlockAt(view.state.doc.line(line + 1).from).top
    if (top - container.scrollTop > threshold) break
    index = i
  }
  return index
}

function sourceActiveIndex(): number {
  const source = sourceEl()
  const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24
  const firstLine = Math.round(source.scrollTop / lineHeight)
  let index = -1
  for (let i = 0; i < outlineItems.length; i += 1) {
    if ((outlineItems[i].line ?? 0) > firstLine + 1) break
    index = i
  }
  return index
}

// Source mode cannot render a heading band; selecting the heading line gives
// the same "you have arrived" feedback as the visual flash (#64).
function revealSourceHeading(source: HTMLTextAreaElement, line: number): void {
  let start = 0
  for (let i = 0; i < line; i += 1) {
    const next = source.value.indexOf('\n', start)
    if (next === -1) {
      start = source.value.length
      break
    }
    start = next + 1
  }
  const end = source.value.indexOf('\n', start)
  source.setSelectionRange(start, end === -1 ? source.value.length : end)
}

function scheduleOutlineUpdate(): void {
  if (!outlineVisible()) return
  if (outlineUpdateQueued) return
  outlineUpdateQueued = true
  requestAnimationFrame(() => {
    outlineUpdateQueued = false
    renderOutline()
  })
}

function updateFileTitle(): void {
  // The filename is shown by the tab; the window title is the only place left
  // that needs it spelled out (there is no centred title in the title bar).
  const name = currentFilePath ? (currentFilePath.split(/[\\/]/).pop() || currentFilePath) : (isChinese() ? '未命名' : 'Untitled')
  document.title = name
}

// 文件列表数据、节点和刷新轮次分别管理，连续事件只绘制最新结果。
const filePanel = new FilePanelModel(path => window.electronAPI.listDirectory(path), scheduleFileListRender)
const filePanelView = new FilePanelView(
  (button, label, side) => scheduleTip(button, label, side, ROW_TIP_DELAY),
  hideTip,
)

// 自定义主题也可能改变列表间距，主题应用后重新测量虚拟行的几何。
function applyWindowTheme(name: string, customCSS?: string): void {
  applyTheme(name, customCSS)
  filePanelView.refreshGeometry()
}

let fileListRenderQueued = false
let siblingsRequestVersion = 0
let siblingsRefreshRequested = false
let siblingsRefresh: Promise<void> | null = null

// 只绘制可见文件面板，重新显示时复用当前数据补齐。
function scheduleFileListRender(): void {
  if (fileListRenderQueued) return
  fileListRenderQueued = true
  requestAnimationFrame(() => {
    fileListRenderQueued = false
    const lists = Array.from(document.querySelectorAll<HTMLElement>('.sidebar[data-content="files"][aria-hidden="false"] .file-list'))
    if (lists.length === 0) return
    hideTip()
    filePanelView.render(lists, filePanel.rows(), currentFilePath, isChinese() ? 'zh' : 'en')
  })
}

// 读取期间的新请求合并为下一轮，旧结果不能覆盖新的文件切换或目录事件。
function refreshSiblings(): Promise<void> {
  siblingsRequestVersion++
  siblingsRefreshRequested = true
  if (siblingsRefresh) return siblingsRefresh
  siblingsRefresh = (async () => {
    while (siblingsRefreshRequested) {
      siblingsRefreshRequested = false
      const version = siblingsRequestVersion
      try {
        const files = await window.electronAPI.listSiblings()
        if (files && version === siblingsRequestVersion) void filePanel.replaceRoot(files)
      } catch (error) {
        console.error('文件列表读取失败', error)
      }
    }
  })().finally(() => {
    siblingsRefresh = null
    if (siblingsRefreshRequested) void refreshSiblings()
  })
  return siblingsRefresh
}

function enterSourceMode(content: string, ratio = 0): void {
  sourceModeActive = true
  editorEl().classList.add('hidden')
  const ta = sourceEl()
  ta.classList.add('visible')
  ta.value = content
  restoreScrollRatio(ta, ratio)
  updateSourceToggle()
}

function exitSourceMode(): void {
  sourceModeActive = false
  editorEl().classList.remove('hidden')
  sourceEl().classList.remove('visible')
  updateSourceToggle()
}

const LARGE_DOCUMENT_SOURCE_THRESHOLD = 512 * 1024

// 一份完整的文件从磁盘到达：打开，或外部改写之后的重载。
//
// 文本优先之后属性区不再需要拆出来单独保管：它本来就是正文开头的几行，编辑器原样
// 拿着它，保存时原样写回去。这个函数现在只做一件事：记下行尾。
function takeFrontmatter(fileText: string): string {
  activeFrontmatter = ''
  activeLineEnding = fileText.includes('\r\n') ? '\r\n' : '\n'
  return fileText
}

function setContent(content: string, flushHistory = false): void {
  const body = takeFrontmatter(content)
  if (body.length >= LARGE_DOCUMENT_SOURCE_THRESHOLD) {
    // 装饰层是**整篇**重算的（live-preview 的 StateField），半兆以上的文档每次敲键都要
    // 重算一遍全篇，打字会卡。所以超大文件仍然进源码模式——渲染不参与，编辑就快。
    // （旧核心的理由是「ProseMirror 会把整篇渲染出来」，那条早就不成立了。）
    enterSourceMode(body)
    updateWordCount()
    return
  }
  exitSourceMode()
  setMarkdownProgrammatically(body, flushHistory)
  updateWordCount()
}

function getContent(): string {
  if (sourceModeActive) return sourceEl().value
  return getMarkdown()
}

// What belongs in the file: the properties block untouched, then the document
// in the line endings the file already used.
const documentFileContent = new DocumentFileContent()

function getFileContent(): string {
  return documentFileContent.read(getContent(), activeLineEnding, activeFrontmatter)
}

/**
 * 导出前把编辑器的痕迹收起来，导出后放回去。
 *
 * 「痕迹」有两样：光标所在那一行会显形源码（光标停在标题上，导出的就是 `# 标题`），
 * 以及光标与选区本身。两样都不是文档的内容。
 */
async function withCleanExport<T>(run: () => Promise<T>): Promise<T> {
  setCleanExport(true)
  document.body.classList.add('exporting')
  try {
    return await run()
  } finally {
    setCleanExport(false)
    document.body.classList.remove('exporting')
  }
}

/**
 * 导出前把窗口摆成「纸」，导完收回去。
 *
 * 两件事：
 * ① 藏起编辑器的痕迹：当前行不再显形源码（状态层开关），光标、选区、属性区由
 *    `body.exporting` 交给 CSS。导出的是一篇文档，不是编辑器此刻的样子。
 * ② 摊平成块流，等 CodeMirror 把整篇渲染出来。不做这一步，快照里只有当前视口那一屏。
 */
async function withExportLayout<T>(run: () => Promise<T>): Promise<T> {
  setCleanExport(true)
  document.body.classList.add('exporting')
  try {
    await enterPaperLayout()
    return await run()
  } finally {
    exitPaperLayout()
    setCleanExport(false)
    document.body.classList.remove('exporting')
  }
}

function getExportSnapshot(content: string): {
  content: string
  html: string
  document: string
  styles: string
  bodyClass: string
  background: string
} {
  let styles = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      styles += Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n') + '\n'
    } catch {
      // Ignore stylesheets that the browser marks as inaccessible.
    }
  }
  const editorRoot = document.querySelector<HTMLElement>('#editor .cm-content')
  // 导出交出去的是屏幕上这份 DOM：放大状态会跟着出去（纸上只剩图的一角），那排缩放按钮
  // 也会被一起画上去。序列化的这会儿还原视口、藏掉控件，完事立刻恢复（见 withDiagramZoomPaused）。
  return withDiagramZoomPaused(() => ({
    content,
    // 图片与 PDF 导出要的是「和屏幕上一模一样」，所以仍旧交编辑器那份 DOM；
    // HTML 导出交的是**一篇文档**：语义标签，没有编辑器自己的类名和行结构。
    html: editorRoot?.innerHTML ?? '',
    document: editorRoot ? documentHTMLFrom(editorRoot) : '',
    styles,
    bodyClass: Array.from(document.body.classList)
      .filter((name) => name !== 'show-left-sidebar' && name !== 'show-right-sidebar' && name !== 'paper')
      .join(' '),
    background: getComputedStyle(document.body).backgroundColor,
  }))
}

async function exportCurrentHTML(): Promise<void> {
  const wasSourceMode = sourceModeActive
  const sourceScrollRatio = wasSourceMode ? scrollRatio(sourceEl()) : 0
  const content = getContent()

  // Render the latest source text before taking the DOM snapshot, then restore
  // source mode so exporting does not change the user's editing context.
  if (wasSourceMode) {
    exitSourceMode()
    setMarkdownProgrammatically(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      })
    })
  }

  await withExportLayout(() => window.electronAPI.exportHTML(getExportSnapshot(content)))

  if (wasSourceMode) {
    enterSourceMode(content, sourceScrollRatio)
  }
}

async function exportCurrentImage(preset: 'desktop' | 'mobile'): Promise<void> {
  const wasSourceMode = sourceModeActive
  const sourceScrollRatio = wasSourceMode ? scrollRatio(sourceEl()) : 0
  const content = getContent()

  if (wasSourceMode) {
    exitSourceMode()
    setMarkdownProgrammatically(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  await withExportLayout(() => window.electronAPI.exportImage(getExportSnapshot(content), preset))

  if (wasSourceMode) enterSourceMode(content, sourceScrollRatio)
}

// 导出幻灯片 PDF: the file and the dialog belong to the main process, so it
// asks the window to become paper through this hook. The deck's rule holds here
// too — pages come from the RENDERED document — so source mode is rendered
// first, or the export would print whatever was on screen before it was typed.
window.__colamdSlidesExport = {
  enter: async () => {
    if (sourceModeActive) {
      const content = getContent()
      exitSourceMode()
      setMarkdownProgrammatically(content)
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
    }
    return enterPrintLayout()
  },
  exit: () => exitPrintLayout()
}

// 导出 PDF 打印的是**这个窗口本身**（主进程直接 printToPDF），所以两件事都得在
// 打印前做完：当前行的源码、光标、选区不该上纸；而且必须先把整篇渲染出来，
// 否则纸上只有当前视口那一屏（长文档导出截断的根因）。主进程 await 这个钩子。
/**
 * 导出 HTML 的那份内容。
 *
 * 导出要弹系统保存框，无头环境点不了，所以把「会被写进文件的那段 HTML」单独露出来：
 * 验收脚本（scripts/verify-features.mjs）拿它检查语义标签。只读，不改任何状态。
 */
window.__colamdExportDocumentHTML = (): string => {
  const root = document.querySelector<HTMLElement>('#editor .cm-content')
  return root ? documentHTMLFrom(root) : ''
}

window.__colamdPrintExport = {
  enter: async () => {
    setCleanExport(true)
    await enterPaperLayout()
  },
  exit: () => {
    exitPaperLayout()
    setCleanExport(false)
  }
}

// 放映幻灯片: the pages are the editor's own blocks, so the document has to be
// rendered before the deck starts. In source mode the rich text tree still holds
// whatever was there before the textarea was touched, and presenting that would
// be presenting the wrong document.
async function toggleSlideshow(): Promise<void> {
  if (isPresenting()) {
    stopSlideshow()
    return
  }
  const wasSourceMode = sourceModeActive
  const sourceScrollRatio = wasSourceMode ? scrollRatio(sourceEl()) : 0
  const content = getContent()

  if (wasSourceMode) {
    exitSourceMode()
    setMarkdownProgrammatically(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  const started = startSlideshow({
    onStart: () => {
      setEditorEditable(false)
      void window.electronAPI.setSlideshowFullscreen(true)
    },
    onExit: () => {
      setEditorEditable(!documentOperationActive)
      void window.electronAPI.setSlideshowFullscreen(false)
      if (wasSourceMode) enterSourceMode(content, sourceScrollRatio)
    }
  })
  // Nothing to present (an empty document has no page): put the user back where
  // they were instead of leaving them in a mode that did not open.
  if (!started && wasSourceMode) enterSourceMode(content, sourceScrollRatio)
}

async function init(): Promise<void> {
  const api = window.electronAPI
  // macOS keeps its own overlay scrollbars (drawn while you scroll, no layout
  // space, never in the way). The thin custom scrollbar is only for Windows and
  // Linux, where the platform default is a chunky always-on bar.
  if (!/^Mac/i.test(navigator.platform)) document.body.classList.add('platform-non-mac')
  // Windows has no traffic lights on the left and draws its window controls inside
  // the row on the right (titleBarOverlay), so it needs both ends of the row told
  // apart from macOS. The menu button shows there too, since the menu bar is
  // hidden (the Alt key still reveals the system one).
  if (/Windows/i.test(navigator.userAgent)) {
    document.body.classList.add('platform-win')
    document.getElementById('app-menu-btn')?.removeAttribute('hidden')
  }
  // 三项配置互不依赖；仍在主题应用完成后创建编辑器，避免首屏主题变化。
  const [language, manager, themes] = await Promise.all([
    api.getLanguage(), api.getFileManagerName(), api.listThemeDefinitions()
  ])
  fileManagerName = manager
  setUiLanguage(language)
  setThemeDefinitions(themes)
  const savedTheme = loadSavedTheme()
  if (savedTheme.startsWith('custom:')) {
    // 旧选择按文件身份恢复，避免同内容 CSS 或已编辑的迁移主题互相冒用。
    const fileName = savedTheme.slice(7)
    const migratedId = await api.resolveLegacyThemeId(fileName)
    if (migratedId) applyWindowTheme(migratedId)
    else {
      // 迁移失败时仍支持原 CSS；原文件缺失则回到内置主题。
      const css = await api.loadThemeCSS(fileName)
      applyWindowTheme(css ? savedTheme : 'elegant', css ?? undefined)
    }
  } else {
    applyWindowTheme(savedTheme)
  }
  applyEditorFont(loadSavedEditorFont())

  const searchPanel = new SearchPanel(() => navigation?.beforeSwitch())
  searchPanel.setLanguage(language)
  api.onSearch(() => searchPanel.show())
  // Cmd/Ctrl+F 在页面这一层也接一次：菜单的快捷键是主路径（macOS 上由菜单先接走），
  // 但菜单被隐藏或平台不转发快捷键时，这个兜底能保证打开的仍是**我们自己的**面板，
  // 而不是 CodeMirror 自带那块只有英文的（它已经从编辑器扩展里摘掉了）。
  // Cmd/Ctrl+/ 同理接源码切换（CodeMirror 的注释绑定已摘掉）。页面 preventDefault 之后
  // 菜单的同名快捷键不会再触发；切换不是幂等的，两边都触发就等于没按。
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
    if (event.key === '/') {
      event.preventDefault()
      toggleSourceMode()
      return
    }
    if (event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    searchPanel.show()
  })
  api.onStepFont((delta) => {
    if (delta === 0) resetEditorFontSize()
    else stepEditorFontSize(delta)
  })
  // ⌘+ / ⌘- / ⌘0 在页面这一层也接一次，理由和 ⌘F 那条一样：菜单是主路径，菜单被隐藏或
  // 平台不转发快捷键时，这一层能接住。这三项调的是正文字号，界面尺寸不动（见 font-settings）。
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return
    const key = event.key
    const delta = key === '+' || key === '=' ? 1 : key === '-' || key === '_' ? -1 : key === '0' ? 0 : null
    if (delta === null) return
    event.preventDefault()
    if (delta === 0) resetEditorFontSize()
    else stepEditorFontSize(delta)
  })
  api.onFormatCommand((id) => runFormatCommand(id as FormatCommandId))
  updateUiLanguage()

  await createEditor('editor', () => {
    updateWordCount()
  }, () => {
    if (!editorReady) return
    if (!applyingProgrammaticChange) setDirty()
    scheduleOutlineUpdate()
  })
  applyHideBlankLines(hideBlankLines)
  updateWordCount()
  editorReady = true
  resetDirty()

  // Main asks for an authoritative snapshot before any close or quit.
  api.onRequestDocumentState(async (requestId) => {
    captureActiveTab()
    // 只读快照供诊断和验收；关窗由下面的逐标签保存协调处理。
    window.electronAPI.respondDocumentState(requestId, {
      dirty,
      content: getFileContent(),
      tabs: tabs.filter((tab) => tab.dirty).map((tab) => ({ path: tab.filePath, content: tab.content }))
    })
  })
  api.onCancelWindowClose(() => releaseWindowClose?.())
  api.onPrepareWindowClose((requestId) => {
    // 握手只证明渲染层在响应；用户的原生保存对话框不受三秒超时限制。
    api.acknowledgeWindowClose(requestId)
    void enqueueDocumentOperation(async () => {
      windowClosePreparing = true
      if (autosaveTimer) clearTimeout(autosaveTimer)
      autosaveTimer = null
      let approved = false
      try {
        await saveQueue
        captureActiveTab()
        approved = !externalConflictPending && await prepareDocumentsForClose({
          activeId: () => activeTabId,
          dirtyIds: () => tabs.filter(tab => tab.dirty).map(tab => tab.id),
          activate: async id => await activateTabNow(id, false) === 'ok',
          confirm: () => api.confirmDocumentClose({ path: currentFilePath, content: getFileContent() }),
          save: () => saveCurrent()
        })
        // 批准后先装好释放回调，再通知主进程，避免多窗口退出取消时丢掉释放信号。
        const released = approved ? new Promise<void>(resolve => { releaseWindowClose = resolve }) : null
        api.respondWindowClose(requestId, approved)
        if (released) await released
      } catch (error) {
        console.error('关闭前保存失败', error)
        api.respondWindowClose(requestId, false)
      } finally {
        releaseWindowClose = null
        if (currentFilePath && changesDuringClose.has(currentFilePath)) {
          const path = currentFilePath
          const result = await api.navigateToFile(path, true)
          if (result.status === 'ok' && currentFilePath === path) applyExternalContent(result.content)
        }
        changesDuringClose.clear()
        windowClosePreparing = false
        if (dirty && !externalConflictPending) scheduleAutosave()
        reportDirty()
      }
    }, false)
  })
  // Save before switching files. If saving is cancelled or fails, preserve the
  // current document rather than opening another file over it.
  for (const list of fileListEls()) {
    list.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
      if (!btn || !btn.dataset.path) return
      // A directory expands in place; the tree only ever grows downward.
      if (btn.dataset.kind === 'directory') {
        filePanel.toggle(btn.dataset.path)
        return
      }
      if (btn.dataset.path === currentFilePath) return
      // ⌘/Ctrl click opens the file in a tab of its own (design.md).
      if (btn.dataset.kind === 'file' && (e.metaKey || e.ctrlKey)) {
        await openFileInNewTab(btn.dataset.path)
        return
      }
      const path = btn.dataset.path
      if (btn.dataset.kind === 'file') {
        await enqueueDocumentOperation(() => openFileInCurrentTabNow(path))
      } else await api.openSibling(path)
    })

    // Right-click on a file panel entry opens the native context menu. The
    // parent entry has no target worth acting on, so it keeps the default.
    list.addEventListener('contextmenu', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
      const path = btn?.dataset.path
      const kind = btn?.dataset.kind
      if (!path || kind === 'parent') return
      e.preventDefault()
      void api.showEntryContextMenu(path, kind === 'directory' ? 'directory' : 'file')
    })
  }
  sidebars.init()
  bindTabBar(api)
  // The launch document (the welcome screen or a restored file) is a tab from
  // the first frame, so the strip never renders without one.
  ensureTab()
  renderTabBar()
  navigation = new EditorNavigation({
    getIdentity: () => activeTabId ? { filePath: currentFilePath, tabId: activeTabId } : null,
    isSourceMode: () => sourceModeActive,
    source: sourceEl(),
    isProgrammatic: () => applyingProgrammaticChange || documentOperationActive || isPresenting(),
    open: openNavigationAnchor,
    onStateChange: state => { void api.reportNavigationState(state) },
  })
  navigation.initialize()
  api.onNavigateHistory(direction => { void enqueueDocumentOperation(() => navigation!.navigate(direction), false) })
  // 在捕获阶段接住浏览器侧的快捷键，避免被编辑器的移动命令再次消费。
  document.addEventListener('keydown', event => {
    const mac = navigator.platform.includes('Mac')
    if (!event.altKey || event.shiftKey || event.ctrlKey || event.metaKey !== mac) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    void enqueueDocumentOperation(() => navigation!.navigate(event.key === 'ArrowLeft' ? -1 : 1), false)
  }, true)

  sourceToggleBtnEl().addEventListener('click', toggleSourceMode)
  api.onToggleSourceMode(() => toggleSourceMode())
  api.onSetHideBlankLines(applyHideBlankLines)
  api.onSetWideMedia(applyWideMedia)
  // Source-mode edits update the word count and mark the doc dirty in real time
  sourceEl().addEventListener('input', () => {
    setDirty()
    updateWordCount()
    scheduleOutlineUpdate()
  })
  // The outline tracks scrolling in both modes so it doubles as a progress
  // view (#64); rAF keeps the rect reads to one batch per frame. `scrollend`
  // also releases the outline jump lock as soon as a jump scroll settles.
  editorScroller().addEventListener('scroll', scheduleOutlineActiveSync, { passive: true })
  sourceEl().addEventListener('scroll', scheduleOutlineActiveSync, { passive: true })
  editorScroller().addEventListener('scrollend', endOutlineJump)
  sourceEl().addEventListener('scrollend', endOutlineJump)
  // Anchor-link jumps start inside the editor; the phase signal engages the
  // same jump lock the outline clicks use, so the highlight cannot be stolen
  // by sections passed along the way (review on #68).
  onEditorJumpPhase((phase) => (phase === 'start' ? beginOutlineJump() : endOutlineJump()))

  api.onSiblingsChanged((files) => {
    // 根条目相同也可能有子目录变化，刷新已展开目录并保留未变节点。
    siblingsRequestVersion++
    void filePanel.replaceRoot(files)
  })
  updatePanelVisibility()

  api.onMenuOpen(async () => {
    // 'file-opened' event drives the content load (and file-panel refresh)
    await enqueueDocumentOperation(() => api.openFile())
  })

  api.onMenuSave(() => { if (!windowClosePreparing) void saveCurrent() })
  api.onMenuSaveAs(() => { if (!windowClosePreparing) void saveCurrent(true) })
  api.onMenuExportPDF(() => api.exportPDF())
  api.onMenuExportHTML(() => { void exportCurrentHTML() })
  api.onMenuExportDOCX(async () => {
    // Diagrams are drawn again for the page rather than reused from the screen
    // (src/renderer/editor/mermaid-export.ts), so this awaits a render per
    // diagram before the save dialog opens.
    const payload = await markdownForWord(getContent(), isChinese())
    await api.exportDOCX(payload)
  })
  api.onMenuExportImage((preset) => { void exportCurrentImage(preset) })
  api.onMenuPlaySlideshow(() => { void toggleSlideshow() })

  api.onNewFile(() => {
    exitSourceMode()
    ensureTab()
    applyContent('')
    scheduleOutlineUpdate()
    renderTabBar()
  })
  api.onFileOpened((data) => {
    void enqueueDocumentOperation(async () => { applyOpenedFile({ ...data, fileUrl: data.fileUrl ?? null }) })
  })
  api.onFileChanged((content, path) => {
    if (windowClosePreparing) { changesDuringClose.add(path); return }
    if (path !== currentFilePath) return
    applyExternalContent(content)
  })

  // 热更新共用同一条载入路径，取消退出后的补读也遵守未保存冲突规则。
  function applyExternalContent(content: string): void {
    if (dirty) {
      raiseExternalConflict()
      return
    }
    // 重建编辑器状态会重新布局；热更新保留阅读位置，不把视口拉回旧光标。
    const scrollSnapshot = sourceModeActive ? null : getEditorView()?.scrollSnapshot()
    const sourceScrollTop = sourceEl().scrollTop
    const body = takeFrontmatter(content)
    if (sourceModeActive) {
      sourceEl().value = body
    } else {
      // An external write is not something the reader can undo into; making it
      // one undo step would also let a stray undo write stale content back.
      setMarkdownProgrammatically(body, true)
    }
    navigation?.reloaded()
    if (sourceModeActive) sourceEl().scrollTop = sourceScrollTop
    else if (scrollSnapshot) getEditorView()?.dispatch({ effects: scrollSnapshot })
    updateSourceToggle()
    updateWordCount()
    resetDirty()
    scheduleOutlineUpdate()
  }

  api.onSetTheme((theme) => applyWindowTheme(theme))
  api.onThemeDefinitionsChanged((definitions) => {
    const active = getCurrentThemeDefinition()
    setThemeDefinitions(definitions)
    const updated = getThemeDefinitions().find(theme => theme.id === active.id)
    if (JSON.stringify(updated) !== JSON.stringify(active)) applyWindowTheme(active.id)
  })
  api.onMenuThemeSettings(() => showThemeSettingsPanel())
  document.addEventListener('theme-saved', (event) => {
    const theme = (event as CustomEvent<ThemeDefinition>).detail
    registerThemeDefinition(theme)
    applyWindowTheme(theme.id)
  })

  api.onSetPageWidth((width) => applyPageWidth(width))

  // macOS takes the traffic lights away in full screen, so the row drops the 96px
  // they sit in. The main process owns the window state and reports it here, both
  // on the transitions and once at startup for a window restored into full screen.
  api.onFullscreenChange((isFullscreen) => {
    document.body.classList.toggle('fullscreen', isFullscreen)
  })

  // The row's own menu button. Windows hides the menu bar (autoHideMenuBar) so the
  // shell is one row; this button pops the same native menu, which keeps the menu
  // itself identical on every platform.
  document.getElementById('app-menu-btn')?.addEventListener('click', () => void api.popupAppMenu())
  api.onLanguageChanged((language: UiLanguage) => {
    setUiLanguage(language)
    searchPanel.setLanguage(language)
    updateUiLanguage()
    // Tab labels and the close tooltip are built in the current language.
    renderTabBar()
  })
  api.onExternalConflictResult((result) => {
    externalConflictPending = false
    if (result.action === 'load' && typeof result.content === 'string') {
      applyContent(result.content)
      navigation?.reloaded()
      resetDirty()
      updateWordCount()
      scheduleOutlineUpdate()
      if (typeof result.recoveryPath === 'string') showRecoveryHint(result.recoveryPath)
    } else {
      // Keep mine: resume autosave; the next save overwrites the external edit.
      showSaveStatus('dirty')
      if (dirty) scheduleAutosave()
    }
  })
  api.onOpenFontSettings(() => showFontSettingsModal())
  api.onEditorFontChanged((prefs) => applyEditorFont(prefs.family || prefs.size ? prefs : null))
  api.onSetCustomCSS((css) => {
    const theme = loadSavedTheme()
    applyWindowTheme(theme, css)
  })

  api.onMenuImportTheme(async () => {
    // 同一导入入口提供草稿和本地化错误，不自动覆盖已保存主题。
    showThemeSettingsPanel()
    document.querySelector<HTMLButtonElement>("[data-theme-action='import']")?.click()
  })

  // --- Auto update banner (weak, non-blocking) ---
  // 2.7.0 换了编辑器内核，用户点「更新」之前就该知道这次不是普通修复。
  // 只给需要提前打招呼的版本写一句，没登记的版本保持原样。
  const UPDATE_NOTES: Record<string, { zh: string; en: string }> = {
    '2.7.0': { zh: '这次换了编辑器内核', en: 'new editor core' },
    '2.7.1-beta.1': { zh: '选中一段不再翻成源码', en: 'selections stay rendered' },
    '2.7.3': { zh: '本地链接能跳了', en: 'local links navigate' }
  }
  let updateDownloaded = false
  function showUpdateBanner(version: string): void {
    const zh = isChinese()
    const note = UPDATE_NOTES[version]
    const suffix = note ? ` · ${zh ? note.zh : note.en}` : ''
    updateBannerTextEl().textContent = updateDownloaded
      ? (zh ? `新版本 v${version} 已就绪${suffix}` : `Update v${version} is ready${suffix}`)
      : (zh ? `发现新版本 v${version}${suffix}` : `Update v${version} available${suffix}`)
    updateBannerActionEl().textContent = updateDownloaded ? (zh ? '重启安装' : 'Restart') : (zh ? '更新' : 'Update')
    updateBannerActionEl().disabled = false
    updateBannerEl().hidden = false
  }

  api.onUpdateAvailable((version) => {
    updateDownloaded = false
    showUpdateBanner(version)
  })
  api.onUpdateDownloaded((version) => {
    updateDownloaded = true
    showUpdateBanner(version)
  })
  api.onUpdateProgress((percent) => {
    if (updateDownloaded) return
    updateBannerActionEl().textContent = isChinese() ? `下载中 ${percent}%` : `Downloading ${percent}%`
  })
  api.onUpdateError(() => {
    if (updateDownloaded) return
    updateBannerActionEl().textContent = isChinese() ? '下载失败，点击重试' : 'Failed, retry'
    updateBannerActionEl().disabled = false
  })

  updateBannerActionEl().addEventListener('click', async () => {
    if (updateDownloaded) {
      await api.installUpdate()
    } else {
      updateBannerActionEl().textContent = isChinese() ? '下载中…' : 'Downloading…'
      updateBannerActionEl().disabled = true
      try {
        await api.downloadUpdate()
      } catch {
        // The 'update-error' event may already have reset the label; this
        // catch covers the path where the IPC call itself rejects.
        updateBannerActionEl().textContent = isChinese() ? '下载失败，点击重试' : 'Failed, retry'
        updateBannerActionEl().disabled = false
      }
    }
  })
  document.getElementById('update-banner-dismiss')!.addEventListener('click', () => {
    updateBannerEl().hidden = true
  })

  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const filePath = api.getPathForFile(file)
    if (!filePath) return
    const result = await api.openFilePath(filePath)
    // 'file-opened' event drives the content load when opened into this window
    void result
  })
  // 必要监听、标签和导航都已安装；目录读取不阻塞正文交付。
  api.reportRendererReady()
  void refreshSiblings()
}

// Errors after init leave no trace in a packaged app either. Same log, and the
// same error is written once per session so a render loop cannot fill the disk.
const reportedErrors = new Set<string>()
function reportRuntimeError(where: string, err: unknown): void {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const key = text.slice(0, 300)
  if (reportedErrors.has(key) || reportedErrors.size >= 50) return
  reportedErrors.add(key)
  console.error(`ColaMD ${where}:`, err)
  void window.electronAPI.logRendererError(`[${where}] ${text}`)
}
window.addEventListener('error', (event) => reportRuntimeError('error', event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => reportRuntimeError('unhandledrejection', event.reason))

// A packaged app has no console: without the IPC copy of this, a renderer that
// dies during init leaves nothing behind but a white window (#126).
init().catch((e) => {
  console.error('ColaMD init failed:', e)
  void window.electronAPI.logRendererError(e instanceof Error ? (e.stack ?? e.message) : String(e))
})
