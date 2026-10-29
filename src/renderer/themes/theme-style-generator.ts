import { getBuiltinTheme, getThemeBorderPrefix, THEME_COLOR_FIELDS, THEME_SYNTAX_FIELDS, validateThemeDefinition } from '../../shared/theme-definition'
import type { ThemeDefinition, ThemeTextKind, ThemeTextStyle } from '../../shared/theme-config'

const SCOPE = 'body.theme-configured'
const EDITOR = `${SCOPE} #editor .cm-content`
const DOCUMENT = `${SCOPE} .colamd-document`

/** 编辑器保留源码行结构，HTML 导出保留语义标签；两者共用一份配置。 */
const TARGETS: Record<ThemeTextKind, { editor: string[]; document: string[] }> = {
  paragraph: { editor: ['.cm-md-paragraph'], document: ['p'] },
  heading1: { editor: ['.cm-md-atxheading1'], document: ['h1'] },
  heading2: { editor: ['.cm-md-atxheading2'], document: ['h2'] },
  heading3: { editor: ['.cm-md-atxheading3'], document: ['h3'] },
  heading4: { editor: ['.cm-md-atxheading4'], document: ['h4'] },
  heading5: { editor: ['.cm-md-atxheading5'], document: ['h5'] },
  heading6: { editor: ['.cm-md-atxheading6'], document: ['h6'] },
  strong: { editor: ['.cm-md-strong', '.cm-md-table-widget strong', '.cm-md-table-widget b'], document: ['strong', 'b'] },
  emphasis: { editor: ['.cm-md-em', '.cm-md-table-widget em', '.cm-md-table-widget i'], document: ['em', 'i'] },
  strikethrough: { editor: ['.cm-md-strike', '.cm-md-table-widget s', '.cm-md-table-widget del'], document: ['s', 'del'] },
  link: { editor: ['.cm-md-link', '.cm-md-table-widget a[data-href]'], document: ['a'] },
  linkUrl: { editor: ['.cm-md-url'], document: [] },
  quote: { editor: ['.cm-md-blockquote:where(:not(.cm-md-codeblock))'], document: ['blockquote'] },
  list: { editor: ['.cm-md-li:where(:not(.cm-md-codeblock))'], document: ['li'] },
  inlineCode: { editor: ['.cm-md-inlinecode', '.cm-md-table-widget code'], document: [':not(pre) > code'] },
  codeBlock: { editor: ['.cm-md-codeblock'], document: ['pre'] },
  tableHeader: { editor: ['.cm-md-table-widget th'], document: ['th'] },
  tableCell: { editor: ['.cm-md-table-widget td'], document: ['td'] },
  highlight: { editor: ['.cm-md-highlight', '.cm-md-table-widget mark'], document: ['mark'] },
  horizontalRule: { editor: ['.cm-md-hr'], document: ['hr'] }
}

// 一个声明列表同时写入一组真实目标，省略空规则。
function rule(selectors: string[], declarations: string[]): string {
  return selectors.length && declarations.length ? `${selectors.join(',\n')} {\n  ${declarations.join('\n  ')}\n}\n` : ''
}

// 只转换显式值，通用 CSS 继续决定没有配置的属性。
function declarations(kind: ThemeTextKind, style: ThemeTextStyle, important: string): string[] {
  const result: string[] = []
  const add = (property: string, value: string | number): void => { result.push(`${property}: ${value}${important};`) }
  if (style.color !== undefined) add('color', style.color)
  if (style.background !== undefined && kind !== 'quote' && kind !== 'codeBlock') add('background-color', style.background)
  if (style.fontSize !== undefined) add('font-size', `${style.fontSize}em`)
  if (style.fontWeight !== undefined) add('font-weight', style.fontWeight)
  if (style.fontStyle !== undefined) add('font-style', style.fontStyle)
  if (style.textDecoration !== undefined) add('text-decoration', style.textDecoration)
  const prefix = getThemeBorderPrefix(kind)
  if (style.borderColor !== undefined) add(`${prefix}-color`, style.borderColor)
  if (style.borderWidth !== undefined) add(`${prefix}-width`, `${style.borderWidth}px`)
  if (style.borderStyle !== undefined) add(`${prefix}-style`, style.borderStyle)
  if (style.textAlign !== undefined) add('text-align', style.textAlign)
  if (style.letterSpacing !== undefined) add('letter-spacing', `${style.letterSpacing}em`)
  if (style.paddingLeft !== undefined) add('padding-left', `${style.paddingLeft}px`)
  if (style.paddingRight !== undefined) add('padding-right', `${style.paddingRight}px`)
  if (style.opacity !== undefined) add('opacity', style.opacity)
  if (style.sideBorders !== undefined) {
    add('border-left-style', style.sideBorders ? 'solid' : 'none')
    add('border-right-style', style.sideBorders ? 'solid' : 'none')
  }
  return result
}

