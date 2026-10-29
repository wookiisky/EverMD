import { BUILTIN_THEMES, cloneTheme, getBuiltinTheme } from '../../shared/theme-definition'
import type { ThemeDefinition } from '../../shared/theme-config'
import { applyThemeToDocument } from './theme-document'
import { migrateLegacyTheme } from './theme-legacy-migration'

/** 每个窗口单独选择主题，定义由主进程同步。 */
let definitions: ThemeDefinition[] = []
let currentTheme: ThemeDefinition | null = null
const libraryListeners = new Set<() => void>()

// 内置主题和用户定制通过同一种配置参与查找。
export function getThemeDefinitions(): ThemeDefinition[] {
  const combined = new Map(BUILTIN_THEMES.map(theme => [theme.id, theme]))
  for (const theme of definitions) combined.set(theme.id, theme)
  return Array.from(combined.values(), cloneTheme)
}

// 库更新只替换定义，是否刷新当前窗口由外壳决定。
export function setThemeDefinitions(next: ThemeDefinition[]): void {
  definitions = next.map(migrateLegacyTheme)
  for (const listener of libraryListeners) listener()
}

// 成功保存后立即接入返回值，避免等待广播期间回退到旧配置。
export function registerThemeDefinition(theme: ThemeDefinition): void {
  definitions = [...definitions.filter(item => item.id !== theme.id), migrateLegacyTheme(theme)]
}

// 面板观察外部修改，但不覆盖正在编辑的草稿。
export function onThemeLibraryChanged(listener: () => void): () => void {
  libraryListeners.add(listener)
  return () => libraryListeners.delete(listener)
}

// 返回副本，面板编辑不能修改正在使用的配置。
export function getCurrentThemeDefinition(): ThemeDefinition {
  return cloneTheme(currentTheme ?? getBuiltinTheme('elegant')!)
}

// 所有来源都编译为同一份主题样式；customCSS 只兼容旧调用和旧验收入口。
export function applyTheme(name: string, customCSS?: string): void {
  // 兼容旧版的两段 IPC：先收到文件标识时保留现有画面，收到 CSS 后再统一编译。
  if (name.startsWith('custom:') && customCSS === undefined) {
    localStorage.setItem('colamd-theme', name)
    return
  }
  let definition = getThemeDefinitions().find(theme => theme.id === name)
  if (customCSS !== undefined) {
    definition = migrateLegacyTheme({ version: 1, id: 'legacy-preview', name,
      appearance: 'light', colors: {}, typography: {}, styles: {}, syntax: {}, extensions: { css: customCSS } })
  }
  definition ??= getBuiltinTheme('elegant')!
  currentTheme = cloneTheme(definition)
  applyThemeToDocument(document, definition)

  // Persist theme choice
  localStorage.setItem('colamd-theme', customCSS !== undefined ? name : definition.id)

  // Tell the main process so the theme menu can show the selected state
  window.electronAPI?.reportTheme?.(customCSS !== undefined ? name : definition.id)

  // …and hand it the resolved shell colours. Windows paints the window controls
  // inside our own row (titleBarOverlay), and that overlay has to be told a real
  // colour: the chrome surface and the row icons' grey, read off the live computed
  // style so a custom theme works the same as a built-in one.
  const bar = document.getElementById('titlebar')
  if (bar) {
    const surface = getComputedStyle(bar).backgroundColor
    // The OS draws its three glyphs, and they have to sit at the same weight as
    // our four: the platform wants one SOLID colour, while the row's icons are a
    // translucent mix over the chrome, so composite it the way the browser would
    // before handing it over.
    //
    // Both values go over as plain #rrggbb, because the platform parses no CSS
    // Color 4: Chromium hands us `color(srgb 0.1 0.1 0.1)`, Windows rejected the
    // whole overlay call, and the buttons kept the colours from window creation on
    // every theme — including a light strip on a black row (real Windows test,
    // 2026-09-15). Painting each colour onto a canvas and reading the pixel back
    // gives the platform the one string it understands.
    const iconEl = document.getElementById('left-sidebar-toggle') ?? document.body
    const icon = getComputedStyle(iconEl).color
    const surfaceHex = painted(surface, '#ffffff')
    window.electronAPI?.reportTitlebarColors?.({ background: surfaceHex, symbol: painted(icon, surfaceHex) })
  }
}

// Resolve a colour to #rrggbb, as painted over an opaque one: a translucent value
// is composited exactly the way the browser would, and any CSS colour syntax the
// canvas understands (the platform understands fewer) comes back as hex.
function painted(color: string, background: string): string {
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return color
    ctx.fillStyle = background
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${hex(r)}${hex(g)}${hex(b)}`
  } catch {
    // An unparseable colour keeps the caller's value rather than turning the
    // window controls invisible.
    return color
  }
}

// 恢复时先保留标识，库加载后由 applyTheme 处理缺失文件。
export function loadSavedTheme(): string {
  return localStorage.getItem('colamd-theme') || 'elegant'
}
