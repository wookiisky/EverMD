import { ViewPlugin } from '@codemirror/view'
import { measureMathNaturalWidth } from './math-layout'

/** 水平方向的内边距和边框也占用普通正文列宽。 */
function horizontalInsets(element: HTMLElement): number {
  const style = getComputedStyle(element)
  return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
}

/** 原列宽放不下的内容才扩宽，使用滚动条以内的真实宽度保留两侧留白。 */
export const wideMediaLayout = ViewPlugin.define(view => {
  const measurement = {
    read: () => {
      // 默认关闭时只维护编辑区宽度，不为未启用的布局测量表格和公式。
      if (!document.body.classList.contains('wide-media')) return { width: view.scrollDOM.clientWidth, entries: [] }
      const normalWidth = view.contentDOM.getBoundingClientRect().width - horizontalInsets(view.contentDOM)
      const lines = view.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-line:is(.cm-md-table-standalone, .cm-md-image-standalone, .cm-md-mermaid-standalone, :has(> .cm-md-math-block))')
      const tables = Array.from(lines).flatMap(line => Array.from(line.querySelectorAll<HTMLElement>(':scope > .cm-md-table-widget')))
      const savedWidths = tables.map(table => ({ table, value: table.style.getPropertyValue('width'), priority: table.style.getPropertyPriority('width') }))
      const tableWidths = new Map<HTMLElement, number>()
      // 同步批量测量真实表格：消除软换行，保留显式换行及当前主题，恢复后才提交布局。
      // 只触碰 widget 自身，CodeMirror 不会把它当成正文编辑；不复制或插入渲染树。
      try {
        for (const table of tables) table.style.setProperty('width', 'max-content', 'important')
        for (const table of tables) tableWidths.set(table, table.getBoundingClientRect().width)
      } finally {
        for (const { table, value, priority } of savedWidths) {
          if (value) table.style.setProperty('width', value, priority)
          else table.style.removeProperty('width')
        }
      }
      const entries: { host: HTMLElement; needed: boolean }[] = []
      for (const line of lines) {
        const host = line.querySelector<HTMLElement>(':scope > .cm-md-table-widget, .cm-md-image:not(.cm-md-image-failed), :scope > .cm-md-mermaid-ready:not(.cm-md-mermaid-failed), :scope > .cm-md-math-block:not(.cm-md-math-error)')
        if (!host) continue
        const image = host.querySelector<HTMLImageElement>('img')
        const svg = host.querySelector<SVGSVGElement>(':scope > svg')
        const naturalWidth = tableWidths.get(host) ?? (image ? image.naturalWidth + horizontalInsets(host)
          : svg ? svg.width.baseVal.value + horizontalInsets(host)
          : measureMathNaturalWidth(host) + horizontalInsets(host))
        // 含列表缩进及图表代码块内边距；允许小数像素误差，避免临界尺寸反复切换。
        entries.push({ host, needed: naturalWidth > normalWidth - horizontalInsets(line) + 0.5 })
      }
      return { width: view.scrollDOM.clientWidth, entries }
    },
    write: ({ width, entries }: { width: number; entries: { host: HTMLElement; needed: boolean }[] }) => {
      const value = `${width}px`
      if (view.scrollDOM.style.getPropertyValue('--editor-available-width') !== value) {
        view.scrollDOM.style.setProperty('--editor-available-width', value)
      }
      for (const { host, needed } of entries) {
        if (host.hasAttribute('data-wide-media-needed') !== needed) host.toggleAttribute('data-wide-media-needed', needed)
      }
    },
  }
  const schedule = () => view.requestMeasure(measurement)
  // 内容尺寸和异步渲染也会变化；限定观察字段，排除测量样式和结果属性，避免自身循环。
  const observer = new ResizeObserver(schedule)
  observer.observe(view.scrollDOM)
  observer.observe(view.contentDOM)
  const contentObserver = new MutationObserver(schedule)
  contentObserver.observe(view.contentDOM, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  const preferenceObserver = new MutationObserver(schedule)
  preferenceObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  view.contentDOM.addEventListener('load', schedule, true)
  document.fonts.addEventListener('loadingdone', schedule)
  schedule()
  return {
    update(update) {
      if (update.docChanged || update.viewportChanged) schedule()
    },
    destroy() {
      observer.disconnect()
      contentObserver.disconnect()
      preferenceObserver.disconnect()
      view.contentDOM.removeEventListener('load', schedule, true)
      document.fonts.removeEventListener('loadingdone', schedule)
      for (const host of view.contentDOM.querySelectorAll('[data-wide-media-needed]')) host.removeAttribute('data-wide-media-needed')
      view.scrollDOM.style.removeProperty('--editor-available-width')
    },
  }
})
