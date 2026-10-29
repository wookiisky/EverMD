// 在真实临时目录验证主题持久化、旧文件迁移和格式往返。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/main/theme-storage.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), bundledModule, bundledModule.exports)
const { ThemeStorage, parseThemeFile, serializeThemeFile, legacyThemeId, recoverThemeDraft } = bundledModule.exports
const directory = await mkdtemp(join(tmpdir(), 'colamd-theme-storage-'))
const theme = { version: 1, id: 'user-example', name: '同名主题', appearance: 'light', colors: { text: '#123456', selection: 'rgba(1, 2, 3, 0.2)' }, typography: { lineHeight: 1.6, paragraphSpacing: 0.8 }, styles: {}, syntax: {} }
try {
  const storage = new ThemeStorage(directory)
  assert.deepEqual(await storage.load(), [])
  await storage.save(theme)
  const second = { ...theme, id: 'user-another', typography: { lineHeight: 1.9, paragraphSpacing: 0.4 } }
  await storage.save(second)
  assert.equal(storage.list().length, 2, '同名主题按 ID 独立保存')
  const restarted = new ThemeStorage(directory)
  assert.deepEqual(await restarted.load(), storage.list(), '重启后定义等价')
  const beforeRecovery = storage.list()
  const invalidFields = { 'typography.lineHeight': '无法转换的数值', 'colors.text': '不是颜色' }
  const draft = { ...theme, name: '../不应参与路径的名称' }
  const recoveryPath = await recoverThemeDraft(directory, draft, invalidFields)
  assert.deepEqual(JSON.parse(await readFile(recoveryPath, 'utf8')), { theme: draft, invalidFields }, '恢复副本保留草稿及无效输入原文')
  assert(recoveryPath.startsWith(join(directory, 'theme-draft-')), '恢复文件使用固定前缀，不使用主题名称')
  assert.deepEqual(storage.list(), beforeRecovery, '写恢复副本不修改主题库')
  assert.deepEqual(await restarted.load(), beforeRecovery, '恢复副本不混入主题库')
  for (const format of ['yaml', 'json']) {
    const serialized = serializeThemeFile(theme, format)
    assert(serialized.endsWith('\n'))
    assert.deepEqual(parseThemeFile(serialized, format), theme, `${format} 实际序列化后等价`)
    assert(serialized.includes('\n  '), `${format} 采用格式化缩进`)
  }
  await Promise.all([
    storage.save({ ...theme, name: '并发第一份' }),
    storage.save({ ...theme, name: '并发第二份' })
  ])
  const afterConcurrent = new ThemeStorage(directory)
  assert.deepEqual(await afterConcurrent.load(), storage.list(), '并发后内存与实际磁盘保持一致')
  assert.equal(storage.list().find(item => item.id === theme.id).name, '并发第二份')
  assert.throws(() => parseThemeFile('version: [', 'yaml'))
  assert.throws(() => parseThemeFile('{', 'json'))
  assert.throws(() => parseThemeFile(JSON.stringify({ ...theme, version: 99 }), 'json'))
  assert.throws(() => parseThemeFile('version: 1\nversion: 2', 'yaml'), '重复 YAML 键不能静默覆盖')

  await writeFile(join(directory, 'broken.theme.json'), '{')
  const css = ':root { --text-color: #123456; }\n'
  await writeFile(join(directory, '旧主题.css'), css)
  const migrated = new ThemeStorage(directory)
  const originalError = console.error
  const loadFailures = []
  console.error = (...args) => loadFailures.push(args)
  let definitions
  try {
    definitions = await migrated.load()
  } finally {
    console.error = originalError
  }
  assert.equal(loadFailures.length, 1, '损坏文件记录读取失败')
  const old = definitions.find(item => item.id === legacyThemeId('旧主题.css'))
  assert.equal(old.extensions.css, css)
  assert.equal(await readFile(join(directory, '旧主题.css'), 'utf8'), css, '迁移保留原文件')
  await rm(join(directory, 'broken.theme.json'))
  assert.equal((await migrated.load()).filter(item => item.id === old.id).length, 1, '重复启动不重复迁移')
  await writeFile(join(directory, 'A.css'), css)
  await writeFile(join(directory, 'B.css'), css)
  await migrated.load()
  assert.equal(migrated.resolveLegacyThemeId('A.css'), legacyThemeId('A.css'), '同内容的旧主题按 A 文件身份恢复')
  assert.equal(migrated.resolveLegacyThemeId('B.css'), legacyThemeId('B.css'), '同内容的旧主题按 B 文件身份恢复')
  assert.equal(migrated.resolveLegacyThemeId('missing.css'), null, '未迁移的文件不冒用其他同内容主题')
  await migrated.save({ ...migrated.list().find(item => item.id === legacyThemeId('A.css')), name: 'A 改名', colors: { text: '#654321' } })
  assert.equal(migrated.resolveLegacyThemeId('A.css'), legacyThemeId('A.css'), '迁移后的名称与内容变化不改变文件身份')
  await migrated.remove(legacyThemeId('A.css'))
  assert.equal(migrated.resolveLegacyThemeId('A.css'), null, '删除后不解析到另一个同内容主题')
  const snapshot = migrated.list()
  snapshot[0].name = '外部修改'
  assert.notEqual(migrated.list()[0].name, snapshot[0].name, '返回副本防止外部改变存储状态')

  await migrated.remove(theme.id)
  assert(!migrated.list().some(item => item.id === theme.id))
  await migrated.remove(theme.id)
  const blocked = join(directory, 'blocked')
  await writeFile(blocked, '不是目录')
  const failed = new ThemeStorage(blocked)
  const beforeFailedRecovery = migrated.list()
  await assert.rejects(() => recoverThemeDraft(blocked, draft, invalidFields))
  assert.deepEqual(migrated.list(), beforeFailedRecovery, '恢复副本写入失败不修改已有主题库')
  await assert.rejects(() => failed.save(theme))
  assert.deepEqual(failed.list(), [], '写入失败不更新内存定义')
  assert(!(await readdir(directory)).some(name => name.endsWith('.tmp')), '写入不遗留临时文件')
  console.log('通过：主题文件保存、同名隔离、重启、YAML/JSON 往返、无效输入、旧 CSS 迁移和写入失败')
} finally {
  await rm(directory, { recursive: true, force: true })
}
