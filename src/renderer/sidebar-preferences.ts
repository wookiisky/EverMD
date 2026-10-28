import type { SidebarPreferences, SidebarPreference, SidebarSide } from '../shared/sidebar-config'

export const SIDEBAR_STORAGE_KEY = 'colamd-sidebars'
export const SIDEBAR_SIDES: readonly SidebarSide[] = ['left', 'right']
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 420
const DEFAULT_WIDTH = 220
const MIN_EDITOR_WIDTH = 320

// 宽度偏好限制在常规范围；窄窗口的临时显示宽度单独计算。
export function clampSidebarWidth(width: number): number {
  return Number.isFinite(width) ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width))) : DEFAULT_WIDTH
}

// 单侧恢复失败只回退这一侧，避免坏配置抹掉另一侧选择。
function readSide(value: unknown, fallback: SidebarPreference): SidebarPreference {
  if (!value || typeof value !== 'object') return { ...fallback }
  const stored = value as Partial<SidebarPreference>
  return {
    content: stored.content === 'files' || stored.content === 'outline' ? stored.content : fallback.content,
    visible: typeof stored.visible === 'boolean' ? stored.visible : fallback.visible,
    width: typeof stored.width === 'number' ? clampSidebarWidth(stored.width) : fallback.width
  }
}

// 首次使用沿用旧面板的显隐与宽度到左侧；新配置写入后不再依赖旧键。
export function loadSidebarPreferences(storage: Pick<Storage, 'getItem'>): SidebarPreferences {
  const defaults: SidebarPreferences = {
    left: { content: 'files', visible: storage.getItem('file-panel-hidden') === '0', width: clampSidebarWidth(Number.parseInt(storage.getItem('file-panel-width') ?? '', 10)) },
    right: { content: 'outline', visible: false, width: DEFAULT_WIDTH }
  }
  let stored: Partial<SidebarPreferences> | null = null
  try { stored = JSON.parse(storage.getItem(SIDEBAR_STORAGE_KEY) ?? 'null') } catch { /* 配置损坏时使用可恢复的默认值。 */ }
  return { left: readSide(stored?.left, defaults.left), right: readSide(stored?.right, defaults.right) }
}

// 两侧按偏好比例分配空间，临时缩小不回写用户宽度，也不自动关闭侧栏。
export function sidebarWidths(preferences: SidebarPreferences, windowWidth: number): Record<SidebarSide, number> {
  const left = preferences.left.visible ? preferences.left.width : 0
  const right = preferences.right.visible ? preferences.right.width : 0
  const total = left + right
  const available = Math.max(0, windowWidth - MIN_EDITOR_WIDTH)
  const scale = total > available ? available / total : 1
  return { left: left * scale, right: right * scale }
}
