import type { EditorView } from '@codemirror/view'

/** 文档身份：有路径时以路径为准，未命名文档才使用标签标识。 */
export interface NavigationIdentity {
  /** 文件的完整路径；未命名文档为 null。 */
  filePath: string | null
  /** 所在标签，仅作为有路径文档的查找提示。 */
  tabId: string
}

/** 阅读视口的参考行及其屏幕偏移，与编辑光标独立。 */
export interface NavigationViewport {
  /** 参考位置的 UTF-16 偏移，编辑时随正文映射。 */
  from: number
  /** 参考位置的源码行，重载时按行列夹限。 */
  line: number
  /** 参考位置在行内的偏移。 */
  column: number
  /** 参考行或渲染块顶部相对视口顶部的像素偏移，可为负数。 */
  offset: number
  /** 渲染模式的原生滚动效果，仅含位置与偏移，不持有旧正文。 */
  snapshot?: ReturnType<EditorView['scrollSnapshot']>
}

/** 一次导航的位置，不持有正文或编辑器的撤销状态。 */
export interface NavigationAnchor extends NavigationIdentity {
  /** 主选区固定端的 UTF-16 偏移。 */
  anchor: number
  /** 主选区活动端的 UTF-16 偏移。 */
  head: number
  /** 活动端所在的源码行，从 1 开始。 */
  line: number
  /** 活动端在行内的 UTF-16 偏移，从 0 开始。 */
  column: number
  /** 固定端所在的源码行，从 1 开始。 */
  anchorLine: number
  /** 固定端在行内的 UTF-16 偏移，从 0 开始。 */
  anchorColumn: number
  /** 活动光标在可见正文中的纵向比例。 */
  viewportFraction: number
  /** 离开前测得的阅读位置；未测量的光标跳转沿用光标定位。 */
  viewport?: NavigationViewport
}

/** 后退为 -1，前进为 1。 */
export type NavigationDirection = -1 | 1

/** 每个停留区保存精确落点和固定比较基准，微小移动不会推走基准。 */
interface NavigationEntry {
  /** 最近一次实际落点，供回放恢复。 */
  position: NavigationAnchor
  /** 首次采纳的位置，供累计移动比较。 */
  baseline: NavigationAnchor
}

/** 对有路径文档忽略标签变化，同一标签装入另一文件则是不同文档。 */
export function sameNavigationDocument(a: NavigationIdentity, b: NavigationIdentity): boolean {
  return a.filePath !== null || b.filePath !== null
    ? a.filePath === b.filePath
    : a.tabId === b.tabId
}

/** 行距和字符距离都很小时，仍属于同一个停留区。 */
function nearby(a: NavigationAnchor, b: NavigationAnchor): boolean {
  return sameNavigationDocument(a, b) && Math.abs(a.line - b.line) < 5 && Math.abs(a.head - b.head) < 80
}

/** 选区和阅读参考都按值传递，调用者不能修改历史内部的位置。 */
function copyAnchor(position: NavigationAnchor): NavigationAnchor {
  return { ...position, viewport: position.viewport && { ...position.viewport } }
}

/** 当前窗口的有限导航历史；文件切换和成功判定由外壳负责。 */
export class NavigationHistory {
  /** 按访问顺序保存的位置，最多 100 条，包含当前位置。 */
  private entries: NavigationEntry[] = []
  /** 当前回放位置，空历史为 -1。 */
  private index = -1
  /** 普通光标移动的最后一个候选。 */
  private pending: NavigationAnchor | null = null
  /** 连续移动结束后再记录，避免把经过的位置写入历史。 */
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 正在打开的目标记录；删除其他记录不会改变它的身份。 */
  private replayEntry: NavigationEntry | null = null
  /** 状态变化时通知外壳更新菜单。 */
  private readonly onChange: () => void

  /** 创建一份不持久化的窗口历史。 */
  constructor(onChange: () => void = () => {}) {
    this.onChange = onChange
  }

  /** 当前实际位置的副本。 */
  get current(): NavigationAnchor | null {
    const entry = this.entries[this.index]
    return entry ? copyAnchor(entry.position) : null
  }

  /** 已保留的位置总数，包括前进分支。 */
  get size(): number { return this.entries.length }

  /** 是否还有更早的位置。 */
  get canGoBack(): boolean { return this.index > 0 }

  /** 是否还有可恢复的前进位置。 */
  get canGoForward(): boolean { return this.index >= 0 && this.index < this.entries.length - 1 }

  /** 立即采纳位置；只有有效新位置会截断前进分支。 */
  record(position: NavigationAnchor): boolean {
    this.cancelPending()
    const current = this.entries[this.index]
    if (current && nearby(current.baseline, position)) {
      current.position = copyAnchor(position)
      return false
    }
    this.entries.splice(this.index + 1)
    this.entries.push({ position: copyAnchor(position), baseline: copyAnchor(position) })
    if (this.entries.length > 100) this.entries.shift()
    this.index = this.entries.length - 1
    this.onChange()
    return true
  }