// 在已知选择器上同时生成编辑器与独立 HTML 的样式。
function contentStyle(kind: ThemeTextKind, style: ThemeTextStyle, important: string): string {
  const targets = TARGETS[kind]
  const editor = targets.editor.map(selector => `${EDITOR} ${selector}`)
  const semantic = targets.document.map(selector => `${DOCUMENT} ${selector}`)
  let css = rule([...editor, ...semantic], declarations(kind, style, important))
  // 背景放在选区后方；直接给 CodeMirror 行涂色会盖住选中文字。
  if (style.background !== undefined && (kind === 'quote' || kind === 'codeBlock')) {
    css += rule(editor.map(selector => `${selector}::before`), [`background: ${style.background}${important};`])
    css += rule(semantic, [`background: ${style.background}${important};`])
  }
  if (kind === 'list') {
    // 标记是列表行的孩子，只继承行的字体；再写一份 em 字号会把倍率乘两次。
    const markerStyle: string[] = []
    if (style.color !== undefined) markerStyle.push(`color: inherit${important};`)
    if (style.fontSize !== undefined) markerStyle.push(`font-size: inherit${important};`)
    if (style.fontWeight !== undefined) markerStyle.push(`font-weight: inherit${important};`)
    if (style.fontStyle !== undefined) markerStyle.push(`font-style: inherit${important};`)
    css += rule([`${EDITOR} .cm-md-li-bullet`, `${EDITOR} .cm-md-li .cm-md-listmark`], markerStyle)
  }
  if (kind === 'codeBlock' && style.fontSize !== undefined) {
    // HTML 的 pre/code 有两层，代码文字使用 pre 已经计算过的字号。
    css += rule([`${DOCUMENT} pre > code`], [`font-size: inherit${important};`])
  }
  if ((kind === 'quote' || kind === 'list') && style.fontSize !== undefined) {
    // 编辑器的嵌套行是兄弟节点；HTML 的同类块嵌套也只应用一次字号倍率。
    const tag = kind === 'quote' ? 'blockquote' : 'li'
    css += rule([`${DOCUMENT} ${tag} ${tag}`], [`font-size: inherit${important};`])
  }
  const before = style.spacingBefore
  const after = style.spacingAfter
  const block = kind === 'quote' ? 'blockquote' : kind === 'codeBlock' ? 'codeblock' : kind === 'list' ? 'li' : kind === 'paragraph' ? 'paragraph' : null
  const first = block ? [`${EDITOR} .cm-md-${block}-first`] : editor
  const last = block ? [`${EDITOR} .cm-md-${block}-last`] : editor
  if (before !== undefined) css += rule(first, [`padding-top: ${before}em${important};`]) + rule(semantic, [`margin-top: ${before}em${important};`])
  if (after !== undefined) css += rule(last, [`padding-bottom: ${after}em${important};`]) + rule(semantic, [`margin-bottom: ${after}em${important};`])
  return css
}

