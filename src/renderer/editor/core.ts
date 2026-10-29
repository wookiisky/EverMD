// 编辑器核心：源码缓冲区是唯一真相。
//
// 这个文件取代了原来的 milkdown/ProseMirror 核心。设计原则见
// docs/editor-architecture.md，一句话：**缓冲区里存的就是文件的字节，渲染是叠在
// 它上面的一层装饰。** 保存时把缓冲区原样写回，不做任何序列化。
//
// 由此得到一条可以在 CI 里断言的纪律：用户没改过的字节，保存时不变。
//
// 这一层需要 DOM（EditorView 要做布局测量）。不依赖 DOM 的那一半在 state.ts 里，
// 验收脚本直接消费那一半，所以保真的证明不需要真实浏览器。

import { EditorState, RangeSet, type Extension, type StateEffect, type Text } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, rectangularSelection, crosshairCursor, Decoration, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { undo, redo } from '@codemirror/commands'
import { livePreview, setEditorFocus, editorFocusField, documentFileUrlField, setDocumentFileUrlEffect, primeDocumentFileUrl } from './live-preview'
import type { Tree } from '@lezer/common'
import { hideBlankLinesField, setHideBlankLinesEffect } from './blank-line-visibility'
import { documentText } from './document-text'
import { listInput } from './list-input'
import { searchHighlightField } from './search-highlight'
import { stateExtensions, editableCompartment, bodyStart } from './state'
import { editorTheme } from './source-theme'
import { cursorColors } from './cursor-colors'
import { wideMediaLayout } from './wide-media-layout'

/** 与目标文档一起安装的显示配置，不属于编辑历史。 */
export interface DocumentViewOptions {
  /** 相对图片的基准；null 表示无路径文档，省略时保留现有状态。 */
  fileUrl?: string | null
  /** 应用当前的空行显示偏好，省略时保留现有状态。 */
  hideBlankLines?: boolean
}

/** 编辑器首次创建时的内容、回调与显示配置。 */
export interface EditorOptions extends DocumentViewOptions {
  /** 初始文本。就是文件的字节。 */
  doc?: string
  /** 文档变化时回调，参数是当前完整文本。 */
  onChange?: (markdown: string) => void
  /** 是否可编辑（放映幻灯片时会锁住）。 */
  editable?: boolean
}

/** 编辑器对外句柄。外壳只认这个，不认 CodeMirror。 */export interface EditorHandle {
  /** 当前缓冲区内容，即文件应有的字节。 */
  getText(): string
  /** 替换全文；clearHistory 用于新文档和外部重载，同时安装目标显示配置。 */
  setText(text: string, clearHistory?: boolean, options?: DocumentViewOptions): void
  /** 把光标放到文档末尾的下一行（追加内容用）。 */
  appendText(text: string): void
  /** 聚焦。 */
  focus(): void
  /** 设置是否可编辑。 */
  setEditable(editable: boolean): void
  /** 撤销 / 重做。 */
  undo(): void
  redo(): void
  /** 拿到底层 view（装饰层、搜索面板需要）。 */
  getView(): EditorView
  /** 销毁。 */
  destroy(): void
}

let handle: EditorHandle | null = null
/** 外壳观察选区与文本变更，不参与文档事务。 */
const updateObservers = new Set<(update: ViewUpdate) => void>()

/** 注册编辑器状态观察器，返回解除函数。 */
export function onEditorUpdate(observer: (update: ViewUpdate) => void): () => void {
  updateObservers.add(observer)
  return () => { updateObservers.delete(observer) }
}

export function getEditorHandle(): EditorHandle | null {
  return handle
}

/**
 * 任务项的方框（`[ ]` / `[x]`）当作原子区间。
 *
 * 它被换成了一个 checkbox widget，但替换本身不拦光标：不声明的话光标能停在两个方框
 * 之间那一格里，看不见自己在哪，按左右键要一格一格试（#164）。声明成原子区间后，
 * 左右键一次跨过整个复选框。
 *
 * 范围从语法树上取，所以只覆盖眼下已经解析过的那一段；远处的任务项滚过去、被解析
 * 之后才变成原子，而光标本来也去不了没解析的地方，这个精度够用。
 */
