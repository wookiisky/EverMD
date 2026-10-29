/** 只保留当前正文的保存副本，反复获取标签快照时无需重复转换全部行尾。 */
export class DocumentFileContent {
  /** 缓存所属的实际正文，程序化载入与用户编辑使用同一判断。 */
  private body: string | null = null
  /** 文件的行尾策略，切换标签或重载时可能变化。 */
  private lineEnding = '\n'
  /** 前置内容始终按原字节拼接。 */
  private frontmatter = ''
  /** 与上面三项对应的完整保存内容。 */
  private content = ''

  // 同步取得当前文件内容；缓存只减少重复编码，不延迟保存或沿用其他版本。
  read(body: string, lineEnding: string, frontmatter: string): string {
    if (body === this.body && lineEnding === this.lineEnding && frontmatter === this.frontmatter) return this.content
    this.body = body
    this.lineEnding = lineEnding
    this.frontmatter = frontmatter
    this.content = frontmatter + (lineEnding === '\r\n' ? body.replace(/\r?\n/g, '\r\n') : body)
    return this.content
  }
}
