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
console.log(`${check ? '通过' : '已生成'}：${themes.length} 套官方 YAML 主题${check ? '与统一配置一致，往返校验通过' : ''}`)
