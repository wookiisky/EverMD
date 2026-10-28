import { Text } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { getEditorHandle, onEditorUpdate } from './editor/core'
import { sourcePositionTop } from './editor/source-line'
import { SourceInputEvent } from './editor/editor-source-input'
import { NavigationHistory, type NavigationAnchor, type NavigationDirection, type NavigationIdentity } from './navigation-history'

/** 文件切换由外壳负责，控制器只记录和恢复位置。 */
export interface EditorNavigationOptions {
  /** 当前文档身份，路径优先于可复用的标签编号。 */
  getIdentity(): NavigationIdentity | null
  /** 当前是否使用源码文本框。 */
  isSourceMode(): boolean
  /** 源码模式的原生文本框。 */
  source: HTMLTextAreaElement
  /** 外壳正在执行程序化载入或模式切换。 */
  isProgrammatic(): boolean
  /** 成功返回前，目标文档必须已经装入编辑器。 */
  open(anchor: NavigationAnchor): Promise<'ok' | 'missing' | 'cancelled'>
  /** 历史可用状态发生变化时同步菜单。 */
  onStateChange?(state: { canGoBack: boolean; canGoForward: boolean }): void
}

/** 把位置限制在当前文本内，并保存不依赖渲染排版的行列。 */
function withPositions(anchor: NavigationAnchor, doc: Text, from: number, head: number): NavigationAnchor {
  from = Math.max(0, Math.min(from, doc.length))
  head = Math.max(0, Math.min(head, doc.length))
  const start = doc.lineAt(from)
  const end = doc.lineAt(head)
  return { ...anchor, anchor: from, head, anchorLine: start.number, anchorColumn: from - start.from,
    line: end.number, column: head - end.from }
}

/** 文件重载后按行列尽力定位，不把旧内容带回编辑器。 */
function atLine(doc: Text, line: number, column: number): number {
  const target = doc.line(Math.max(1, Math.min(line, doc.lines)))
  return Math.min(target.to, target.from + Math.max(0, column))
}

/** 编辑器位置历史；渲染与源码模式共享记录，纯滚动不订阅。 */
export class EditorNavigation {
  /** 有界历史及去重、防抖策略。 */
  private readonly history: NavigationHistory
  /** 当前观察器的解除函数。 */
  private unsubscribe: (() => void) | null = null
  /** 程序化选区恢复期间的嵌套抑制深度。 */
  private suppressed = 0
  /** 回放期间阻止文件和选区观察器产生新历史。 */
  private replaying = false
  /** 连续前进后退按请求顺序执行。 */
  private queue: Promise<void> = Promise.resolve()
  /** 只缓存当前文本框内容，供一次输入的偏移映射使用。 */
  private sourceText = ''
  /** 最后已观察选区，过滤异步 select 事件与重复通知。 */
  private observed: NavigationAnchor | null = null
  /** 注销后不再执行排队动作。 */
  private disposed = false

  /** 绑定文档适配器，不在构造时读取尚未创建的编辑器。 */
  constructor(private readonly options: EditorNavigationOptions) {
    this.history = new NavigationHistory(() => {
      this.options.onStateChange?.({ canGoBack: this.history.canGoBack, canGoForward: this.history.canGoForward })
    })
  }

  /** 编辑器和首个标签就绪后开始观察。 */
  initialize(): void {
    this.unsubscribe = onEditorUpdate(update => this.editorUpdated(update))
    this.options.source.addEventListener('select', this.sourceSelected)
    this.options.source.addEventListener('selectionchange', this.sourceSelected)
    this.options.source.addEventListener('input', this.sourceChanged)
    this.afterSwitch()
  }

  /** 切换前提交尚未停稳的目标并刷新实际离开位置。 */
  beforeSwitch(): void {
    if (this.replaying) return
    // 原生 select 可能还在事件队列中，先观察一次当前选区。
    if (this.options.isSourceMode()) this.selected()
    this.history.flush()
    const anchor = this.capture(true)
    if (anchor) {
      if (this.history.current) this.history.updateCurrent(anchor)
      else this.history.record(anchor)
    }
  }

  /** 文件载入完成后记录一次切换，并同步异步选区事件的基线。 */
  afterSwitch(): void {
    this.synchronize()
    if (this.replaying || this.suppressed) return
    if (this.observed) {
      const current = this.history.current
      if (current && this.sameDocument(current, this.observed)) this.history.updateCurrent(this.observed)
      else this.history.record(this.observed)
    }
  }

