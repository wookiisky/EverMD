import type { SiblingFile } from '../preload/index'

/** 展开目录后的平面行，视图不再负责触发目录读取。 */
export interface FilePanelRow {
  /** 当前条目，空目录提示使用所属目录。 */
  file: SiblingFile
  /** 相对根目录的缩进层数。 */
  depth: number
  /** 目录有展开按钮，返回和文件没有。 */
  expandable: boolean
  /** 用户的展开状态。 */
  expanded: boolean
  /** 成功读取后确认目录没有子项。 */
  empty: boolean
}

/** 每次目录请求绑定刷新版本，同一轮只读同一目录一次。 */
interface DirectoryRequest {
  /** 开始请求时的刷新版本。 */
  version: number
  /** 可被展开动作和刷新轮次共享的读取任务。 */
  promise: Promise<void>
}

/** 文件列表数据；根列表刷新与展开读取使用同一套失效规则。 */
export class FilePanelModel {
  /** 当前根列表。 */
  private root: readonly SiblingFile[] = []
  /** 只保留当前树中可达目录的已读内容。 */
  private readonly children = new Map<string, readonly SiblingFile[]>()
  /** 展开偏好不随同目录刷新消失。 */
  private readonly expanded = new Set<string>()
  /** 在途读取按目录合并，旧轮次结果不会覆盖新数据。 */
  private readonly requests = new Map<string, DirectoryRequest>()
  /** 新根列表或同目录刷新均开启一个新版本。 */
  private version = 0

  // 读取失败保留已有数据；界面更新由调用方按帧合并。
  constructor(
    private readonly readDirectory: (path: string) => Promise<readonly SiblingFile[] | null>,
    private readonly changed: () => void,
  ) {}

  // 替换根列表后并行刷新可见的已展开目录，下一层由新结果决定。
  async replaceRoot(files: readonly SiblingFile[]): Promise<void> {
    const version = ++this.version
    this.root = files
    const retained = new Set<string>()
    const visit = (entries: readonly SiblingFile[]): void => {
      for (const entry of entries) {
        if (entry.kind !== 'directory') continue
        retained.add(entry.path)
        const children = this.children.get(entry.path)
        if (children) visit(children)
      }
    }
    visit(files)
    for (const path of this.children.keys()) if (!retained.has(path)) this.children.delete(path)
    this.changed()
    await this.refreshExpanded(files, version)
  }

  // 展开时刷新重新可见的后代，收起不取消其他目录的刷新。
  toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else {
      this.expanded.add(path)
      const version = this.version
      const directory = this.rows().find(row => row.file.path === path && row.expandable)?.file
      if (!directory) return
      void this.refreshExpanded([directory], version)
    }
    this.changed()
  }

  // 展平数据不读盘，也不把未读取或读取失败的目录当成空目录。
  rows(): FilePanelRow[] {
    const rows: FilePanelRow[] = []
    const walk = (entries: readonly SiblingFile[], depth: number): void => {
      for (const file of entries) {
        const expanded = file.kind === 'directory' && this.expanded.has(file.path)
        rows.push({ file, depth, expandable: file.kind === 'directory', expanded, empty: false })
        if (!expanded) continue
        const children = this.children.get(file.path)
        if (!children) continue
        if (children.length === 0) rows.push({ file, depth: depth + 1, expandable: false, expanded: false, empty: true })
        else walk(children, depth + 1)
      }
    }
    walk(this.root, 0)
    return rows
  }

  // 同层目录并行读取，后代以父目录的新结果为准，不把折叠期间的缓存当成最新数据。
  private async refreshExpanded(entries: readonly SiblingFile[], version: number): Promise<void> {
    await Promise.all(entries.filter(entry => entry.kind === 'directory' && this.expanded.has(entry.path))
      .map(async entry => {
        if (version !== this.version || !this.expanded.has(entry.path)) return
        await this.load(entry.path, version)
        if (version === this.version && this.expanded.has(entry.path)) {
          await this.refreshExpanded(this.children.get(entry.path) ?? [], version)
        }
      }))
  }

  // 同轮共享读取，乱序和目录切换通过版本过滤；单目录失败独立处理。
  private load(path: string, version: number): Promise<void> {
    const existing = this.requests.get(path)
    if (existing?.version === version) return existing.promise
    const request: DirectoryRequest = { version, promise: Promise.resolve() }
    this.requests.set(path, request)
    request.promise = (async () => {
      try {
        const entries = await this.readDirectory(path)
        if (version === this.version && entries !== null) {
          this.children.set(path, entries)
          // 每个目录独立发布，慢兄弟目录不能阻塞已完成的结果；外壳仍按帧合并绘制。
          this.changed()
        }
      } catch {
        // 不清除已有内容，也不显示错误的空目录提示。
      } finally {
        if (this.requests.get(path) === request) this.requests.delete(path)
      }
    })()
    return request.promise
  }
}
