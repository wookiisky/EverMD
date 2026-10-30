import { parser } from '@lezer/markdown'

/** 从 ATX 或 Setext 标题源码提取文字，只移除语法确认的标记。 */
export function headingText(markdown: string): string {
  let text = ''
  let from = 0
  parser.parse(markdown).iterate({
    enter(node) {
      if (node.to <= from) return false
      const name = node.name
      const parent = node.node.parent
      // 链接的 ] 之后整体跳过地址与可选标题，包含它们之间的空白。
      if (name === 'LinkMark' && (parent?.name === 'Link' || parent?.name === 'Image')
        && markdown.slice(node.from, node.to) === ']') {
        text += markdown.slice(from, node.from)
        from = parent.to
        return false
      }
      if (name !== 'HeaderMark' && name !== 'EmphasisMark' && name !== 'CodeMark'
        && name !== 'LinkMark' && name !== 'HTMLTag' && name !== 'Escape') return
      text += markdown.slice(from, node.from)
      // 转义只去掉反斜杠；正文下划线和代码中的符号不是格式标记。
      if (name === 'Escape') text += markdown.slice(node.from + 1, node.to)
      from = node.to
      return false
    },
  })
  return (text + markdown.slice(from)).trim()
}