  /** 模式切换只更新当前位置，不新增导航节点。 */
  withoutRecording(action: () => void): void {
    this.history.flush()
    this.suppressed++
    try { action() } finally {
      this.suppressed--
      this.synchronize()
      if (this.observed) this.history.updateCurrent(this.observed)
    }
  }

  /** 外部内容替换后重算行列并恢复当前位置，不恢复旧文档字节。 */
  reloaded(): void {
    this.history.cancelPending()
    const identity = this.options.getIdentity()
    if (!identity) return
    const doc = this.document()
    this.history.updateDocument(identity, anchor => withPositions(anchor, doc,
      atLine(doc, anchor.anchorLine, anchor.anchorColumn), atLine(doc, anchor.line, anchor.column)))
    if (!this.replaying) {
      const current = this.history.current
      if (current && this.sameDocument(current, identity)) this.restore(current, false)
    }
    this.synchronize()
  }

  /** 另存为只迁移当前文档对应的记录。 */
  renamed(previous: NavigationIdentity, next: NavigationIdentity): void {
    this.history.renameDocument(previous, next)
    this.synchronize()
  }

  /** 已保存文件可重开；无路径文档关闭后不能恢复。 */
  closed(tabId: string, filePath: string | null): void {
    if (filePath === null) this.history.removeUntitled(tabId)
  }

  /** 排队回放，失败不提交历史指针。 */
  navigate(direction: NavigationDirection): Promise<void> {
    const operation = this.queue.then(() => this.replay(direction))
    this.queue = operation.catch(() => { /* 一次读取失败不阻止下一次导航。 */ })
    return operation
  }

