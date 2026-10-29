import type { ThemeDefinition, ThemeTextKind, ThemeTextStyle } from '../../shared/theme-config'
import { cloneTheme, getThemeBorderPrefix, THEME_COLOR_FIELDS, THEME_SYNTAX_FIELDS, validateThemeDefinition } from '../../shared/theme-definition'

/** 旧选择器中已知的 Markdown 语义，其余选择器保存在兼容 CSS 中。 */
const legacyKinds: Record<string, ThemeTextKind> = {
  'cm-content': 'paragraph', 'cm-md-strong': 'strong', 'cm-md-em': 'emphasis',
  'cm-md-strike': 'strikethrough', 'cm-md-link': 'link', 'cm-md-url': 'linkUrl',
  'cm-md-blockquote': 'quote', 'cm-md-li': 'list', 'cm-md-inlinecode': 'inlineCode',
  'cm-md-codeblock': 'codeBlock', 'cm-md-highlight': 'highlight', 'cm-md-hr': 'horizontalRule'
}

// 提取可表达的简单声明，保留原 CSS 处理媒体查询、复合选择器和其他布局。
export function migrateLegacyTheme(original: ThemeDefinition): ThemeDefinition {
  if (!original.extensions?.css) return cloneTheme(original)
  const theme = cloneTheme(original)
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(original.extensions.css)
  // 条件规则的有效值依赖窗口和媒体，不能压平成永久覆盖。
  if (Array.from(sheet.cssRules).some(rule => !(rule instanceof CSSStyleRule))) return theme
  let opaqueSelector = false
  const candidates = new Map<string, { value: unknown; conflicting: boolean }>()
  const collect = (path: string, value: unknown): void => {
    const previous = candidates.get(path)
    candidates.set(path, { value, conflicting: Boolean(previous?.conflicting || (previous && previous.value !== value)) })
  }
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule)) continue
    if (rule.selectorText.split(',').some(s => /^(:root|body|body\.theme-custom)$/.test(s.trim()))) {
      for (const field of THEME_COLOR_FIELDS) {
        const value = rule.style.getPropertyValue(field.variable).trim()
        if (value) collect(`colors.${field.key}`, value)
      }
      for (const field of THEME_SYNTAX_FIELDS) {
        const value = rule.style.getPropertyValue(field.variable).trim()
        if (value) collect(`syntax.${field.key}`, value)
      }
    }
    for (const selector of rule.selectorText.split(',')) {
      // 仅认明确的简单钩子；嵌套、伪类、属性选择器等继续由原规则负责。
      const clean = selector.trim().replace(/^#editor\s+/, '').replace(/^body(?:\.theme-custom)?\s+/, '')
      let kind: ThemeTextKind | undefined
      const heading = clean.match(/^(?:\.cm-content\s+)?\.cm-md-atxheading([1-6])$/)
      if (heading) kind = `heading${heading[1]}` as ThemeTextKind
      else if (/^\.cm-content\s+\.cm-md-table-widget\s+(th|td)$/.test(clean)) {
        kind = clean.endsWith('th') ? 'tableHeader' : 'tableCell'
      } else {
        const simple = clean.match(/^(?:\.cm-content\s+)?\.([\w-]+)$/)
        if (simple) kind = legacyKinds[simple[1]]
      }
      if (!kind) {
        if (!/^(:root|body|body\.theme-custom)$/.test(selector.trim())) opaqueSelector = true
        continue
      }
      const converted: ThemeTextStyle = {}
      // 只提取该类型能够原样表达的边；其他方向留给兼容 CSS。
      const border = getThemeBorderPrefix(kind)
      const strings = { color: 'color', background: 'background-color', fontStyle: 'font-style',
        textDecoration: 'text-decoration-line', borderColor: `${border}-color`,
        borderStyle: `${border}-style`, textAlign: 'text-align' } as const
      for (const [property, css] of Object.entries(strings)) {
        const value = rule.style.getPropertyValue(css)
        if (value) Object.assign(converted, { [property]: value })
      }
      const weight = rule.style.fontWeight
      if (/^\d+$/.test(weight)) converted.fontWeight = Number(weight)
      const size = rule.style.fontSize.match(/^([\d.]+)em$/)
      if (size) converted.fontSize = Number(size[1])
      for (const [property, css] of Object.entries({ paddingLeft: 'padding-left', paddingRight: 'padding-right', borderWidth: `${border}-width` })) {
        const value = rule.style.getPropertyValue(css).match(/^([\d.]+)px$/)
        if (value) Object.assign(converted, { [property]: Number(value[1]) })
      }
      if (kind === 'paragraph') {
        if (rule.style.fontFamily) collect('typography.fontFamily', rule.style.fontFamily)
        const sizePx = rule.style.fontSize.match(/^([\d.]+)px$/)
        if (sizePx) collect('typography.fontSize', Number(sizePx[1]))
        const line = rule.style.lineHeight
        if (/^[\d.]+$/.test(line)) collect('typography.baseLineHeight', Number(line))
        // 容器字号和内边距不能再次写到每个段落，否则 em 倍率和留白会叠加。
        continue
      }
      for (const [key, value] of Object.entries(converted)) collect(`styles.${kind}.${key}`, value)
    }
  }
  // 未知选择器可能参与同一属性的层叠；保留原 CSS 比猜测其最终结果可靠。
  if (opaqueSelector) return theme
  for (const [path, candidate] of candidates) {
    if (candidate.conflicting) continue
    const next = cloneTheme(theme)
    let record = next as unknown as Record<string, unknown>
    const keys = path.split('.')
    for (const key of keys.slice(0, -1)) {
      record[key] ??= {}
      record = record[key] as Record<string, unknown>
    }
    if (record[keys.at(-1)!] !== undefined) continue
    record[keys.at(-1)!] = candidate.value
    try {
      // 浏览器合法但文件格式无法表达的值留在原 CSS，不能阻断编辑器初始化。
      const valid = validateThemeDefinition(next)
      Object.assign(theme, valid)
    } catch { /* 兼容 CSS 继续负责该声明。 */ }
  }
  return theme
}
