// 官方主题是统一配置的生成物，--check 用于检查发布文件有没有漂移。
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/main/theme-storage.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { serializeThemeFile, parseThemeFile } = module.exports
const themes = JSON.parse(await readFile(new URL('../src/shared/builtin-themes.json', import.meta.url), 'utf8'))
const check = process.argv.includes('--check')
for (const theme of themes) {
  const content = '# 由 src/shared/builtin-themes.json 生成，请运行 node scripts/export-builtin-themes.mjs 更新。\n' + serializeThemeFile(theme, 'yaml')
  const path = new URL(`../themes/${theme.id}.yaml`, import.meta.url)
  assert.deepEqual(parseThemeFile(content, 'yaml'), theme, `${theme.id} 导出后重新导入配置应相等`)
  if (check) assert.equal(await readFile(path, 'utf8'), content, `${theme.id}.yaml 已过期，请重新生成`)
  else await writeFile(path, content, 'utf8')
}

// 色卡只展示配置里的颜色，避免主题更新后文档仍保留旧名称或旧配色。
function themeSwatches() {
  const columns = 4, cardWidth = 280, cardHeight = 120, gap = 16, margin = 24
  const width = margin * 2 + columns * cardWidth + (columns - 1) * gap
  const groups = ['light', 'dark'].map(appearance => ({ appearance, themes: themes.filter(theme => theme.appearance === appearance) }))
  const height = margin + groups.reduce((sum, group) => sum + 40 + Math.ceil(group.themes.length / columns) * (cardHeight + gap), 0)
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
    '<title>ColaMD built-in theme palettes</title>']
  let top = margin
  for (const group of groups) {
    svg.push(`<text x="${margin}" y="${top + 16}" font-size="13" font-weight="700" letter-spacing="2" fill="#656d76">${group.appearance.toUpperCase()}</text>`)
    top += 40
    for (const [index, theme] of group.themes.entries()) {
      const x = margin + (index % columns) * (cardWidth + gap), y = top + Math.floor(index / columns) * (cardHeight + gap)
      const color = theme.colors
      svg.push(`<rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="12" fill="${escape(color.bg)}" stroke="${escape(color.border)}"/>`,
        `<text x="${x + 18}" y="${y + 28}" font-size="10.5" font-weight="700" fill="${escape(color.textSecondary)}">${String(index + 1).padStart(2, '0')}</text>`,
        `<text x="${x + 18}" y="${y + 57}" font-size="17" font-weight="700" fill="${escape(color.text)}">${escape(theme.name)}</text>`)
      for (const [position, value] of [color.text, color.link, color.textSecondary].entries()) {
        svg.push(`<rect x="${x + 18 + position * 28}" y="${y + 86}" width="20" height="20" rx="5.5" fill="${escape(value)}"/>`)
      }
    }
    top += Math.ceil(group.themes.length / columns) * (cardHeight + gap)
  }
  return [...svg, '</svg>', ''].join('\n')
}

const swatchPath = new URL('../docs/images/theme-swatches.svg', import.meta.url)
if (check) assert.equal(await readFile(swatchPath, 'utf8'), themeSwatches(), '主题色卡已过期，请重新生成')
else await writeFile(swatchPath, themeSwatches(), 'utf8')
console.log(`${check ? '通过' : '已生成'}：${themes.length} 套官方 YAML 主题与色卡${check ? '与统一配置一致，往返校验通过' : ''}`)
