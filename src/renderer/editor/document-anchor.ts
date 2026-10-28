import { parser } from '@lezer/markdown'
import { headingAnchorLine } from './heading-anchor'
import { sanitizeHTML } from './html-sanitize'
import { frontmatterRange } from './math-scan'

/** 锚点的源码范围；HTML 还保留实际 id，供渲染后定位块内部的目标。 */
export interface DocumentAnchor {
  /** 标题所在行或 HTML 节点的起点。 */
  from: number
  /** 标题所在行或 HTML 节点的终点。 */
  to: number
  /** 显式 HTML id；标题使用原有源码行定位。 */
  id?: string
}

/** 从全文查找显式 HTML id，找不到时沿用标题锚点规则。 */
export function documentAnchor(markdown: string, fragment: string): DocumentAnchor | null {
  let target = fragment
  try { target = decodeURIComponent(fragment) } catch { /* 保留字面片段。 */ }
  if (!target) return null
  const front = frontmatterRange(markdown)
  let anchor: DocumentAnchor | null = null
  parser.parse(markdown).iterate({
    enter(node) {
      if (anchor || (front && node.name !== 'Document' && node.from < front.to)) return false
      if (node.name !== 'HTMLBlock' && node.name !== 'HTMLTag') return
      // 与显示层使用同一份 HTML 规则，注释、被过滤的标签及其内容不会成为目标。
      const html = sanitizeHTML(markdown.slice(node.from, node.to))
      if (Array.from(html.querySelectorAll('[id]')).some(element => element.id === target)) {
        anchor = { from: node.from, to: node.to, id: target }
      }
      return false
    },
  })
  if (anchor) return anchor
  const line = headingAnchorLine(markdown, fragment)
  if (line === null) return null
  const lines = markdown.split('\n')
  const from = lines.slice(0, line).reduce((offset, text) => offset + text.length + 1, 0)
  return { from, to: from + lines[line].length }
}
