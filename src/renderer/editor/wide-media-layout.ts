import { ViewPlugin } from '@codemirror/view'

/** 使用滚动条以内的真实宽度，保持全宽内容与正文共用同一个居中区域。 */
export const wideMediaLayout = ViewPlugin.define(view => {
  const measurement = {
    read: () => view.scrollDOM.clientWidth,
    write: (width: number) => {
      view.scrollDOM.style.setProperty('--editor-available-width', `${width}px`)
    },
  }
  // 观察内容区也能捕获滚动条出现或消失，不需要独立维护窗口与侧栏状态。
  const observer = new ResizeObserver(() => view.requestMeasure(measurement))
  observer.observe(view.scrollDOM)
  view.requestMeasure(measurement)
  return {
    destroy() {
      observer.disconnect()
      view.scrollDOM.style.removeProperty('--editor-available-width')
    },
  }
})