const taskMarkerAtomicRanges = EditorView.atomicRanges.of((view) => taskMarkerRanges(view.state))

/** 每份文档只保留当前语法树对应的原子范围，选区变化无需遍历语法树。 */
const taskRangesByDocument = new WeakMap<Text, { tree: Tree; ranges: RangeSet<Decoration> }>()

/** 任务标记范围随文档或惰性语法树推进失效。 */
export function taskMarkerRanges(state: EditorState): RangeSet<Decoration> {
  const doc = state.doc
  const tree = syntaxTree(state)
  const cached = taskRangesByDocument.get(doc)
  if (cached?.tree === tree) return cached.ranges
  const ranges: { from: number; to: number }[] = []
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'TaskMarker') return
      const line = doc.lineAt(node.from)
      // 行的前缀（`- ` / `* ` / `1. `）也算进来：光标停在 `-` 和 `[` 之间打字，
      // 列表标记就没了；停在 `]` 和正文之间打字，`[x]` 后面不再跟空格，任务语法也拆了。
      // 两种都是 `TaskMarker` 看着还在、下一帧就变回源码的那种怪事（#164）。
      const prefix = doc.sliceString(line.from, node.from)
      const from = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+$/.test(prefix) ? line.from : node.from
      const trailing = doc.sliceString(node.to, Math.min(node.to + 1, line.to)) === ' ' ? node.to + 1 : node.to
      ranges.push({ from, to: trailing })
    },
  })
  // 这个值不参与绘制，只借 Range 的形状把位置报上去。
  const result = RangeSet.of(ranges.map((r) => ATOMIC_MARK.range(r.from, r.to)), true)
  taskRangesByDocument.set(doc, { tree, ranges: result })
  return result
}

const ATOMIC_MARK = Decoration.replace({})

/** 只更新确实变化的配置，合并后最多触发一次装饰重建。 */
function documentViewEffects(state: EditorState, options: DocumentViewOptions): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = []
  if (options.fileUrl !== undefined && options.fileUrl !== state.field(documentFileUrlField)) {
    effects.push(setDocumentFileUrlEffect.of(options.fileUrl))
  }
  if (options.hideBlankLines !== undefined && options.hideBlankLines !== state.field(hideBlankLinesField)) {
    effects.push(setHideBlankLinesEffect.of(options.hideBlankLines))
  }
  return effects
}

/** 新文档的路径、偏好与焦点在首次装饰生成前就位，历史和搜索由新状态重置。 */
export function createDocumentState(text: string, extensions: Extension, options: DocumentViewOptions, focused = false): EditorState {
  const fileUrl = options.fileUrl ?? null
  primeDocumentFileUrl(fileUrl)
  return EditorState.create({
    doc: text,
    selection: { anchor: bodyStart(text) },
    extensions: [extensions,
      documentFileUrlField.init(() => fileUrl),
      hideBlankLinesField.init(() => options.hideBlankLines ?? false),
      editorFocusField.init(() => focused),
    ],
  })
}

/** 恢复快照仅同步显示配置，保留文档对象、选区、搜索和撤销历史。 */
export function configureDocumentState(state: EditorState, options: DocumentViewOptions = {}): EditorState {
  primeDocumentFileUrl(options.fileUrl === undefined ? state.field(documentFileUrlField) : options.fileUrl)
  const effects = documentViewEffects(state, options)
  return effects.length ? state.update({ effects }).state : state
}

