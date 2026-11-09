import { ViewPlugin } from '@codemirror/view'

/** 测量循环提前结束时，视口位置可能已经变更，正文却还停在旧位置。 */
export const scrollViewportRecovery = ViewPlugin.define(view => {
  const scroller = view.scrollDOM
  let frame: number | null = null

  const onScrollEnd = () => {
    if (frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      if (!view.inView || scroller.clientHeight === 0) return
      const gaps = view.contentDOM.querySelectorAll(':scope > .cm-gap')
      if (!gaps.length) return
      const top = scroller.getBoundingClientRect().top + scroller.clientTop
      const bottom = top + scroller.clientHeight
      // 只处理整段正文被占位盖住的情况，忽略边缘的少量估算误差。
      const minimumOverlap = 2 * view.defaultLineHeight
      for (const gap of gaps) {
        const rect = gap.getBoundingClientRect()
        if (Math.min(bottom, rect.bottom) - Math.max(top, rect.top) <= minimumOverlap) continue
        // 重新测量未必会重画已更新的视口，空事务会让正文同步到当前视口。
        view.dispatch({})
        break
      }
    })
  }

  scroller.addEventListener('scrollend', onScrollEnd)
  return {
    destroy() {
      scroller.removeEventListener('scrollend', onScrollEnd)
      if (frame !== null) cancelAnimationFrame(frame)
    },
  }
})
