import { StateEffect, StateField, type EditorState, type Text, type Transaction } from '@codemirror/state'
import { TreeFragment, type ChangedRange, type Tree } from '@lezer/common'
import { markdownParser } from './state'
import { frontmatterRange, scanMath, type Excluded } from './math-scan'
import { documentText } from './document-text'

/** 只改变空行的显示方式，不产生文档改动。 */
export const setHideBlankLinesEffect = StateEffect.define<boolean>()

/** 每份编辑器状态记录当前视图开关，外壳在切换标签后同步全局偏好。 */
export const hideBlankLinesField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHideBlankLinesEffect)) value = effect.value
    }
    return value
  }
})

/** 空行保护必须覆盖全文；它独立于显示层按视口推进的语法树。 */
interface BlankLineAnalysis {
  /** 上次完整解析的树，编辑时交由解析器复用未变部分。 */
  readonly tree: Tree
  /** 受保护范围之外的空行行号。 */
  readonly numbers: readonly number[]
}

/** 文档不变时复用结果，不通过缓存链保留旧文档版本。 */
const blankLinesByDocument = new WeakMap<Text, BlankLineAnalysis>()
/** 不允许压缩内部空行的语法块。 */
const PROTECTED_NODES = new Set([
  'FencedCode', 'CodeBlock', 'IndentedCode', 'InlineCode',
  'HTMLBlock', 'HTMLTag', 'CommentBlock', 'ProcessingInstructionBlock'
])

/** 找出普通空行及只有引用标记的空行，返回从 1 开始的源码行号。 */
export function blankLineNumbers(text: string): readonly number[] {
  // 必须完整解析，视口外代码和 HTML 的空行也不能被压缩。
  return scanBlankLines(text, markdownParser.parse(text))
}

/** 在完整树上识别保护区，增量解析与从头解析共用同一套空行规则。 */
function scanBlankLines(text: string, tree: Tree): readonly number[] {
  const protectedRanges: Excluded[] = []
  tree.iterate({
    enter(node) {
      if (!PROTECTED_NODES.has(node.name)) return
      // 未闭合块可能吞到文末 LF，最后的逻辑空行也在块内；闭合围栏的 to 停在标记末尾。
      const to = node.to === text.length && text.endsWith('\n') ? node.to + 1 : node.to
      protectedRanges.push({ from: node.from, to })
    }
  })
  const front = frontmatterRange(text)
  if (front) protectedRanges.push(front)
  // 没有两种公式起始标记时不生成全文遮罩，代码和 HTML 的保护仍由完整树决定。
  if (text.includes('$') || text.includes('\\')) protectedRanges.push(...scanMath(text, protectedRanges))
  protectedRanges.sort((a, b) => a.from - b.from)

  const numbers: number[] = []
  let from = 0
  let rangeIndex = 0
  for (const [index, line] of text.split('\n').entries()) {
    if (/^[ \t]*(?:>[ \t]*)*\r?$/.test(line)) {
      while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex].to <= from) rangeIndex++
      const range = protectedRanges[rangeIndex]
      if (!range || range.from > from + line.length) numbers.push(index + 1)
    }
    from += line.length + 1
  }
  return numbers
}

/** 当前事务仍启用空行显示时复用旧树；停用期间不追踪片段，恢复时按需完整解析。 */
export function updateBlankLineAnalysis(transaction: Transaction, cleanExport: boolean): void {
  if (!transaction.docChanged || cleanExport || !transaction.state.field(hideBlankLinesField, false)) return
  const doc = transaction.newDoc
  if (blankLinesByDocument.has(doc)) return
  const previous = blankLinesByDocument.get(transaction.startState.doc)
  if (!previous) return
  const changes: ChangedRange[] = []
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    changes.push({ fromA, toA, fromB, toB })
  })
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(previous.tree), changes)
  const text = documentText(doc)
  const tree = markdownParser.parse(text, fragments)
  blankLinesByDocument.set(doc, { tree, numbers: scanBlankLines(text, tree) })
}

/** 只在启用时扫描；正在编辑的空行与导出的空行保持正常高度。 */
export function hiddenBlankLineNumbers(state: EditorState, focused: boolean, cleanExport: boolean): readonly number[] {
  if (!state.field(hideBlankLinesField, false) || cleanExport) return []
  let analysis = blankLinesByDocument.get(state.doc)
  if (!analysis) {
    const text = documentText(state.doc)
    const tree = markdownParser.parse(text)
    analysis = { tree, numbers: scanBlankLines(text, tree) }
    blankLinesByDocument.set(state.doc, analysis)
  }
  const numbers = analysis.numbers
  if (!focused) return numbers
  const activeLines = new Set(state.selection.ranges.map(range => state.doc.lineAt(range.head).number))
  return numbers.filter(number => !activeLines.has(number))
}
