/** 左右侧栏独立保存视图偏好，内容类型不决定停靠位置。 */
export type SidebarSide = 'left' | 'right'

/** 两侧均可选择文件列表或文档大纲。 */
export type SidebarContent = 'files' | 'outline'

/** 一侧的用户偏好；临时适配窄窗口的显示宽度不写入此处。 */
export interface SidebarPreference {
  /** 当前显示的内容。 */
  content: SidebarContent
  /** 用户选择的显隐状态。 */
  visible: boolean
  /** 用户保存的宽度，单位为 CSS 像素。 */
  width: number
}

/** 同一窗口内左右两侧的完整视图偏好。 */
export type SidebarPreferences = Record<SidebarSide, SidebarPreference>
