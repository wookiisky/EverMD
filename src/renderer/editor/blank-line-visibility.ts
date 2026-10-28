import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state'
import { markdownParser } from './state'
import { frontmatterRange, scanMath, type Excluded } from './math-scan'

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

/** 同一文档的选区和焦点变化复用候选，不反复完整解析。 */
const blankLinesByDocument = new WeakMap<Text, readonly number[]>()
/** 不允许压缩内部空行的语法块。 */
const PROTECTED_NODES = new Set([
  'FencedCode', 'CodeBlock', 'IndentedCode', 'InlineCode',
  'HTMLBlock', 'HTMLTag', 'CommentBlock', 'ProcessingInstructionBlock'
])

/** 找出普通空行及只有引用标记的空行，返回从 1 开始的源码行号。 */
export function blankLineNumbers(text: string): readonly number[] {
  // 必须完整解析，视口外代码和 HTML 的空行也不能被压缩。
  const tree = markdownParser.parse(text)
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
  protectedRanges.push(...scanMath(text, protectedRanges))
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

/** 只在启用时扫描；正在编辑的空行与导出的空行保持正常高度。 */
export function hiddenBlankLineNumbers(state: EditorState, focused: boolean, cleanExport: boolean): readonly number[] {
  if (!state.field(hideBlankLinesField, false) || cleanExport) return []
  let numbers = blankLinesByDocument.get(state.doc)
  if (!numbers) {
    numbers = blankLineNumbers(state.doc.toString())
    blankLinesByDocument.set(state.doc, numbers)
  }
  if (!focused) return numbers
  const activeLines = new Set(state.selection.ranges.map(range => state.doc.lineAt(range.head).number))
  return numbers.filter(number => !activeLines.has(number))
}
