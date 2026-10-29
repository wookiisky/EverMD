import definitions from './builtin-themes.json'
import type { ThemeColorKey, ThemeDefinition, ThemeSyntaxKey, ThemeTextKind, ThemeTextStyle, ThemeTypography } from './theme-config'

/** 配色表的字段和 CSS 变量是一一对应的稳定契约。 */
export const THEME_COLOR_FIELDS: readonly { key: ThemeColorKey; variable: string }[] = [
  { key: 'bg', variable: '--bg-color' }, { key: 'text', variable: '--text-color' },
  { key: 'textSecondary', variable: '--text-secondary' }, { key: 'textMuted', variable: '--text-muted' },
  { key: 'border', variable: '--border-color' }, { key: 'link', variable: '--link-color' },
  { key: 'inlineCodeBackground', variable: '--code-bg' }, { key: 'codeBlockBackground', variable: '--code-block-bg' },
  { key: 'codeBlockText', variable: '--code-block-text' }, { key: 'quoteBorder', variable: '--blockquote-border' },
  { key: 'quoteBackground', variable: '--blockquote-bg' }, { key: 'tableHeaderBackground', variable: '--table-header-bg' },
  { key: 'tableBorder', variable: '--table-border' }, { key: 'selection', variable: '--selection-bg' },
  { key: 'highlight', variable: '--highlight-bg' }, { key: 'chromeBackground', variable: '--chrome-bg' },
  { key: 'sidebarBackground', variable: '--sidebar-bg' }, { key: 'controlHover', variable: '--chrome-bg-hover' },
  { key: 'icon', variable: '--row-icon-color' }, { key: 'shellLine', variable: '--shell-line' },
  { key: 'cursor', variable: '--theme-cursor' }, { key: 'searchMatch', variable: '--search-match-bg' },
  { key: 'searchCurrent', variable: '--search-match-current-bg' }
]

/** 顺序同时决定面板顺序及序列化顺序。 */
export const THEME_TEXT_KINDS: readonly ThemeTextKind[] = [
  'paragraph', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
  'strong', 'emphasis', 'strikethrough', 'link', 'linkUrl', 'quote', 'list', 'inlineCode',
  'codeBlock', 'tableHeader', 'tableCell', 'highlight', 'horizontalRule'
]

/** 代码配色与现有语法高亮消费的变量对应。 */
export const THEME_SYNTAX_FIELDS: readonly { key: ThemeSyntaxKey; variable: string }[] = [
  { key: 'keyword', variable: '--code-keyword' }, { key: 'string', variable: '--code-string' },
  { key: 'comment', variable: '--code-comment' }, { key: 'number', variable: '--code-number' },
  { key: 'function', variable: '--code-function' }, { key: 'type', variable: '--code-type' },
  { key: 'property', variable: '--code-property' }, { key: 'meta', variable: '--code-meta' }
]

// 结构化边线的方向是主题契约，迁移和生成 CSS 必须使用同一映射。
export function getThemeBorderPrefix(kind: ThemeTextKind): string {
  if (kind === 'quote') return 'border-left'
  if (kind === 'horizontalRule') return 'border-top'
  if (kind.startsWith('heading') || kind === 'tableHeader') return 'border-bottom'
  return 'border'
}

/** 错误携带字段路径和原因，展示文案由调用者的语言配置提供。 */
export class ThemeValidationError extends Error {
  /** 错误所在的配置字段。 */ readonly path: string
  /** 可本地化的错误类别。 */ readonly code: 'type' | 'value' | 'unknown' | 'version'
  // 字段与类别作为数据返回，不在配置层拼用户文案。
  constructor(path: string, code: ThemeValidationError['code']) {
    super(`Invalid theme field ${path}: ${code}`)
    this.name = 'ThemeValidationError'
    this.path = path
    this.code = code
  }
}

// 只接收普通映射，避免数组和空值被当作配置对象。
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ThemeValidationError(path, 'type')
  return value as Record<string, unknown>
}

// 未知字段不静默丢弃，防止拼写错误导入后看起来成功。
function knownKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ThemeValidationError(path ? `${path}.${key}` : key, 'unknown')
}

