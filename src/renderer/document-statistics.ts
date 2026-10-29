/** 文档统计沿用现有字符、词和段落定义，与 Markdown 渲染方式无关。 */
export interface DocumentStatistics {
  /** 排除空白后的 UTF-16 单位数，保留原先对 emoji 等字符的计数方式。 */
  characters: number
  /** 中日韩单字、英文连续词及带小数点或逗号的数字数量。 */
  tokens: number
  /** 以至少两个换行分隔的非空正文段数量。 */
  paragraphs: number
}

const unicodeWhitespace = /\s/

/** 同步与分段统计共用扫描器，分段之间保留词和换行的边界状态。 */
export class DocumentStatisticsScan {
  /** 下一个待扫描的 UTF-16 位置。 */
  private position = 0
  /** 已完成片段的字符数。 */
  private characters = 0
  /** 已完成片段的词数。 */
  private tokens = 0
  /** 已完成片段的段落数。 */
  private paragraphs = 0
  /** 首个非空白字符开始第一段，之后两个换行才开始下一段。 */
  private lineBreaks = 2
  /** 前一个 UTF-16 单位，跨片段保留 CRLF 和词连接语义。 */
  private previous = 0
  /** 前两个 UTF-16 单位，判断英文连接符和数字分隔符。 */
  private beforePrevious = 0

  // 扫描期间持有单个不可变正文值，不复制各片段。
  constructor(private readonly text: string) {}

  // 默认片段兼顾响应与定时器次数；仅在全文完成后返回可展示的统计。
  advance(maxUnits = 256 * 1024): DocumentStatistics | null {
    const text = this.text
    const end = Math.min(text.length, this.position + maxUnits)
    let { characters, tokens, paragraphs, lineBreaks, previous, beforePrevious } = this

    for (let index = this.position; index < end; index++) {
      const code = text.charCodeAt(index)
      const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      const digit = code >= 48 && code <= 57
      // 这些范围是原统计正则的词边界契约，不能换成更宽的 Unicode 字母分类。
      const cjk = (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0x3040 && code <= 0x30ff)
        || (code >= 0xac00 && code <= 0xd7af)
      const whitespace = code <= 32
        ? code === 32 || (code >= 9 && code <= 13)
        : code > 126 && !cjk && unicodeWhitespace.test(text[index])
  
      if (whitespace) {
        // CRLF 是一个换行；单独的 CR 与 LF 各算一个，等同原来的规范化。
        if (code === 13 || (code === 10 && previous !== 13)) lineBreaks++
      } else {
        characters++
        if (lineBreaks >= 2) paragraphs++
        lineBreaks = 0
      }
  
      if (cjk) {
        tokens++
      } else if (letter) {
        const previousLetter = (previous >= 65 && previous <= 90) || (previous >= 97 && previous <= 122)
        const connector = previous === 39 || previous === 0x2019 || previous === 92 || previous === 45
        const beforeLetter = (beforePrevious >= 65 && beforePrevious <= 90) || (beforePrevious >= 97 && beforePrevious <= 122)
        // 连接符两边必须都是英文字母；连续连接符会把词断开。
        if (!previousLetter && !(connector && beforeLetter)) tokens++
      } else if (digit) {
        const previousDigit = previous >= 48 && previous <= 57
        const separator = previous === 46 || previous === 44
        const beforeDigit = beforePrevious >= 48 && beforePrevious <= 57
        if (!previousDigit && !(separator && beforeDigit)) tokens++
      }
  
      beforePrevious = previous
      previous = code
    }
    this.position = end
    this.characters = characters
    this.tokens = tokens
    this.paragraphs = paragraphs
    this.lineBreaks = lineBreaks
    this.previous = previous
    this.beforePrevious = beforePrevious
    return end === text.length ? { characters, tokens, paragraphs } : null
  }
}

// 同步调用使用相同扫描核心，短文档与现有差分测试保持原接口。
export function computeDocumentStatistics(text: string): DocumentStatistics {
  return new DocumentStatisticsScan(text).advance(text.length)!
}