export function createEditorCore(parent: HTMLElement, options: EditorOptions = {}): EditorHandle {
  const changeListener = options.onChange

  const extension = [
    // 状态层：语言、高亮、撤销栈、缩进、快捷键（无 DOM，可进 harness）
    stateExtensions(),
    // 以下是 view 层：选区绘制、拖放光标、特殊字符、主题
    drawSelection(),
    cursorColors,
    wideMediaLayout,
    // 自动换行。CodeMirror 默认**不换行**，长行会横向滚动；markdown 正文必须换行。
    EditorView.lineWrapping,
    dropCursor(),
    highlightSpecialChars(),
    rectangularSelection(),
    crosshairCursor(),
    editorTheme,
    // 装饰层：把源码画成所见即所得。它只画不写，所以装在这里不会影响
    // 「没改过的字节不许变」这条纪律。
    livePreview,
    // 焦点变化要重算装饰：只有**正在编辑**的那一行才显示源码（见 live-preview 的 setEditorFocus）。
    // 用 DOM 事件而不是 EditorView.focusChangeEffect，是因为后者在创建时就已带焦点的编辑器上
    // 不会触发；下面创建完 view 之后补了一次初始值。
    EditorView.domEventHandlers({
      focus: (_event, view) => {
        if (view.dom.isConnected) view.dispatch({ effects: setEditorFocus.of(true) })
        return false
      },
      blur: (_event, view) => {
        if (view.dom.isConnected) view.dispatch({ effects: setEditorFocus.of(false) })
        return false
      },
    }),
    // 回车续列表。这是编辑器的输入手感，与渲染无关，所以单独一个模块。
    listInput,
    // 检索高亮。面板靠 effect 改它，而 effect 得有 StateField 接住；
    // 不装这一条，检索面板会以为高亮画上了，实际什么也没发生。
    searchHighlightField,
    // 任务项的复选框是一个 replace widget，但没声明成原子区间时，光标能停在
    // `[ ]` 两个方框之间那一格里：左右键要一格一格挪过去，停在里面打字又把
    // `- [ ]` 敲成 `- [x]` 之类的残骸（#164）。声明成原子区间后，光标一次跨过它。
    taskMarkerAtomicRanges,
    editableCompartment.of([
      EditorView.editable.of(options.editable ?? true),
      EditorState.readOnly.of(options.editable === false),
    ]),
    // 文档变化的唯一出口：把新文本交给外壳
    EditorView.updateListener.of((update) => {
      for (const observer of updateObservers) observer(update)
      if (update.docChanged && changeListener) {
        changeListener(documentText(update.state.doc))
      }
    }),
  ]

  const view = new EditorView({
    state: createDocumentState(options.doc ?? '', extension, options),
    parent,
  })

  // 创建时就已经带焦点的编辑器不会触发 focus 事件（它一直是焦点），这里补一次初始值。
  // 不做这一步，用户一打开文件就打字，标记却不会显形。
  if (view.hasFocus) view.dispatch({ effects: setEditorFocus.of(true) })

  const api: EditorHandle = {
    getText: () => documentText(view.state.doc),

    setText(text: string, clearHistory = false, settings: DocumentViewOptions = {}): void {
      const state = view.state
      const nextSettings = {
        fileUrl: settings.fileUrl === undefined ? state.field(documentFileUrlField) : settings.fileUrl,
        hideBlankLines: settings.hideBlankLines ?? state.field(hideBlankLinesField),
      }
      if (clearHistory) {
        // 新文档重置撤销与选区，路径和偏好在首次装饰计算前已经就位。
        view.setState(createDocumentState(text, extension, nextSettings, view.hasFocus))
        return
      }
      const changed = documentText(state.doc) !== text
      const effects = documentViewEffects(state, nextSettings)
      if (!changed && !effects.length) return
      // 当前文档的程序化同步合并文本与配置，不受仅限制用户写入的只读过滤影响。
      primeDocumentFileUrl(nextSettings.fileUrl)
      const next = state.update({
        changes: changed ? { from: 0, to: state.doc.length, insert: text } : undefined,
        effects,
        filter: false,
      }).state
      view.setState(next)
    },

    appendText(text: string): void {
      const end = view.state.doc.length
      const needsBreak = end > 0 && view.state.doc.sliceString(end - 1, end) !== '\n'
      view.dispatch({
        changes: { from: end, insert: (needsBreak ? '\n' : '') + text },
        selection: { anchor: end + (needsBreak ? 1 : 0) + text.length },
      })
      view.focus()
    },

    focus: () => view.focus(),
    setEditable(editable: boolean): void {
      view.dispatch({ effects: editableCompartment.reconfigure([
        EditorView.editable.of(editable), EditorState.readOnly.of(!editable),
      ]) })
    },
    undo: () => { undo(view) },
    redo: () => { redo(view) },
    getView: () => view,
    destroy(): void {
      view.destroy()
      handle = null
    },
  }

  handle = api
  return api
}
