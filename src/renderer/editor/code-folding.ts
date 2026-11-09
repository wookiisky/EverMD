import { foldNodeProp, LanguageDescription, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState, StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { IterMode, type SyntaxNode, type Tree } from '@lezer/common'
import labels from '../../shared/code-fold-labels.json'
import { getUiLanguage } from '../ui-language'

/** 可隐藏的文本区间，左闭右开。 */
interface FoldSpan {
  /** 隐藏起点，也是按钮所在位置。 */
  readonly from: number
  /** 隐藏终点。 */
  readonly to: number
}

/** 区间及其围栏边界，编辑所属围栏时展开，避免旧范围盖住新的语法结构。 */
export interface CodeFoldRange extends FoldSpan {
  /** 所属围栏的开头。 */
  readonly fenceFrom: number
  /** 所属围栏的结尾。 */
  readonly fenceTo: number
  /** 区分整块和内部语法结构。 */
  readonly kind: 'block' | 'section'
}

/** 折叠范围属于当前 EditorState，放映可临时展开显示。 */
interface CodeFoldState {
  /** 已折叠范围，包括被外层挡住的折叠。 */
  readonly ranges: readonly CodeFoldRange[]
  /** 放映期间停用折叠显示。 */
  readonly suspended: boolean
}

/** 仅为已验证的解析器显示内部折叠，语言别名仍使用编辑器已有的语言表。 */
const structuredLanguages = new Set(['JSON', 'YAML', 'JavaScript', 'JSX', 'TypeScript', 'TSX', 'Python', 'HTML', 'CSS'])
const rangesByDocument = new WeakMap<Text, { tree: Tree; fences: Map<number, readonly CodeFoldRange[]> }>()
/** Lezer 复用围栏子树时，围栏内部不变，仅把局部折叠平移到新的位置。 */
const sectionsByFence = new WeakMap<Tree, readonly FoldSpan[]>()

/** 每棵语法树只计算一次同一围栏的范围，异步语言加载后随语法树刷新。 */
export function fenceFoldRanges(state: EditorState, fence: SyntaxNode): readonly CodeFoldRange[] {
  const tree = syntaxTree(state)
  let cached = rangesByDocument.get(state.doc)
  if (!cached || cached.tree !== tree) {
    cached = { tree, fences: new Map() }
    rangesByDocument.set(state.doc, cached)
  }
  let ranges = cached.fences.get(fence.from)
  if (!ranges) {
    ranges = collectFenceRanges(state, fence)
    cached.fences.set(fence.from, ranges)
  }
  return ranges
}

/** 整块使用 Markdown 围栏边界，内部范围由已挂载的语言解析器提供。 */
function collectFenceRanges(state: EditorState, fence: SyntaxNode): CodeFoldRange[] {
  const [openingMark, closingMark] = fence.getChildren('CodeMark')
  if (!openingMark || !closingMark) return []
  const opening = state.doc.lineAt(openingMark.from)
  const closing = state.doc.lineAt(closingMark.from)
  if (closing.number - opening.number < 3) return []
  const info = fence.getChild('CodeInfo')
  const tag = info ? state.sliceDoc(info.from, info.to).split(/\s/, 1)[0] : ''
  if (tag.toLowerCase() === 'mermaid') return []

  const boundary = { fenceFrom: fence.from, fenceTo: closing.to }
  const ranges: CodeFoldRange[] = [{ ...boundary, from: opening.to, to: closing.to, kind: 'block' }]
  const language = LanguageDescription.matchLanguageName(languages, tag, false)
  if (!language?.support || !structuredLanguages.has(language.name)) return ranges
  const fenceTree = fence.tree
  let sections = fenceTree && sectionsByFence.get(fenceTree)
  if (!sections) {
    sections = collectSections(state, fence, state.doc.line(closing.number - 1).to)
    if (fenceTree) sectionsByFence.set(fenceTree, sections)
  }
  for (const { from, to } of sections) {
    ranges.push({ ...boundary, from: from + fence.from, to: to + fence.from, kind: 'section' })
  }
  return ranges
}

/** 遍历嵌入语言的语法节点，每行保留一个完整的多行折叠。 */
function collectSections(state: EditorState, fence: SyntaxNode, bodyEnd: number): FoldSpan[] {
  const code = fence.getChild('CodeText')
  const embedded = code && fence.enter(code.from, 1, IterMode.EnterBracketed)
  if (!embedded) return []
  const byLine = new Map<number, FoldSpan>()
  embedded.cursor().iterate(ref => {
    const fold = ref.type.prop(foldNodeProp)
    if (!fold) return
    const node = ref.node
    if (node.lastChild?.type.isError) return
    const section = fold(node, state)
    if (!section || section.from < code.from || section.to > bodyEnd) return
    const line = state.doc.lineAt(section.from)
    if (section.to <= line.to) return
    const previous = byLine.get(line.from)
    const to = section.to - fence.from
    if (!previous || to > previous.to) byLine.set(line.from, { from: section.from - fence.from, to })
  })
  return [...byLine.values()].sort((a, b) => a.from - b.from)
}

/** 按当前状态切换指定折叠。 */
export const toggleCodeFold = StateEffect.define<CodeFoldRange>()
/** 搜索跳转时展开挡住结果的每一层。 */
export const revealCodeFolds = StateEffect.define<FoldSpan>()
/** 切回渲染模式时展开全文。 */
export const clearCodeFolds = StateEffect.define<null>()
/** 放映时暂时取消折叠装饰。 */
export const suspendCodeFolding = StateEffect.define<boolean>()

/** 判断隐藏区间是否覆盖目标。光标可以停在折叠的两端。 */
function intersects(range: FoldSpan, from: number, to: number): boolean {
  return range.from < to && from < range.to
}

/** 判断两个折叠是否指向同一段代码。 */
function sameFold(a: CodeFoldRange, b: CodeFoldRange): boolean {
  return a.from === b.from && a.to === b.to && a.kind === b.kind &&
    a.fenceFrom === b.fenceFrom && a.fenceTo === b.fenceTo
}

/** 保存当前标签的折叠，正文变化和光标进入时展开受影响的范围。 */
const codeFoldField = StateField.define<CodeFoldState>({
  create: () => ({ ranges: [], suspended: false }),
  update(value, tr) {
    let { ranges, suspended } = value
    if (tr.docChanged && ranges.length) {
      ranges = ranges.filter(range => !tr.changes.touchesRange(range.fenceFrom, range.fenceTo)).map(range => ({
        ...range,
        from: tr.changes.mapPos(range.from),
        to: tr.changes.mapPos(range.to),
        fenceFrom: tr.changes.mapPos(range.fenceFrom),
        fenceTo: tr.changes.mapPos(range.fenceTo),
      }))
    }
    for (const effect of tr.effects) {
      if (effect.is(toggleCodeFold)) {
        const range = effect.value
        ranges = ranges.some(fold => sameFold(fold, range))
          ? ranges.filter(fold => !sameFold(fold, range))
          : [...ranges, range]
      } else if (effect.is(revealCodeFolds)) {
        const { from, to } = effect.value
        ranges = ranges.filter(range => !intersects(range, from, to))
      } else if (effect.is(clearCodeFolds)) {
        ranges = []
      } else if (effect.is(suspendCodeFolding)) {
        suspended = effect.value
      }
    }
    const selection = tr.selection
    if (selection && ranges.length) {
      ranges = ranges.filter(fold => !selection.ranges.some(({ head }) => intersects(fold, head, head)))
    }
    return ranges === value.ranges && suspended === value.suspended ? value : { ranges, suspended }
  },
})

/** 用于判断折叠事务是否需要重画预览。 */
export function codeFoldStateChanged(before: EditorState, after: EditorState): boolean {
  return before.field(codeFoldField, false) !== after.field(codeFoldField, false)
}

/** 选区覆盖折叠时，富文本的 DOM 缺少源码，复制应走文本。 */
export function codeFoldsIntersect(state: EditorState, from: number, to: number): boolean {
  const folds = state.field(codeFoldField, false)
  return !!folds && !folds.suspended && folds.ranges.some(range =>
    intersects(range, from, to) && isCurrentFold(state, range))
}

/** 围栏外的编辑也可能改变 Markdown 结构，只有实际显示的折叠才拦截操作。 */
function isCurrentFold(state: EditorState, range: CodeFoldRange): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolve(range.fenceFrom, 1); node; node = node.parent) {
    if (node.from < range.fenceFrom) return false
    if (node.name === 'FencedCode') return fenceFoldRanges(state, node).some(candidate => sameFold(candidate, range))
  }
  return false
}

