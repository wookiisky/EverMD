import type { FilePanelRow } from './file-panel-model'
import type { UiLanguage } from './ui-language'
import labels from '../shared/file-panel-labels.json'
import { FilePanelWindow, type FilePanelDimensions } from './file-panel-window'

/** 一行的固定元素；更新文件信息时保留按钮和它的焦点。 */
interface FilePanelEntry {
  /** 插入列表的容器。 */
  element: HTMLLIElement
  /** 空目录提示没有按钮。 */
  button: HTMLButtonElement | null
  /** 文件名或空目录文案。 */
  label: HTMLElement
  /** 目录展开图标，空目录提示没有图标。 */
  chevron: HTMLElement | null
  /** 上一次用于显示的状态，避免重复写属性。 */
  signature: string
}

/** 每侧独立维护挂载范围和滚动，完整文件数据仍由模型提供。 */
interface FilePanelList {
  /** 原有列表及其滚动容器。 */
  list: HTMLElement
  /** 所属侧栏，左右互不共享滚动。 */
  panel: HTMLElement
  /** 仅保留当前挂载的节点。 */
  entries: Map<string, FilePanelEntry>
  /** 最近一轮完整行数据。 */
  rows: readonly FilePanelRow[]
  /** 路径身份对应当前逻辑索引。 */
  indices: Map<string, number>
  /** 当前活动文件只影响选中样式。 */
  activePath: string | null
  /** 当前界面语言。 */
  language: UiLanguage
  /** 大目录才使用位置索引，小目录保持原生流布局。 */
  window: FilePanelWindow | null
  /** 尺寸改变后重新测量三种行。 */
  measureNeeded: boolean
  /** 最近一轮真实行尺寸。 */
  dimensions: FilePanelDimensions | null
  /** 合并滚动与尺寸事件的帧。 */
  frame: number | null
  /** 侧栏宽高变化时重算范围。 */
  observer: ResizeObserver
  /** 销毁时统一解除事件委托和滚动监听。 */
  events: AbortController
  /** 代表行对应的预期高度，主题改变字体或内边距时使几何失效。 */
  samples: Map<HTMLElement, number>
}

// 小目录无需额外几何管理；超过此规模时节点数量由视口决定。
const VIRTUAL_ROW_THRESHOLD = 200

// 空目录提示与所属目录是两个不同节点。
function rowKey(row: FilePanelRow): string {
  return `${row.empty ? 'empty' : row.file.kind}:${row.file.path}`
}

/** 每侧列表独立复用节点；文件数据由 FilePanelModel 管理。 */
export class FilePanelView {
  /** 窗口内只有两侧列表；隐藏时暂停绘制，重新显示复用已挂载节点。 */
  private readonly lists = new Map<HTMLElement, FilePanelList>()

  // 提示仍使用外壳已有的延时和定位规则。
  constructor(
    private readonly showTip: (button: HTMLElement, label: string, side: 'left' | 'right') => void,
    private readonly hideTip: () => void,
  ) {}

  // 同路径的行保留节点；按实际顺序插入变化项，不重复移动未变化的行。
  render(lists: readonly HTMLElement[], rows: readonly FilePanelRow[], activePath: string | null, language: UiLanguage): void {
    for (const list of lists) {
      const state = this.lists.get(list) ?? this.attach(list)
      const focused = this.focusedKey(state)
      const previousFocus = focused === null ? -1 : state.indices.get(focused) ?? -1
      // 保持当前首行在刷新后的相对位置，新增文件不会让正在浏览的位置跳动。
      const top = this.viewportTop(state)
      const first = state.window?.range(top, 1, 0).from
      const anchor = first === undefined ? null : state.rows[first]
      const anchorOffset = first === undefined ? 0 : top - state.window!.top(first)
      state.rows = rows
      state.indices = new Map(rows.map((row, index) => [rowKey(row), index]))
      state.activePath = activePath
      if (state.language !== language || rows.some(row => row.empty && !state.dimensions?.empty.has(row.depth))) {
        state.measureNeeded = true
      }
      state.language = language
      this.layout(state)
      if (anchor && state.window) {
        const index = state.indices.get(rowKey(anchor))
        if (index !== undefined) state.panel.scrollTop += state.window.top(index) + anchorOffset - top
      }
      let nextFocus: number | undefined
      if (focused !== null && !state.indices.has(focused)) {
        nextFocus = this.buttonIndex(state, Math.min(previousFocus, rows.length - 1), -1)
        if (nextFocus === undefined) nextFocus = this.buttonIndex(state, 0, 1)
      }
      this.draw(state, nextFocus)
      if (nextFocus !== undefined) this.focusRow(state, nextFocus)
      else if (focused !== null && state.indices.has(focused) && this.focusedKey(state) !== focused) {
        // 数据重新排序可能移动原节点；浏览器会因此丢焦点，恢复到同一条目。
        state.entries.get(focused)?.button?.focus({ preventScroll: true })
      } else if (focused !== null && !state.indices.has(focused)) {
        document.getElementById(`${state.panel.id}-toggle`)?.focus({ preventScroll: true })
      }
    }
  }