  /** 将普通光标移动合并为停止 500ms 后的一次记录。 */
  schedule(position: NavigationAnchor): void {
    if (this.pending && !sameNavigationDocument(this.pending, position)) this.flush()
    if (!this.current || !sameNavigationDocument(this.current, position)) {
      this.record(position)
      return
    }
    this.cancelPending()
    this.pending = copyAnchor(position)
    this.timer = setTimeout(() => this.flush(), 500)
  }

  /** 离开文档或开始回放前收妥尚未停稳的位置。 */
  flush(): boolean {
    const pending = this.pending
    this.cancelPending()
    return pending ? this.record(pending) : false
  }

  /** 输入、程序化恢复和销毁不应把旧候选变成导航记录。 */
  cancelPending(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  /** 更新当前落点；输入后可重置比较基准，避免把输入长度误算成导航距离。 */
  updateCurrent(position: NavigationAnchor, resetBaseline = false): void {
    const entry = this.entries[this.index]
    if (!entry || !sameNavigationDocument(entry.position, position)) return
    entry.position = copyAnchor(position)
    if (resetBaseline) entry.baseline = copyAnchor(position)
  }

  /** 只查看下一目标；打开失败或取消时无需回滚历史。 */
  peek(direction: NavigationDirection): NavigationAnchor | null {
    const entry = this.entries[this.index + direction]
    return entry ? copyAnchor(entry.position) : null
  }

  /** 开始一次回放，固定记录本身，允许打开过程中映射位置或移除当前项。 */
  beginReplay(direction: NavigationDirection): NavigationAnchor | null {
    this.replayEntry = this.entries[this.index + direction] ?? null
    return this.replayTarget
  }

  /** 读取目标的最新位置；外部重载可能已经按新正文映射它。 */
  get replayTarget(): NavigationAnchor | null {
    return this.replayEntry ? copyAnchor(this.replayEntry.position) : null
  }

  /** 按固定目标提交，目标成为当前项后不再重复向前或向后移动。 */
  commitReplay(): boolean {
    const index = this.replayEntry ? this.entries.indexOf(this.replayEntry) : -1
    this.endReplay()
    if (index < 0) return false
    this.cancelPending()
    this.index = index
    this.onChange()
    return true
  }

  /** 成功、取消或失败后释放本次回放目标。 */
  endReplay(): void { this.replayEntry = null }

  /** 外壳确认目标已成功打开并定位后，才推进历史指针。 */
  commit(direction: NavigationDirection): boolean {
    this.beginReplay(direction)
    return this.commitReplay()
  }

  /** 移除确认已不存在的文件，避免失效记录堵住更早位置。 */
  removeFile(filePath: string): void {
    this.remove(position => position.filePath === filePath)
  }

  /** 未命名文档关闭后无法重开，只移除该标签的无路径记录。 */
  removeUntitled(tabId: string): void {
    this.remove(position => position.filePath === null && position.tabId === tabId)
  }

  /** 另存为只迁移这份文档，不误改同一标签以前装过的文件。 */
  renameDocument(previous: NavigationIdentity, next: NavigationIdentity): void {
    this.updateDocument(previous, position => ({ ...position, ...next }))
  }

  /** 编辑时同步映射历史位置、固定基准和候选，不创建导航步骤。 */
  updateDocument(identity: NavigationIdentity, map: (position: NavigationAnchor) => NavigationAnchor): void {
    for (const entry of this.entries) {
      if (!sameNavigationDocument(entry.position, identity)) continue
      entry.position = copyAnchor(map(copyAnchor(entry.position)))
      entry.baseline = copyAnchor(map(copyAnchor(entry.baseline)))
    }
    if (this.pending && sameNavigationDocument(this.pending, identity)) this.pending = copyAnchor(map(copyAnchor(this.pending)))
  }

  /** 取消定时任务，释放窗口关闭后不再需要的候选。 */
  dispose(): void { this.cancelPending(); this.endReplay() }

  /** 删除记录时尽量保留当前项；当前项被删则退到最近的前项。 */
  private remove(matches: (position: NavigationAnchor) => boolean): void {
    if (this.pending && matches(this.pending)) this.cancelPending()
    const remaining: NavigationEntry[] = []
    let index = -1
    this.entries.forEach((entry, originalIndex) => {
      if (matches(entry.position)) {
        if (this.replayEntry === entry) this.endReplay()
        return
      }
      const previous = remaining[remaining.length - 1]
      // A → 已删除文件 → A 收拢后不留下两次相同停留；当前项的精确落点优先。
      if (previous && nearby(previous.baseline, entry.baseline)) {
        if (originalIndex <= this.index) previous.position = entry.position
        if (this.replayEntry === entry) this.replayEntry = previous
      } else remaining.push(entry)
      if (originalIndex <= this.index) index = remaining.length - 1
    })
    if (remaining.length === this.entries.length) return
    this.entries = remaining
    this.index = remaining.length ? Math.max(0, index) : -1
    this.onChange()
  }
}