/** 单光标从折叠边缘删除时先展开，明确选中的文字照常删除。 */
const revealBeforeDelete = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || !tr.isUserEvent('delete') || !tr.startState.selection.ranges.every(range => range.empty)) return tr
  const effects: StateEffect<FoldSpan>[] = []
  tr.changes.iterChangedRanges((from, to) => {
    if (codeFoldsIntersect(tr.startState, from, to)) effects.push(revealCodeFolds.of({ from, to }))
  })
  return effects.length ? { effects } : tr
})

export const codeFoldingState = [codeFoldField, revealBeforeDelete]

/** 使用同一按钮展开和折叠，切换时原地更新以保留键盘焦点。 */
class CodeFoldButton extends WidgetType {
  /** 当前界面语言的标签。 */
  private readonly label: string

  constructor(readonly range: CodeFoldRange, readonly expanded: boolean) {
    super()
    const copy = labels[getUiLanguage()]
    this.label = range.kind === 'block'
      ? (expanded ? copy.foldBlock : copy.unfoldBlock)
      : (expanded ? copy.foldSection : copy.unfoldSection)
  }

  eq(other: CodeFoldButton): boolean {
    return this.expanded === other.expanded && this.label === other.label && sameFold(this.range, other.range)
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `code-fold-btn code-fold-${this.range.kind}`
    button.contentEditable = 'false'
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>'
    button.addEventListener('click', () => {
      const state = view.state
      const range = this.range
      const collapsed = state.field(codeFoldField).ranges.some(fold => sameFold(fold, range))
      const head = state.selection.main.head
      view.dispatch({
        effects: toggleCodeFold.of(range),
        selection: !collapsed && intersects(range, head, head) ? { anchor: range.from } : undefined,
      })
    })
    this.setAttributes(button)
    return button
  }

