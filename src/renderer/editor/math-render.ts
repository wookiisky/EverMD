import katex from 'katex'

/** 共用公式绘制规则，失败时显示调用处保留的原文。 */
export function renderMath(code: string, block: boolean, source: string): HTMLElement {
  const element = document.createElement(block ? 'div' : 'span')
  element.className = block ? 'cm-md-math cm-md-math-block' : 'cm-md-math cm-md-math-inline'
  try {
    element.innerHTML = katex.renderToString(code, {
      displayMode: block,
      throwOnError: true,
      // 文件里的公式不能启用 KaTeX 的受信任 HTML 命令。
      trust: false,
    })
  } catch {
    element.textContent = source
    element.classList.add('cm-md-math-error')
  }
  return element
}