// 在共享层约束单条 CSS 值；浏览器层还会用 CSS.supports 验证具体颜色语义。
export function isThemeColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500 || /[;{}<>@\\]|\/\*|url\s*\(|expression\s*\(/i.test(value)) return false
  const color = value.trim()
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return true
  if (/^(?:transparent|currentColor|inherit)$/i.test(color)) return true
  if (CSS_COLOR_NAMES.has(color.toLowerCase())) return true
  if (!/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var)\(/i.test(color)) return false
  let depth = 0
  for (const char of color) {
    if (char === '(') depth++
    if (char === ')' && --depth < 0) return false
  }
  if (depth !== 0 || !color.endsWith(')')) return false
  // 常用颜色函数在主进程也检查通道，避免导入 rgb(拼写错误) 后静默失效。
  const channels = color.match(/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(([^()]*)\)$/i)
  if (channels) {
    const parts = channels[2].trim().split(/[\s,/]+/)
    return (parts.length === 3 || parts.length === 4)
      && parts.every(part => /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:%|deg|grad|rad|turn)?|none)$/i.test(part))
  }
  return true
}

// CSS 的具名颜色是格式标准中的有限枚举，旧主题可以合法使用这些值。
const CSS_COLOR_NAMES = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
  + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki '
  + 'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet '
  + 'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow '
  + 'grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow '
  + 'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen '
  + 'linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '
  + 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen '
  + 'paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown '
  + 'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white '
  + 'whitesmoke yellow yellowgreen').split(' '))

// 排版数字的范围是文件格式契约，NaN 和无限数都不进入 CSS。
function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number') throw new ThemeValidationError(path, 'type')
  if (!Number.isFinite(value) || value < min || value > max) throw new ThemeValidationError(path, 'value')
  return value
}

// 枚举值逐项验证，防止无效声明在浏览器里静默失效。
function choice<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new ThemeValidationError(path, 'value')
  return value as T
}

// 颜色表只允许预先声明的主题字段。
function colors<K extends string>(input: unknown, keys: readonly K[], path: string): Partial<Record<K, string>> {
  const source = object(input ?? {}, path)
  knownKeys(source, keys, path)
  const result: Partial<Record<K, string>> = {}
  for (const key of keys) {
    if (source[key] === undefined) continue
    if (!isThemeColor(source[key])) throw new ThemeValidationError(`${path}.${key}`, 'value')
    result[key] = (source[key] as string).trim()
  }
  return result
}

const STYLE_KEYS: readonly (keyof ThemeTextStyle)[] = ['color', 'background', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration',
  'borderColor', 'borderWidth', 'borderStyle', 'spacingBefore', 'spacingAfter', 'textAlign', 'letterSpacing', 'paddingLeft', 'paddingRight', 'opacity', 'sideBorders']

// 样式值按字段类型验证，输出顺序保持稳定。
function textStyle(input: unknown, path: string): ThemeTextStyle {
  const source = object(input, path)
  knownKeys(source, STYLE_KEYS, path)
  const result: ThemeTextStyle = {}
  for (const key of STYLE_KEYS) {
    const value = source[key]
    if (value === undefined) continue
    const field = `${path}.${key}`
    switch (key) {
      case 'color': case 'background': case 'borderColor':
        if (!isThemeColor(value)) throw new ThemeValidationError(field, 'value')
        result[key] = value.trim(); break
      case 'fontSize': result[key] = number(value, field, 0.25, 8); break
      case 'fontWeight': result[key] = number(value, field, 100, 900); break
      case 'fontStyle': result[key] = choice(value, field, ['normal', 'italic'] as const); break
      case 'textDecoration': result[key] = choice(value, field, ['none', 'underline', 'line-through'] as const); break
      case 'borderStyle': result[key] = choice(value, field, ['none', 'solid', 'dashed', 'dotted'] as const); break
      case 'textAlign': result[key] = choice(value, field, ['left', 'center', 'right'] as const); break
      case 'opacity': result[key] = number(value, field, 0, 1); break
      case 'letterSpacing': result[key] = number(value, field, -0.2, 2); break
      case 'borderWidth': result[key] = number(value, field, 0, 12); break
      case 'paddingLeft': case 'paddingRight': result[key] = number(value, field, 0, 160); break
      case 'spacingBefore': case 'spacingAfter': result[key] = number(value, field, 0, 12); break
      case 'sideBorders':
        if (typeof value !== 'boolean') throw new ThemeValidationError(field, 'type')
        result[key] = value; break
    }
  }
  return result
}