  /** 解除观察并取消尚未提交的位置。 */
  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.options.source.removeEventListener('select', this.sourceSelected)
    this.options.source.removeEventListener('selectionchange', this.sourceSelected)
    this.options.source.removeEventListener('input', this.sourceChanged)
    this.history.dispose()
  }

  /** 回放与程序化载入期间，事件只用于同步快照。 */
  private isSuppressed(): boolean {
    return this.disposed || this.replaying || this.suppressed > 0 || this.options.isProgrammatic()
  }

  /** 返回当前模式的文本，行号始终按源码计算。 */
  private document(): Text {
    return this.options.isSourceMode()
      ? Text.of(this.options.source.value.split('\n'))
      : getEditorHandle()!.getView().state.doc
  }

  /** 文件路径决定身份，无路径文档才按标签编号区分。 */
  private sameDocument(left: NavigationIdentity, right: NavigationIdentity): boolean {
    return left.filePath !== null || right.filePath !== null
      ? left.filePath === right.filePath
      : left.tabId === right.tabId
  }

  /** 读取主选区；更新回调内不测布局，避免 CodeMirror 禁止重入测量。 */
  private capture(measure = false): NavigationAnchor | null {
    const identity = this.options.getIdentity()
    const view = getEditorHandle()?.getView()
    if (!identity || !view) return null
    const source = this.options.source
    const sourceMode = this.options.isSourceMode()
    const backward = source.selectionDirection === 'backward'
    const anchor = sourceMode ? (backward ? source.selectionEnd : source.selectionStart) : view.state.selection.main.anchor
    const head = sourceMode ? (backward ? source.selectionStart : source.selectionEnd) : view.state.selection.main.head
    let viewportFraction = this.observed?.viewportFraction ?? 1 / 3
    if (measure) {
      const height = sourceMode ? source.clientHeight : view.scrollDOM.clientHeight
      const top = sourceMode ? sourcePositionTop(source, head) - source.scrollTop
        : (view.coordsAtPos(head)?.top ?? -1) - view.scrollDOM.getBoundingClientRect().top
      viewportFraction = height > 0 && top >= 0 && top < height ? top / height : 1 / 3
    }
    return withPositions({ ...identity, anchor, head, line: 1, column: 0, anchorLine: 1, anchorColumn: 0, viewportFraction },
      this.document(), anchor, head)
  }

  /** 同步程序化动作后的选区，避免延迟的原生事件误录历史。 */
  private synchronize(): void {
    this.sourceText = this.options.source.value
    this.observed = this.capture()
  }

  /** 只有实际选区变化才参与防抖。 */
  private selected(): void {
    const next = this.capture()
    if (!next) return
    const previous = this.observed
    this.observed = next
    if (this.isSuppressed()) return
    if (previous && this.sameDocument(previous, next) && previous.anchor === next.anchor && previous.head === next.head) return
    this.history.schedule(next)
  }

  /** 文本事务映射旧位置；普通选区事务才记录导航。 */
  private editorUpdated(update: ViewUpdate): void {
    if (this.options.isSourceMode()) return
    if (this.isSuppressed()) { this.synchronize(); return }
    if (update.docChanged) {
      const identity = this.options.getIdentity()
      this.history.cancelPending()
      if (identity) this.history.updateDocument(identity, anchor => withPositions(anchor, update.state.doc,
        update.changes.mapPos(anchor.anchor, 1), update.changes.mapPos(anchor.head, 1)))
      this.synchronize()
      if (this.observed) this.history.updateCurrent(this.observed, true)
    } else if (update.selectionSet) {
      if (update.transactions.some(transaction => transaction.isUserEvent('select.jump'))) this.history.flush()
      this.selected()
    }
  }

  /** 原生文本框的延迟选区事件按实际位置去重。 */
  private readonly sourceSelected = (): void => {
    if (this.options.isSourceMode()) this.selected()
  }

  /** 批量编辑使用真实变更；原生单处输入用公共前后缀映射。 */
  private readonly sourceChanged = (event: Event): void => {
    if (!this.options.isSourceMode()) return
    const value = this.options.source.value
    const previous = this.sourceText
    this.history.cancelPending()
    if (!this.isSuppressed()) {
      let start = 0
      while (start < previous.length && start < value.length && previous[start] === value[start]) start++
      let oldEnd = previous.length
      let newEnd = value.length
      while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd-- }
      const map = event instanceof SourceInputEvent
        ? (position: number) => event.changes.mapPos(position, 1)
        : (position: number) => position < start ? position : position >= oldEnd ? position + newEnd - oldEnd : newEnd
      const identity = this.options.getIdentity()
      const doc = this.document()
      if (identity) this.history.updateDocument(identity, anchor => withPositions(anchor, doc, map(anchor.anchor), map(anchor.head)))
      this.synchronize()
      if (this.observed) this.history.updateCurrent(this.observed, true)
    } else this.synchronize()
  }

  /** 主动回放才聚焦和滚动；热更新只恢复选区，保留用户正在使用的控件。 */
  private restore(anchor: NavigationAnchor, reveal = true): void {
    const doc = this.document()
    const from = atLine(doc, anchor.anchorLine, anchor.anchorColumn)
    const head = atLine(doc, anchor.line, anchor.column)
    const fraction = Math.max(0, Math.min(anchor.viewportFraction, 0.9))
    this.suppressed++
    try {
      if (this.options.isSourceMode()) {
        const source = this.options.source
        if (reveal) source.focus({ preventScroll: true })
        source.setSelectionRange(Math.min(from, head), Math.max(from, head), head < from ? 'backward' : 'forward')
        if (reveal) source.scrollTop = Math.max(0, sourcePositionTop(source, head) - source.clientHeight * fraction)
      } else {
        const view = getEditorHandle()!.getView()
        view.dispatch({ selection: { anchor: from, head }, effects: reveal ? EditorView.scrollIntoView(head,
          { y: 'start', yMargin: Math.max(24, view.scrollDOM.clientHeight * fraction) }) : undefined })
        if (reveal) view.focus()
      }
    } finally { this.suppressed--; this.synchronize() }
  }

  /** 缺失文件跳过，其余失败留在原处等待用户重试。 */
  private async replay(direction: NavigationDirection): Promise<void> {
    if (this.disposed) return
    this.beforeSwitch()
    this.replaying = true
    try {
      for (let target = this.history.beginReplay(direction); target; target = this.history.beginReplay(direction)) {
        const result = await this.options.open(target)
        if (this.disposed || result === 'cancelled') return
        if (result === 'missing') {
          if (target.filePath !== null) this.history.removeFile(target.filePath)
          else this.history.removeUntitled(target.tabId)
          continue
        }
        // 打开可能移除当前未命名记录；按原目标读取映射后的位置，不再依赖相邻索引。
        const currentTarget = this.history.replayTarget
        if (!currentTarget) return
        this.restore(currentTarget)
        this.history.commitReplay()
        if (this.observed) this.history.updateCurrent(this.observed)
        return
      }
    } finally { this.history.endReplay(); this.replaying = false; this.synchronize() }
  }
}