// 结构化配置是唯一渲染入口；旧 CSS 先加载，显式配置在后覆盖支持的字段。
export function generateThemeCSS(input: ThemeDefinition): string {
  const theme = validateThemeDefinition(input)
  const important = theme.extensions?.css ? ' !important' : ''
  // 默认值留在根作用域，旧主题自己的 :root 或 body 声明都能自然覆盖它。
  const fallback = getBuiltinTheme('light')!.colors
  let css = rule([':root'], THEME_COLOR_FIELDS.flatMap(field => {
    // 派生颜色必须在实际主题所在的 body 计算，不能在根节点固化浅色默认值。
    if (field.key === 'codeBlockText' || field.key === 'tableBorder') return []
    const value = fallback[field.key]
    return value === undefined ? [] : [`${field.variable}: ${value};`]
  }))
  if (theme.extensions?.css) css += `${theme.extensions.css}\n`
  const variables: string[] = []
  const variable = (name: string, value: string | number): void => { variables.push(`${name}: ${value}${important};`) }
  for (const field of THEME_COLOR_FIELDS) {
    const value = theme.colors[field.key]
    if (value !== undefined) variable(field.variable, value)
  }
  for (const field of THEME_SYNTAX_FIELDS) {
    const value = theme.syntax[field.key]
    if (value !== undefined) variable(field.variable, value)
  }
  const type = theme.typography
  if (type.fontFamily) variable('--font-body', type.fontFamily)
  if (type.codeFontFamily) variable('--font-mono', type.codeFontFamily)
  if (type.fontSize !== undefined) variable('--theme-font-size', `${type.fontSize}px`)
  if (type.baseLineHeight !== undefined) variable('--theme-base-line-height', type.baseLineHeight)
  if (type.paragraphSpacing !== undefined) variable('--theme-paragraph-spacing', `${type.paragraphSpacing}em`)
  // 块级背景也驱动代码调色板、图表和光标使用的颜色变量。
  if (theme.styles.codeBlock?.background) variable('--code-block-bg', theme.styles.codeBlock.background)
  if (theme.styles.codeBlock?.color) variable('--code-block-text', theme.styles.codeBlock.color)
  if (theme.styles.quote?.background) variable('--blockquote-bg', theme.styles.quote.background)
  if (theme.styles.quote?.borderColor) variable('--blockquote-border', theme.styles.quote.borderColor)
  if (theme.styles.inlineCode?.background) variable('--code-bg', theme.styles.inlineCode.background)
  for (let level = 1; level <= 6; level++) {
    const style = theme.styles[`heading${level}` as ThemeTextKind]
    if (style?.fontWeight !== undefined) variable(`--theme-heading${level}-weight`, style.fontWeight)
  }
  if (theme.styles.strong?.fontWeight !== undefined) variable('--theme-strong-weight', theme.styles.strong.fontWeight)
  // 链接内部的语法高亮 span 与外层装饰消费同一项颜色。
  if (theme.styles.link?.color !== undefined) variable('--theme-link-color', theme.styles.link.color)
  if (theme.styles.emphasis?.fontStyle !== undefined) variable('--theme-emphasis-style', theme.styles.emphasis.fontStyle)
  if (theme.styles.strikethrough?.textDecoration !== undefined) variable('--theme-strike-decoration', theme.styles.strikethrough.textDecoration)
  css += rule([SCOPE], [...variables, `color-scheme: ${theme.appearance};`])

  const body: string[] = []
  if (type.fontFamily) body.push(`font-family: var(--editor-font, var(--font-body))${important};`)
  if (type.fontSize !== undefined) body.push(`font-size: var(--editor-font-size, var(--theme-font-size))${important};`)
  if (type.baseLineHeight !== undefined) body.push(`--md-body-line-height: var(--theme-base-line-height)${important};`, `line-height: var(--md-body-line-height)${important};`)
  css += rule([EDITOR, DOCUMENT], body)
  if (type.fontFamily) css += rule([`${SCOPE} #source-editor`], [`font-family: var(--editor-font, var(--font-body))${important};`])
  if (type.fontSize !== undefined) css += rule([`${SCOPE} #source-editor`], [`font-size: var(--editor-font-size, var(--theme-font-size))${important};`])
  if (type.codeFontSize !== undefined) css += rule([
    `${EDITOR} .cm-md-inlinecode`, `${EDITOR} .cm-md-codeblock`, `${EDITOR} .cm-md-table-widget code`, `${DOCUMENT} code`, `${DOCUMENT} pre code`
  ], [`font-size: ${type.codeFontSize}px${important};`])

  if (type.lineHeight !== undefined) {
    css += rule([`${EDITOR} .cm-md-paragraph`, `${DOCUMENT} p`], [`line-height: ${type.lineHeight}${important};`])
    // 既有补偿随行高缩放，用户显式指定行高后将其固定到原基准，避免牵动段间空隙。
    css += rule([`${EDITOR} .cm-md-paragraph-first`], [`padding-top: calc(1em * var(--md-body-line-height) * 1.6 / 1.75 * (1 - var(--md-paragraph-scale)) / 2)${important};`])
    css += rule([`${EDITOR} .cm-md-paragraph-last`], [`padding-bottom: calc(1em * var(--md-body-line-height) * 1.6 / 1.75 * (1 - var(--md-paragraph-scale)) / 2 + var(--theme-paragraph-spacing, 0em))${important};`])
  }
  if (type.paragraphSpacing !== undefined) {
    if (type.lineHeight === undefined) css += rule([`${EDITOR} .cm-md-paragraph-last`], [`padding-bottom: calc(1lh * (1 / var(--md-paragraph-scale) - 1) / 2 + var(--theme-paragraph-spacing))${important};`])
    css += rule([`${DOCUMENT} p`], [`margin-bottom: calc(0.75em + var(--theme-paragraph-spacing))${important};`])
  }
  // 容器颜色先生成，具体文字类型在后，嵌套内容保留自己的颜色。
  const order: ThemeTextKind[] = ['paragraph', 'quote', 'list', 'tableHeader', 'tableCell', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'strong', 'emphasis', 'strikethrough', 'link', 'linkUrl', 'inlineCode', 'codeBlock', 'highlight', 'horizontalRule']
  for (const kind of order) if (theme.styles[kind]) css += contentStyle(kind, theme.styles[kind]!, important)
  // 引用可以直接从代码块开始或结束，两种块的首尾留白在同一行时相加。
  for (const [side, edge] of [['top', 'first'], ['bottom', 'last']] as const) {
    const quote = side === 'top' ? theme.styles.quote?.spacingBefore : theme.styles.quote?.spacingAfter
    const code = side === 'top' ? theme.styles.codeBlock?.spacingBefore : theme.styles.codeBlock?.spacingAfter
    if (quote !== undefined) css += rule([`${EDITOR} .cm-md-blockquote-${edge}.cm-md-codeblock-${edge}`], [
      `padding-${side}: ${quote + (code ?? 0.8)}em${important};`
    ])
  }
  if (theme.colors.cursor) css += rule([`${SCOPE} #editor .cm-cursor`, `${SCOPE} #editor .cm-dropCursor`], [`border-left-color: var(--theme-cursor)${important};`])
  return css
}
