import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { parse, stringify } from 'yaml'
import type { ThemeDefinition } from '../shared/theme-config'
import { validateThemeDefinition } from '../shared/theme-definition'

/** 主题文件采用同一份结构，扩展名只决定序列化格式。 */
export type ThemeFileFormat = 'yaml' | 'json'

// 根据原文件名生成稳定 ID，保证迁移可重复执行而不创建副本。
export function legacyThemeId(fileName: string): string {
  return `legacy-${createHash('sha256').update(fileName).digest('hex').slice(0, 16)}`
}

// CSS 先进入统一配置的兼容字段，渲染层再提取可编辑的属性。
export function themeFromLegacyCSS(fileName: string, css: string): ThemeDefinition {
  return validateThemeDefinition({
    version: 1,
    id: legacyThemeId(fileName),
    name: fileName.replace(/\.css$/i, ''),
    appearance: 'light',
    colors: {},
    typography: {},
    styles: {},
    syntax: {},
    extensions: { css }
  })
}

// 格式解析后仍经过同一配置校验，不接受不支持的版本或未知字段。
export function parseThemeFile(text: string, format: ThemeFileFormat): ThemeDefinition {
  const value: unknown = format === 'yaml' ? parse(text, { uniqueKeys: true, logLevel: 'error' }) : JSON.parse(text)
  return validateThemeDefinition(value)
}

// 固定缩进和顶层字段顺序，输出适合直接阅读及版本管理的文件。
export function serializeThemeFile(input: ThemeDefinition, format: ThemeFileFormat): string {
  const theme = validateThemeDefinition(input)
  const ordered = {
    version: theme.version,
    id: theme.id,
    name: theme.name,
    appearance: theme.appearance,
    colors: theme.colors,
    typography: theme.typography,
    styles: theme.styles,
    syntax: theme.syntax,
    ...(theme.extensions ? { extensions: theme.extensions } : {})
  }
  return format === 'yaml'
    ? stringify(ordered, { indent: 2, lineWidth: 0, singleQuote: true })
    : `${JSON.stringify(ordered, null, 2)}\n`
}

// 恢复文件保留无效输入，不经过主题校验或主题库保存流程。
export async function recoverThemeDraft(directory: string, theme: ThemeDefinition, invalidFields: Record<string, string>): Promise<string> {
  await mkdir(directory, { recursive: true })
  const target = join(directory, `theme-draft-${Date.now()}-${randomUUID()}.json`)
  await writeFile(target, `${JSON.stringify({ theme, invalidFields }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return target
}

/** 用户定义按 ID 保存，主题名称不参与磁盘路径和覆盖判断。 */
export class ThemeStorage {
  /** 所有用户主题与内置主题的本地定制。 */
  private readonly definitions = new Map<string, ThemeDefinition>()
  /** 串行完成修改，避免并发保存同一 ID 后内存与磁盘各取不同版本。 */
  private mutation: Promise<void> = Promise.resolve()

  // 存储目录由调用方提供，测试使用真实临时目录。
  constructor(private readonly directory: string) {}

  // 读取已保存定义并迁移尚未纳入配置的 CSS；损坏文件保留原件。
  async load(): Promise<ThemeDefinition[]> {
    await mkdir(this.directory, { recursive: true })
    const files = (await readdir(this.directory)).sort()
    this.definitions.clear()
    for (const file of files.filter(name => name.endsWith('.theme.json'))) {
      try {
        const theme = parseThemeFile(await readFile(join(this.directory, file), 'utf8'), 'json')
        this.definitions.set(theme.id, theme)
      } catch (error) {
        console.error('主题配置读取失败', file, error)
      }
    }
    for (const file of files.filter(name => name.toLowerCase().endsWith('.css'))) {
      if (this.definitions.has(legacyThemeId(file))) continue
      try {
        await this.save(themeFromLegacyCSS(file, await readFile(join(this.directory, file), 'utf8')))
      } catch (error) {
        console.error('旧主题迁移失败', file, error)
      }
    }
    return this.list()
  }

  // 返回副本，界面编辑草稿不会修改持久化状态。
  list(): ThemeDefinition[] {
    return structuredClone([...this.definitions.values()].sort((a, b) => a.id.localeCompare(b.id)))
  }

  // 旧选择记录携带文件名，同内容主题也必须恢复到各自的稳定身份。
  resolveLegacyThemeId(fileName: string): string | null {
    const id = legacyThemeId(fileName)
    return this.definitions.has(id) ? id : null
  }

  // 原子替换成功后才更新内存；失败保留先前定义。
  async save(input: ThemeDefinition): Promise<ThemeDefinition> {
    const theme = validateThemeDefinition(input)
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true })
      const target = this.filePath(theme.id)
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, serializeThemeFile(theme, 'json'), 'utf8')
        await rename(temporary, target)
      } finally {
        await unlink(temporary).catch(() => {})
      }
      this.definitions.set(theme.id, structuredClone(theme))
      return structuredClone(theme)
    })
  }

  // 删除内置 ID 的本地定义即恢复内置值，删除不存在的定义视为已完成。
  async remove(id: string): Promise<void> {
    await this.enqueue(async () => {
      try {
        await unlink(this.filePath(id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.definitions.delete(id)
    })
  }

  // 文件名编码不依赖名称，并避免外来 ID 形成目录跳转。
  private filePath(id: string): string {
    return join(this.directory, `${encodeURIComponent(id)}.theme.json`)
  }

  // 后一个修改在前一个结束后执行，失败不会堵住后续修改。
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation)
    this.mutation = result.then(() => {}, () => {})
    return result
  }
}
