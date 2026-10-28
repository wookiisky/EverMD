import { InlineContext, type MarkdownConfig } from '@lezer/markdown'
import { cjkEmphasisBoundary } from '../../shared/cjk-emphasis-boundary'

/** 星号在中文或全角标点旁允许强调，纯英文和下划线保留标准边界。 */
export const cjkEmphasis: MarkdownConfig = {
  parseInline: [{
    name: 'CJKEmphasis',
    before: 'Emphasis',
    // 只接管有中文上下文的星号串；代码和转义在更早的解析阶段已被消费。
    parse(context, next, start) {
      if (next !== 42) return -1
      let end = start + 1
      while (context.char(end) === next) end++

      // 最多读取两个 UTF-16 单元，确保补充平面汉字不会被拆成半个字符。
      const before = context.slice(Math.max(context.offset, start - 2), start).match(/[\s\S]$/u)?.[0] ?? ''
      const after = context.slice(end, end + 2).match(/^[\s\S]/u)?.[0] ?? ''
      const boundary = cjkEmphasisBoundary(before, after)
      if (!boundary) return -1

      // 任一侧的中文字符已提供标点边界，剩下只约束强调内侧不能是空白。
      // 复用内建 delimiter 身份，单双星号、嵌套与三的倍数规则仍由原解析器配对。
      return context.addDelimiter(InlineContext.emphasisAsterisk, start, end,
        boundary.open, boundary.close)
    }
  }]
}
