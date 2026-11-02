import { scanMath, type Excluded } from './math-scan'
import { renderMath } from './math-render'
import { resolveImageSrc } from './image-source'

/**
 * 单元格里的行内内容。
 *
 * 用 DOM 拼，不拼 innerHTML：单元格内容来自用户的文件，拼字符串等于把文件里的
 * `<img onerror=...>` 直接执行掉。这里只认粗体、斜体、行内代码、删除线、链接、
 * 图片、公式和 `<br>`，认不出来的就当普通文字。
 *
 * `<br>` 与图片是 #138 补上的：Obsidian、Typora、GitHub 都把格子里的 `<br/>` 画成
 * 换行，把格子里的 `![](x.png)` 画成图片；2.6 也这样，换内核后这两样都退成了纯文字。
 * 行内 HTML 里只有 `<br>` 被认：它是最常跟表格一起用的一个，而其它标签（尤其是带
 * 事件或样式的）放进表格只会多一个要防的口子。
 *
 * 下划线强调要卡词边界（#161）。CommonMark 与 GFM 里 `_` 不能跨在词中间生效，
 * 所以 `local_upload / external_api` 是两个普通单词，`snake_case_name` 也一样；
 * 这里早期只写了 `_` 配对，会把中间那段吃掉变成斜体，连下划线本身也不见了。
 * `*` 不受这条限制（`a*b*c` 在 CommonMark 里确实是斜体），所以两个分支分开写。
 * 边界用 Unicode 字母与数字，中文也算词字符。
 */
const INLINE_RE =
  /\*\*(?<strong>.+?)\*\*|(?<![\p{L}\p{N}_])__(?<strongU>(?=\S).+?(?<=\S))__(?![\p{L}\p{N}_])|\*(?<em>.+?)\*|(?<![\p{L}\p{N}_])_(?<emU>(?=\S).+?(?<=\S))_(?![\p{L}\p{N}_])|`(?<code>[^`]+)`|~~(?<strike>.+?)~~|!\[(?<alt>[^\]]*)\]\(\s*(?<src><[^>]*>|[^)\s]+)[^)]*\)|\[(?<linkText>[^\]]*)\]\((?<href>[^)]*)\)|<br\s*\/?>|(?<html><\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*|\/)?>)/dgiu

/** 代码、图片及地址不是公式；链接文字仍可包含公式。 */
const LITERAL_RE = /`(?<code>[^`]+)`|!\[(?<alt>[^\]]*)\]\(\s*(?<src><[^>]*>|[^)\s]+)[^)]*\)|\[(?<label>[^\]]*)\]\((?<href>[^)]*)\)/dgiu

/** 渲染单元格内容，先保护公式内部标记，再解析 Markdown 强调。 */
export function appendTableInline(parent: HTMLElement, text: string, base: string | null): void {
  const excluded: Excluded[] = []
  for (const match of text.matchAll(LITERAL_RE)) {
    const address = match.indices?.groups?.href
    const [from, to] = address ?? [match.index, match.index + match[0].length]
    excluded.push({ from, to })
  }
  const math = scanMath(text, excluded)
  // 保持偏移不变；占位字符既不是 Markdown 分隔符，也不能被误认成 HTML 标签名。
  const masked = text.split('')
  for (const range of math) masked.fill('\uFFFC', range.from, range.to)
  const matches = [...masked.join('').matchAll(INLINE_RE)]

  // 这里只画当前文本片段里的公式；外层强调/链接会递归绘制自己的正文。
  const appendText = (from: number, to: number): void => {
    let start = from
    for (const range of math) {
      if (range.from < from || range.to > to) continue
      parent.appendChild(document.createTextNode(text.slice(start, range.from)))
      parent.appendChild(renderMath(range.code, false, text.slice(range.from, range.to)))
      start = range.to
    }
    parent.appendChild(document.createTextNode(text.slice(start, to)))
  }
  let last = 0
  for (const match of matches) {
    appendText(last, match.index)
    // 匹配发生在掩码上，内容始终从原文及匹配区间读取。
    const group = (name: string): string | undefined => {
      const range = match.indices?.groups?.[name]
      return range ? text.slice(range[0], range[1]) : undefined
    }
    const strong = group('strong') ?? group('strongU')
    const emphasis = group('em') ?? group('emU')
    const code = group('code')
    const strike = group('strike')
    const alt = group('alt')
    const label = group('linkText')
    if (strong !== undefined || emphasis !== undefined || strike !== undefined) {
      const element = document.createElement(strong !== undefined ? 'strong' : emphasis !== undefined ? 'em' : 's')
      appendTableInline(element, strong ?? emphasis ?? strike ?? '', base)
      parent.appendChild(element)
    } else if (code !== undefined) {
      const element = document.createElement('code')
      element.textContent = code
      parent.appendChild(element)
    } else if (alt !== undefined) {
      const image = document.createElement('img')
      image.src = resolveImageSrc(group('src') ?? '', base)
      image.alt = alt
      parent.appendChild(image)
    } else if (label !== undefined) {
      const element = document.createElement('a')
      const href = (group('href') ?? '').trim()
      if (label) appendTableInline(element, label, base)
      else element.textContent = href
      // 本地文件和文内锚点交给统一导航处理器。
      if (href) element.setAttribute('data-href', href)
      if (/^https?:\/\//i.test(href)) element.setAttribute('href', href)
      parent.appendChild(element)
    } else if (group('html') !== undefined) {
      // 在公式完成识别后保留未知标签，比较号不能先被当作 HTML 吞掉。
      parent.appendChild(document.createTextNode(text.slice(match.index, match.index + match[0].length)))
    } else {
      parent.appendChild(document.createElement('br'))
    }
    last = match.index + match[0].length
  }
  appendText(last, text.length)
}