// 基础排版与 Markdown 分类样式分开，段内行高不会隐式写入段间距。
function typography(input: unknown): ThemeTypography {
  const source = object(input ?? {}, 'typography')
  const keys: readonly (keyof ThemeTypography)[] = ['fontFamily', 'codeFontFamily', 'fontSize', 'codeFontSize', 'lineHeight', 'paragraphSpacing', 'baseLineHeight']
  knownKeys(source, keys, 'typography')
  const result: ThemeTypography = {}
  for (const key of keys) {
    const value = source[key]
    if (value === undefined) continue
    const field = `typography.${key}`
    if (key === 'fontFamily' || key === 'codeFontFamily') {
      if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[;{}<>@\\]|\/\*/.test(value)) throw new ThemeValidationError(field, 'value')
      result[key] = value.trim()
    } else if (key === 'fontSize' || key === 'codeFontSize') result[key] = number(value, field, 8, 72)
    else if (key === 'paragraphSpacing') result[key] = number(value, field, 0, 8)
    else result[key] = number(value, field, 0.8, 4)
  }
  return result
}

// 导入、持久化与面板保存共用一次规范化校验。
export function validateThemeDefinition(input: unknown): ThemeDefinition {
  const source = object(input, '')
  knownKeys(source, ['version', 'id', 'name', 'appearance', 'colors', 'typography', 'styles', 'syntax', 'extensions'], '')
  if (source.version !== 1) throw new ThemeValidationError('version', 'version')
  if (typeof source.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(source.id)) throw new ThemeValidationError('id', 'value')
  if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 120) throw new ThemeValidationError('name', 'value')
  const styles = object(source.styles ?? {}, 'styles')
  knownKeys(styles, THEME_TEXT_KINDS, 'styles')
  const parsedStyles: ThemeDefinition['styles'] = {}
  for (const key of THEME_TEXT_KINDS) if (styles[key] !== undefined) parsedStyles[key] = textStyle(styles[key], `styles.${key}`)
  const result: ThemeDefinition = {
    version: 1, id: source.id, name: source.name.trim(), appearance: choice(source.appearance, 'appearance', ['light', 'dark']),
    colors: colors(source.colors, THEME_COLOR_FIELDS.map(field => field.key), 'colors'),
    typography: typography(source.typography), styles: parsedStyles,
    syntax: colors(source.syntax, THEME_SYNTAX_FIELDS.map(field => field.key), 'syntax')
  }
  if (source.extensions !== undefined) {
    const extension = object(source.extensions, 'extensions')
    knownKeys(extension, ['css'], 'extensions')
    if (extension.css !== undefined && typeof extension.css !== 'string') throw new ThemeValidationError('extensions.css', 'type')
    result.extensions = extension.css === undefined ? {} : { css: extension.css as string }
  }
  return result
}

/** 所有内置主题和用户主题经过同一校验，数据文件是唯一配方来源。 */
export const BUILTIN_THEMES: readonly ThemeDefinition[] = definitions.map(validateThemeDefinition)

// 深拷贝防止表单草稿修改共享的内置配方。
export function cloneTheme(theme: ThemeDefinition): ThemeDefinition {
  return JSON.parse(JSON.stringify(theme)) as ThemeDefinition
}

// 内置原版始终作为独立副本交给调用者。
export function getBuiltinTheme(id: string): ThemeDefinition | undefined {
  const theme = BUILTIN_THEMES.find(item => item.id === id)
  return theme ? cloneTheme(theme) : undefined
}
