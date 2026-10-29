import type { Text } from '@codemirror/state'
import type { Tree } from '@lezer/common'
import { documentText } from './document-text'
import { footnoteDefinitions, FOOTNOTE_REF_RE } from './footnotes'
import { excludedRanges, frontmatterRange, scanMath, type Excluded, type MathRange } from './math-scan'

/** 文本中的脚注位置，不持有视图或可变的编辑器状态。 */
interface FootnoteReference {
  /** 原文起点。 */
  readonly from: number
  /** 原文终点。 */
  readonly to: number
  /** 文件中的脚注标识。 */
  readonly label: string
}

/** 只随文本变化的结果；选区、主题与语法解析推进均可复用。 */
interface DocumentAnalysis {
  /** 属性区保留其源码范围，不改变文件内容。 */
  readonly front: Readonly<Excluded> | null
  /** 首次出现顺序决定脚注编号。 */
  readonly footnoteNumbers: ReadonlyMap<string, number>
  /** 脚注定义与缩进续段。 */
  readonly footnoteDefinitions: ReadonlyMap<string, string>
  /** 全部引用和定义中的标识位置。 */
  readonly footnoteReferences: readonly FootnoteReference[]
  /** 定义行的源码起点，供现有行装饰使用。 */
  readonly footnoteDefinitionLines: readonly number[]
}

/** 显示使用当前惰性语法树，不能与空行保护使用的完整树混用。 */
interface PreviewAnalysis {
  /** 代码、HTML、属性区等不应当作普通正文的范围。 */
  readonly excluded: readonly Excluded[]
  /** 已排除非正文范围的公式。 */
  readonly math: readonly MathRange[]
}

/** 同一 Text 的后台解析只保留最新树的结果，避免累积解析阶段。 */
interface ParsedAnalysis {
  /** 这份结果对应的树对象。 */
  readonly tree: Tree
  /** 供显示层只读使用的扫描结果。 */
  readonly value: PreviewAnalysis
}

const documents = new WeakMap<Text, DocumentAnalysis>()
const previews = new WeakMap<Text, ParsedAnalysis>()

/** 每个文档版本只扫描一次属性区和脚注，普通正文不创建逐行脚注中间结果。 */
export function documentAnalysis(doc: Text): DocumentAnalysis {
  const cached = documents.get(doc)
  if (cached) return cached
  const text = documentText(doc)
  const numbers = new Map<string, number>()
  const references: FootnoteReference[] = []
  const definitionLines: number[] = []
  const hasFootnotes = text.includes('[^')
  if (hasFootnotes) {
    FOOTNOTE_REF_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = FOOTNOTE_REF_RE.exec(text)) !== null) {
      const label = match[1]
      if (!numbers.has(label)) numbers.set(label, numbers.size + 1)
      references.push({ from: match.index, to: match.index + match[0].length, label })
    }
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n)
      if (/^ {0,3}\[\^[^\]\s]+\]:/.test(line.text)) definitionLines.push(line.from)
    }
  }
  const value: DocumentAnalysis = {
    front: frontmatterRange(text),
    footnoteNumbers: numbers,
    footnoteDefinitions: hasFootnotes ? footnoteDefinitions(text) : new Map(),
    footnoteReferences: references,
    footnoteDefinitionLines: definitionLines,
  }
  documents.set(doc, value)
  return value
}

/** 树推进后重新判定公式排除区，即使文档文本未变也必须失效。 */
export function previewAnalysis(doc: Text, tree: Tree): PreviewAnalysis {
  const cached = previews.get(doc)
  if (cached?.tree === tree) return cached.value
  const text = documentText(doc)
  const excluded = excludedRanges(text, tree)
  const value: PreviewAnalysis = {
    excluded,
    math: text.includes('$') || text.includes('\\') ? scanMath(text, excluded) : [],
  }
  previews.set(doc, { tree, value })
  return value
}
