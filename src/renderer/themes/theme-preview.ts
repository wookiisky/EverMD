import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { stateExtensions } from '../editor/state'
import { livePreview } from '../editor/live-preview'
import { editorTheme } from '../editor/source-theme'
import type { ThemeDefinition } from '../../shared/theme-config'
import { applyThemeToDocument } from './theme-document'

/** 独立文档中的只读样张，使用真实编辑器装饰，但不占用主编辑器句柄。 */
export class ThemePreview {
  /** 面板销毁时同时释放视图及其布局观察器。 */
  private view: EditorView | null = null
  /** 草稿样式仅进入 iframe，不能进入应用或导出快照。 */
  private mounted = false
  /** iframe 加载之前收到的最后一份草稿。 */
  private pending: ThemeDefinition | null = null

  // 预览与应用共享样式表和 Markdown 渲染规则。
  constructor(private readonly frame: HTMLIFrameElement, private readonly sample: string) {
    frame.addEventListener('load', () => this.mount(), { once: true })
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="editor"></div></body></html>'
  }

  // 初次加载后创建视图；不安装应用级文件、保存或导航监听。
  private mount(): void {
    const doc = this.frame.contentDocument
    if (!doc || !this.frame.isConnected) return
    const shared = doc.createElement('style')
    shared.textContent = Array.from(document.styleSheets)
      .filter(sheet => (sheet.ownerNode as HTMLElement | null)?.id !== 'colamd-active-theme')
      .flatMap(sheet => {
        try { return Array.from(sheet.cssRules, rule => rule.cssText) }
        catch { return [] }
      }).join('\n')
    doc.head.appendChild(shared)
    const layout = doc.createElement('style')
    layout.textContent = 'html,body{height:100%;overflow:hidden} body{--left-sidebar-space:0px;--right-sidebar-space:0px;--editor-top-gap:0px} #editor{position:static;height:100%;width:100%;margin:0} #editor .cm-content{width:100%;padding:24px;min-height:100%} .cm-cursor,.cm-selectionLayer{display:none!important}'
    doc.head.appendChild(layout)
    this.mounted = true
    // 全局编辑器字体继续高于主题；将实际偏好显式带进隔离文档。
    for (const name of ['has-custom-font', 'has-custom-font-size']) {
      doc.body.classList.toggle(name, document.body.classList.contains(name))
    }
    for (const name of ['--editor-font', '--editor-font-size']) {
      doc.body.style.setProperty(name, document.body.style.getPropertyValue(name))
    }
    this.view = new EditorView({
      parent: doc.getElementById('editor')!,
      state: EditorState.create({
        doc: this.sample,
        extensions: [stateExtensions(), editorTheme, livePreview, EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)]
      })
    })
    if (this.pending) this.update(this.pending)
  }

  // 替换单份草稿样式，避免每次取色都重建编辑器。
  update(theme: ThemeDefinition): void {
    this.pending = theme
    const doc = this.frame.contentDocument
    if (!doc || !this.mounted) return
    applyThemeToDocument(doc, theme)
    this.view?.requestMeasure()
  }

  // 移除面板时不留下 CodeMirror 布局任务。
  destroy(): void {
    this.view?.destroy()
    this.view = null
    this.pending = null
    this.mounted = false
  }
}
