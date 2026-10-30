import { headingText } from './editor/heading-text'

/** 大纲只记录源码位置；按钮和滚动跟踪共享同一份结果。 */
export interface OutlineItem {
  /** Markdown 标题级别。 */
  level: number
  /** 去除行内标记后的显示文字。 */
  title: string
  /** 从零开始的源码行号。 */
  line: number
}

/** 只保留当前内容的解析结果，切文档后不留存旧全文。 */
export class DocumentOutline {
  /** 最近解析的源码，纯选区变化和双侧展示直接复用。 */
  private text: string | null = null
  /** 与源码对应的标题和位置。 */
  private items: readonly OutlineItem[] = []

  // 保持原有围栏与标题语义，位置变化也更新结果。
  read(content: string): readonly OutlineItem[] {
    if (content === this.text) return this.items
    const items: OutlineItem[] = []
    let fence: { char: string; length: number } | null = null
    let lineNumber = 0
    for (const line of content.split(/\r?\n/)) {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (fenceMatch) {
        const marker = fenceMatch[1]
        if (!fence) fence = { char: marker[0], length: marker.length }
        else if (marker[0] === fence.char && marker.length >= fence.length) fence = null
      } else if (!fence) {
        const match = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line)
        if (match) {
          const title = headingText(line)
          if (title) items.push({ level: match[1].length, title, line: lineNumber })
        }
      }
      lineNumber++
    }
    this.text = content
    this.items = items
    return items
  }
}

// 行号变化不影响按钮显示，跳转位置另从最新条目读取。
export function sameOutlineLabels(previous: readonly OutlineItem[] | undefined, next: readonly OutlineItem[]): boolean {
  return previous !== undefined && previous.length === next.length
    && previous.every((item, index) => item.level === next[index].level && item.title === next[index].title)
}