  updateDOM(dom: HTMLElement, _view: EditorView, previous: CodeFoldButton): boolean {
    if (!sameFold(this.range, previous.range)) return false
    this.setAttributes(dom)
    return true
  }

  /** 向鼠标和辅助技术同时表达按钮操作及状态。 */
  private setAttributes(button: HTMLElement): void {
    button.title = this.label
    button.setAttribute('aria-label', this.label)
    button.setAttribute('aria-expanded', String(this.expanded))
  }
}

/** 组装围栏内可见的按钮和折叠装饰，外层收起时保留内层状态。 */
export function codeFoldDecorations(state: EditorState, fence: SyntaxNode) {
  const folds = state.field(codeFoldField, false)
  if (!folds || folds.suspended) return []
  const decorations: { from: number; to: number; deco: Decoration }[] = []
  let coveredUntil = -1
  for (const range of fenceFoldRanges(state, fence)) {
    if (range.from < coveredUntil) continue
    const expanded = !folds.ranges.some(fold => sameFold(fold, range))
    decorations.push({ from: range.from, to: range.from, deco: Decoration.widget({ widget: new CodeFoldButton(range, expanded), side: -1 }) })
    if (expanded) continue
    decorations.push({ from: range.from, to: range.to, deco: Decoration.replace({ inclusive: false }) })
    coveredUntil = range.to
  }
  return decorations
}
