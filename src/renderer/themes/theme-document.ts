import { BUILTIN_THEMES } from '../../shared/theme-definition'
import type { ThemeDefinition } from '../../shared/theme-config'
import { generateThemeCSS } from './theme-style-generator'

// 旧 CSS 中的长度和倍率按所在文档的浏览器解析结果适配。
function shareLegacyLineHeight(rules: CSSRuleList, probe: HTMLElement): void {
  for (const rule of Array.from(rules)) {
    if (rule.type === 1) {
      const styleRule = rule as CSSStyleRule
      // 新配置已经明确区分基准与段内行高，不再做旧规则补偿。
      if (styleRule.selectorText.includes('body.theme-configured')) continue
      const value = styleRule.style.getPropertyValue('line-height')
      if (value && !value.includes('--md-body-line-height')) {
        probe.style.setProperty('line-height', value, 'important')
        const parsed = probe.computedStyleMap().get('line-height')
        const inherited = parsed && 'unit' in parsed && parsed.unit === 'number' ? value : '1lh'
        styleRule.style.setProperty('--md-body-line-height', inherited, styleRule.style.getPropertyPriority('line-height'))
      }
    } else if ('cssRules' in rule) shareLegacyLineHeight((rule as CSSGroupingRule).cssRules, probe)
  }
}

// 应用和预览共享全部类名、兼容行高和代码调色板逻辑，此处不持久化选择。
export function applyThemeToDocument(doc: Document, theme: ThemeDefinition): void {
  const body = doc.body
  for (const item of BUILTIN_THEMES) body.classList.remove(`theme-${item.id}`)
  body.classList.remove('theme-custom')
  body.classList.add('theme-configured')
  body.classList.add(BUILTIN_THEMES.some(item => item.id === theme.id) ? `theme-${theme.id}` : 'theme-custom')
  body.dataset.themeId = theme.id
  doc.getElementById('colamd-active-theme')?.remove()
  const style = doc.createElement('style')
  style.id = 'colamd-active-theme'
  style.textContent = generateThemeCSS(theme)
  doc.head.appendChild(style)
  if (theme.extensions?.css) {
    const content = doc.querySelector<HTMLElement>('#editor .cm-content')
    const context = doc.createElement('div')
    context.className = 'cm-editor'
    const scroller = doc.createElement('div')
    scroller.className = 'cm-scroller'
    context.appendChild(scroller)
    const probe = doc.createElement('div')
    probe.className = content?.className ?? 'cm-content'
    context.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
    if (!content) (doc.getElementById('editor') ?? body).appendChild(context)
    ;(content?.parentElement ?? scroller).appendChild(probe)
    try { if (style.sheet) shareLegacyLineHeight(style.sheet.cssRules, probe) }
    finally { probe.remove(); context.remove() }
  }
  // 先解析变量和透明色，再从实际绘制的背景选择代码语法调色板。
  const computed = doc.defaultView!.getComputedStyle(body)
  const canvas = doc.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = computed.backgroundColor
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = computed.getPropertyValue('--code-block-bg').trim()
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    body.classList.toggle('code-palette-light', (0.2126 * r + 0.7152 * g + 0.0722 * b) >= 127.5)
  }
}
