// 公式只在编辑器屏幕视图中缩小，CSS 负责把导出、打印与放映留在各自布局内。

/** 每个公式的清理函数，跟随 widget 的生命周期释放观察器与待执行测量。 */
const layouts = new WeakMap<HTMLElement, () => void>()

/** 根据真实文字宽度调整字号，保留公式比例，短公式不放大。 */
export function attachMathLayout(host: HTMLElement): void {
  const display = host.querySelector<HTMLElement>('.katex-display')
  const formula = display?.querySelector<HTMLElement>('.katex-html')
  if (!display || !formula) return
  const bases = Array.from(formula.querySelectorAll<HTMLElement>(':scope > .base'))
  const tag = formula.querySelector<HTMLElement>(':scope > .tag')
  if (bases.length === 0) return

  let frame = 0
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const style = getComputedStyle(host)
      const available = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const boxes = bases.map(base => base.getBoundingClientRect())
      const bodyWidth = Math.max(...boxes.map(box => box.right)) - Math.min(...boxes.map(box => box.left))
      // 保留 KaTeX 的居中正文与靠右编号，给编号两侧对称留位，避免缩小后互相覆盖。
      const tagSpace = tag ? 2 * (tag.getBoundingClientRect().width + parseFloat(getComputedStyle(display).fontSize)) : 0
      const width = bodyWidth + tagSpace
      if (available <= 0 || width <= 0) return
      // 从实际字号还原原宽度，避免反复测量时累计缩小；字体载入后也重新适配。
      const scale = parseFloat(getComputedStyle(display).fontSize) / parseFloat(style.fontSize)
      const next = Math.min(1, scale * available / width)
      if (Math.abs(next - Number(host.style.getPropertyValue('--math-scale') || 1)) > 0.0001) {
        host.style.setProperty('--math-scale', String(next))
      }
    })
  })
  observer.observe(host)
  for (const base of bases) observer.observe(base)
  if (tag) observer.observe(tag)
  layouts.set(host, () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  })
}

/** 公式移出视口或进入源码编辑时，取消它的布局工作。 */
export function detachMathLayout(host: HTMLElement): void {
  layouts.get(host)?.()
  layouts.delete(host)
}
