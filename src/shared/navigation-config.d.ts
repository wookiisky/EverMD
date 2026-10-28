/** 当前窗口历史可用状态，由渲染层拥有，主进程只同步菜单。 */
export interface NavigationMenuState {
  /** 是否可以退到上一个位置。 */
  canGoBack: boolean
  /** 是否可以前进到下一个位置。 */
  canGoForward: boolean
}

/** 文件读取或已有标签恢复的结果；失败时不改变当前文件。 */
export type NavigationFileResult = {
  /** 目标文件已经成功绑定到当前窗口。 */
  status: 'ok'
  /** 目标文件的完整路径。 */
  path: string
  /** 从磁盘读取的原始文本。 */
  content: string
  /** 相对资源解析所需的文件 URL。 */
  fileUrl: string
  /** 本次读取时的文件修改时间。 */
  mtime: number
} | {
  /** 磁盘文件缺失，已绑定路径，由已有标签恢复内存内容。 */
  status: 'cached'
  /** 已有标签的文件路径，保留普通保存及另存为的身份。 */
  path: string
  /** 内存文档中相对资源的解析基准。 */
  fileUrl: string
} | {
  /** 只有确认不存在才移除历史；其他失败保留历史。 */
  status: 'missing' | 'error'
}
