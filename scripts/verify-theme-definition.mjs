// 在配置边界验证结构、拒绝无效值和 CSS 生成，避免把可变配色写成断言。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const modules = await Promise.all(['src/shared/theme-definition.ts', 'src/renderer/themes/theme-style-generator.ts'].map(async path => {
  const bundle = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
}))
const { BUILTIN_THEMES, THEME_COLOR_FIELDS, THEME_SYNTAX_FIELDS, THEME_TEXT_KINDS, validateThemeDefinition, cloneTheme, getBuiltinTheme } = modules[0]
const { generateThemeCSS } = modules[1]

// 本批主题须独立可用，不能依赖浅色默认值补齐深色配色。
const classicThemeIds = ['vscode-dark-modern', 'vscode-light-modern', 'one-dark', 'monokai', 'github-dark',
  'solarized-light', 'tokyo-night', 'catppuccin-mocha', 'catppuccin-latte']
for (const id of classicThemeIds) {
  const theme = getBuiltinTheme(id)
  assert.ok(theme, `缺少经典主题：${id}`)
  for (const { key } of THEME_COLOR_FIELDS) assert.ok(theme.colors[key], `${id} 缺少界面颜色 ${key}`)
  for (const { key } of THEME_SYNTAX_FIELDS) assert.ok(theme.syntax[key], `${id} 缺少语法颜色 ${key}`)
  assert.ok(theme.typography.lineHeight > 0, `${id} 缺少段内行高`)
  assert.ok(theme.typography.paragraphSpacing >= 0, `${id} 缺少段落间距`)
  assert.equal(theme.extensions, undefined, `${id} 应使用结构化排版`)
}
assert.equal(new Set(BUILTIN_THEMES.map(theme => theme.id)).size, BUILTIN_THEMES.length)
for (const theme of BUILTIN_THEMES) {
  assert.deepEqual(validateThemeDefinition(theme), theme)
  assert.deepEqual(validateThemeDefinition(JSON.parse(JSON.stringify(theme))), theme)
  assert.equal(getBuiltinTheme(theme.id)?.id, theme.id)
  const copy = cloneTheme(theme)
  copy.name = '副本'
  assert.notEqual(theme.name, copy.name)
  const css = generateThemeCSS(theme)
  assert(css.includes('body.theme-configured'))
  for (const field of THEME_COLOR_FIELDS) {
    if (theme.colors[field.key]) assert(css.includes(`${field.variable}: ${theme.colors[field.key]}`))
  }
  for (const field of THEME_SYNTAX_FIELDS) {
    if (theme.syntax[field.key]) assert(css.includes(`${field.variable}: ${theme.syntax[field.key]}`))
  }
  if (theme.typography.lineHeight !== undefined) assert(css.includes(`line-height: ${theme.typography.lineHeight};`))
  if (theme.typography.paragraphSpacing !== undefined) assert(css.includes(`--theme-paragraph-spacing: ${theme.typography.paragraphSpacing}em;`))
}
assert.equal(getBuiltinTheme('不存在'), undefined)
const basic = cloneTheme(BUILTIN_THEMES[0])
for (const [mutate, path] of [
  [theme => { theme.version = 2 }, 'version'],
  [theme => { theme.appearance = 'auto' }, 'appearance'],
  [theme => { theme.typography.lineHeight = NaN }, 'typography.lineHeight'],
  [theme => { theme.typography.paragraphSpacing = -1 }, 'typography.paragraphSpacing'],
  [theme => { theme.styles.heading1 = { fontSize: 0 } }, 'styles.heading1.fontSize'],
  [theme => { theme.styles.strong = { unknown: true } }, 'styles.strong.unknown'],
  [theme => { theme.styles.notMarkdown = {} }, 'styles.notMarkdown'],
  [theme => { theme.colors.bg = 'red; display: none' }, 'colors.bg'],
  [theme => { theme.colors.bg = 'url(https://example.com)' }, 'colors.bg'],
  [theme => { theme.colors.bg = 'rgb(mistyped)' }, 'colors.bg'],
  [theme => { theme.colors.bg = 'rgba(1, 2)' }, 'colors.bg'],
  [theme => { theme.colors.unknown = '#fff' }, 'colors.unknown'],
  [theme => { theme.typography.fontFamily = 'serif;display:none' }, 'typography.fontFamily'],
  [theme => { theme.id = '../outside' }, 'id']
]) {
  const bad = cloneTheme(basic)
  mutate(bad)
  assert.throws(() => validateThemeDefinition(bad), error => error.path === path, path)
}
const independent = cloneTheme(basic)
independent.typography.lineHeight = 1.8
independent.typography.paragraphSpacing = 0.7
independent.styles.strong = { color: '#13579b', fontWeight: 800 }
independent.styles.codeBlock = { background: '#123456' }
independent.extensions = { css: 'body { --legacy: 1; }' }
const css = generateThemeCSS(independent)
assert(css.indexOf('--bg-color') < css.indexOf('--legacy'))
assert(css.indexOf('--legacy') < css.lastIndexOf('--bg-color'))
assert(css.includes('line-height: 1.8'))
assert(css.includes('--theme-paragraph-spacing: 0.7em'))
assert(css.includes('.cm-md-codeblock::before'))
assert(css.includes('.cm-md-table-widget strong'))
assert(css.includes('.colamd-document strong'))
assert(css.includes('!important'))
for (const kind of THEME_TEXT_KINDS) {
  const theme = cloneTheme(basic)
  theme.styles[kind] = { color: '#13579b' }
  assert(generateThemeCSS(theme).includes('#13579b'), kind)
}
const layout = cloneTheme(basic)
layout.styles = {
  list: { fontSize: 1.5, spacingBefore: 1, spacingAfter: 2 },
  quote: { spacingBefore: 1, spacingAfter: 2 },
  codeBlock: { fontSize: 1.5, spacingBefore: 1, spacingAfter: 2 }
}
const layoutCSS = generateThemeCSS(layout)
assert(layoutCSS.includes('.cm-md-li-first'))
assert(layoutCSS.includes('.cm-md-li-last'))
assert(layoutCSS.includes('.cm-md-blockquote-first'))
assert(layoutCSS.includes('.cm-md-blockquote-last'))
assert(layoutCSS.includes('.cm-md-codeblock-first'))
assert(layoutCSS.includes('.cm-md-codeblock-last'))
assert.match(layoutCSS, /\.cm-md-li-bullet,[\s\S]*?\{\s*font-size: inherit;/)
assert.match(layoutCSS, /\.colamd-document pre > code \{\s*font-size: inherit;/)
console.log(`通过：${BUILTIN_THEMES.length} 套主题结构、克隆与往返、无效输入、段内行高与段间距分离、编辑器和 HTML 样式生成`)