  // 主题切换可能只改变 gap 而不改变元素外框，由外壳明确使几何失效。
  refreshGeometry(): void {
    for (const state of this.lists.values()) {
      state.measureNeeded = true
      this.schedule(state)
    }
  }

  // 视图卸载时解除观察；正常窗口中实例与侧栏同寿命。
  dispose(): void {
    for (const state of this.lists.values()) {
      state.observer.disconnect()
      state.events.abort()
      if (state.frame !== null) cancelAnimationFrame(state.frame)
    }
    this.lists.clear()
  }

  // 列表委托保留原生点击和右键行为，只接管虚拟范围之间的 Tab 移动。
  private attach(list: HTMLElement): FilePanelList {
    const panel = list.closest<HTMLElement>('.sidebar')!
    const state: FilePanelList = { list, panel, entries: new Map(), rows: [], indices: new Map(),
      activePath: null, language: 'zh', window: null, measureNeeded: true, dimensions: null, frame: null,
      observer: new ResizeObserver(entries => {
        const changed = entries.some(entry => entry.target === panel || Math.abs(entry.borderBoxSize[0].blockSize
          - (state.samples.get(entry.target as HTMLElement) ?? 0)) > 0.01)
        if (changed) { state.measureNeeded = true; this.schedule(state) }
      }), events: new AbortController(), samples: new Map() }
    this.lists.set(list, state)
    state.observer.observe(panel)
    const signal = state.events.signal
    panel.addEventListener('scroll', () => this.schedule(state), { passive: true, signal })
    list.addEventListener('keydown', event => {
      if (!state.window || event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return
      const key = this.focusedKey(state)
      const index = key === null ? undefined : state.indices.get(key)
      if (index === undefined) return
      const direction = event.shiftKey ? -1 : 1
      const next = this.buttonIndex(state, index + direction, direction)
      if (next === undefined) return // 两端继续沿原生 Tab 顺序离开列表。
      event.preventDefault()
      this.focusRow(state, next)
    }, { signal })
    list.addEventListener('focusin', () => this.schedule(state), { signal })
    list.addEventListener('focusout', () => this.schedule(state), { signal })
    return state
  }

  // 隐藏或显示大纲时不读取文件列表几何，重新 render 时会补齐最新数据。
  private schedule(state: FilePanelList): void {
    if (state.frame !== null) return
    state.frame = requestAnimationFrame(() => {
      state.frame = null
      if (!state.list.isConnected || state.list.hidden || state.panel.getAttribute('aria-hidden') === 'true') return
      if (state.measureNeeded) this.layout(state)
      this.draw(state)
    })
  }

  // 空提示按每种实际缩进测量换行高度，父目录外边距和列表间距也计入位置。
  private measure(state: FilePanelList): FilePanelDimensions {
    const sample = state.rows[0]
    const probe = document.createElement('ul')
    probe.className = 'file-list file-panel-measure'
    probe.setAttribute('aria-hidden', 'true')
    const normal = { ...sample, depth: 0, empty: false, file: { ...sample.file, kind: 'file' as const } }
    const emptyRows = new Map<number, FilePanelRow>()
    for (const row of state.rows) if (row.empty) emptyRows.set(row.depth, row)
    const rows = [normal, { ...normal, file: { ...normal.file, kind: 'parent' as const } }, ...emptyRows.values()]
    for (const row of rows) {
      const entry = this.create(row, probe)
      this.update(entry, row, null, state.language)
      probe.append(entry.element)
    }
    state.panel.append(probe)
    const heights = Array.from(probe.children, child => child.getBoundingClientRect().height)
    const gap = Number.parseFloat(getComputedStyle(state.list).rowGap) || 0
    probe.remove()
    const empty = new Map(Array.from(emptyRows.keys(), (depth, index) => [depth, heights[index + 2]]))
    return { normal: heights[0], parent: heights[1], empty, gap }
  }

  // 小列表仍按原生流排版；大列表的总高度保留完整滚动范围。
  private layout(state: FilePanelList): void {
    const virtual = state.rows.length > VIRTUAL_ROW_THRESHOLD
    if (virtual && (state.measureNeeded || !state.dimensions)) state.dimensions = this.measure(state)
    state.measureNeeded = false
    state.window = virtual ? new FilePanelWindow(state.rows, state.dimensions!) : null
    state.list.classList.toggle('file-list-virtual', virtual)
    state.list.style.height = state.window ? `${state.window.height}px` : ''
  }

  // 列表起点扣除侧栏标题和内边距，滚动坐标不假定列表紧贴面板顶部。
  private viewportTop(state: FilePanelList): number {
    return state.panel.getBoundingClientRect().top + state.panel.clientTop - state.list.getBoundingClientRect().top
  }

  // 焦点行和两端入口始终挂载，保持原生 Tab 进入顺序与滚动后的键盘操作。
  private draw(state: FilePanelList, extraIndex?: number): void {
    const { list, rows, entries, window } = state
    const range = window ? window.range(this.viewportTop(state), state.panel.clientHeight, state.panel.clientHeight)
      : { from: 0, to: rows.length }
    const indices = new Set<number>()
    for (let index = range.from; index < range.to; index++) indices.add(index)
    if (window) {
      const first = this.buttonIndex(state, 0, 1)
      const last = this.buttonIndex(state, rows.length - 1, -1)
      const focused = this.focusedKey(state)
      const focusIndex = focused === null ? undefined : state.indices.get(focused)
      for (const index of [first, last, focusIndex, extraIndex]) if (index !== undefined) indices.add(index)
    }
    const ordered = Array.from(indices).sort((left, right) => left - right)
    const retained = new Set(ordered.map(index => rowKey(rows[index])))
    // 先移除离开范围的行，避免把仍有焦点的节点 insertBefore 到它们前面而丢焦点。
    for (const [key, entry] of entries) {
      if (retained.has(key)) continue
      this.hideTip()
      entry.element.remove()
      entries.delete(key)
    }
    let cursor = list.firstElementChild
    for (const index of ordered) {
      const row = rows[index]
      const key = rowKey(row)
      let entry = entries.get(key)
      if (!entry) {
        entry = this.create(row, list)
        entries.set(key, entry)
      }
      const signature = JSON.stringify([row.file.name, row.depth, row.expanded, state.language, row.file.path === state.activePath])
      if (entry.signature !== signature) {
        this.update(entry, row, state.activePath, state.language)
        entry.signature = signature
      }
      entry.element.style.top = window ? `${window.top(index)}px` : ''
      entry.element.setAttribute('aria-posinset', String(index + 1))
      entry.element.setAttribute('aria-setsize', String(rows.length))
      if (entry.element === cursor) cursor = cursor.nextElementSibling
      else list.insertBefore(entry.element, cursor)
    }
    const samples = new Map<HTMLElement, number>()
    const kinds = new Set<string>()
    if (window) for (const index of ordered) {
      const row = rows[index]
      const kind = row.empty ? `empty:${row.depth}` : row.file.kind === 'parent' ? 'parent' : 'normal'
      if (kinds.has(kind)) continue
      kinds.add(kind)
      const dimensions = state.dimensions!
      const height = row.empty ? dimensions.empty.get(row.depth)! : row.file.kind === 'parent' ? dimensions.parent : dimensions.normal
      samples.set(entries.get(rowKey(row))!.element, height)
    }
    for (const element of state.samples.keys()) if (!samples.has(element)) state.observer.unobserve(element)
    for (const element of samples.keys()) if (!state.samples.has(element)) state.observer.observe(element)
    state.samples = samples
  }

  // 只记录本列表内部的按钮焦点，另一侧和正文不参与挂载策略。
  private focusedKey(state: FilePanelList): string | null {
    const button = document.activeElement as HTMLElement | null
    if (!button || !state.list.contains(button) || !button.dataset.path) return null
    return `${button.dataset.kind}:${button.dataset.path}`
  }

  // 空目录提示不可聚焦，键盘遍历跳过它。
  private buttonIndex(state: FilePanelList, index: number, direction: number): number | undefined {
    for (; index >= 0 && index < state.rows.length; index += direction) if (!state.rows[index].empty) return index
    return undefined
  }

  // 先让目标进入挂载范围，再把原生焦点交给它。
  private focusRow(state: FilePanelList, index: number): void {
    if (state.window) {
      const top = state.window.top(index)
      const height = state.window.top(index + 1) - top
      const viewport = this.viewportTop(state)
      if (top < viewport) state.panel.scrollTop += top - viewport
      else if (top + height > viewport + state.panel.clientHeight) {
        state.panel.scrollTop += top + height - viewport - state.panel.clientHeight
      }
    }
    this.draw(state, index)
    state.entries.get(rowKey(state.rows[index]))?.button?.focus({ preventScroll: true })
  }

  // 固定图标与监听只创建一次，提示从当前标签文字读取。
  private create(row: FilePanelRow, list: HTMLElement): FilePanelEntry {
    const element = document.createElement('li')
    if (row.empty) {
      const label = document.createElement('div')
      label.className = 'file-empty'
      element.append(label)
      return { element, label, button: null, chevron: null, signature: '' }
    }
    const button = document.createElement('button')
    const chevron = document.createElement('span')
    chevron.setAttribute('aria-hidden', 'true')
    if (row.file.kind === 'parent') chevron.innerHTML = '<svg viewBox="0 0 10 10"><path d="M8.5 5H2M4.5 2.5 2 5l2.5 2.5"/></svg>'
    else if (row.expandable) chevron.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3.5 1.5 7 5l-3.5 3.5"/></svg>'
    const icon = document.createElement('span')
    icon.className = `file-entry-icon ${row.file.kind}`
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = row.file.kind === 'directory'
      ? '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h6v6.5h-11.5z"/><path d="M2.5 4.5v-1h4l1.5 1.5"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'
    const label = document.createElement('span')
    label.className = 'file-entry-name'
    button.addEventListener('mouseenter', () => {
      if (label.scrollWidth <= label.clientWidth + 1) return
      const side = list.closest<HTMLElement>('.sidebar')?.id === 'right-sidebar' ? 'left' : 'right'
      this.showTip(button, label.textContent ?? '', side)
    })
    button.addEventListener('mouseleave', this.hideTip)
    button.dataset.path = row.file.path
    button.dataset.kind = row.file.kind
    button.classList.toggle('directory', row.file.kind === 'directory')
    button.classList.toggle('parent', row.file.kind === 'parent')
    if (row.file.kind === 'parent') button.append(chevron, label)
    else button.append(chevron, icon, label)
    element.append(button)
    return { element, button, label, chevron, signature: '' }
  }

  // 只改显示状态，不替换文件按钮或重绑事件。
  private update(entry: FilePanelEntry, row: FilePanelRow, activePath: string | null, language: UiLanguage): void {
    const text = labels[language]
    const indent = `${8 + row.depth * 12}px`
    if (!entry.button) {
      entry.label.style.paddingLeft = indent
      entry.label.textContent = text.empty
      return
    }
    const button = entry.button
    button.style.paddingLeft = indent
    entry.chevron!.className = `file-entry-chevron${row.expanded ? ' expanded' : ''}${row.file.kind === 'parent' ? ' back' : ''}`
    const name = row.file.kind === 'parent' ? text.back : row.file.name
    if (entry.label.textContent !== name) entry.label.textContent = name
    button.title = row.file.kind === 'directory'
      ? text[row.expanded ? 'collapse' : 'expand'].replace('{name}', row.file.name)
      : row.file.kind === 'parent' ? text.parent : row.file.name
    button.classList.toggle('active', row.file.path === activePath)
  }
}
