import { InlineContext, type MarkdownConfig } from '@lezer/markdown'

// 使用 Unicode 文字属性和全角字符区间识别中文上下文，不枚举具体标点。
const cjkCharacter = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u
const fullwidthCharacter = /[\uFF01-\uFF60\uFFE0-\uFFE6]/u
const whitespace = /\s|^$/u

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
      const before = context.slice(Math.max(context.offset, start - 2), start).match(/.$/u)?.[0] ?? ''
      const after = context.slice(end, end + 2).match(/^./u)?.[0] ?? ''
      const cjkBefore = cjkCharacter.test(before) || fullwidthCharacter.test(before)
      const cjkAfter = cjkCharacter.test(after) || fullwidthCharacter.test(after)
      if (!cjkBefore && !cjkAfter) return -1

      // 任一侧的中文字符已提供标点边界，剩下只约束强调内侧不能是空白。
      // 复用内建 delimiter 身份，单双星号、嵌套与三的倍数规则仍由原解析器配对。
      return context.addDelimiter(InlineContext.emphasisAsterisk, start, end,
        !whitespace.test(after), !whitespace.test(before))
    }
  }]
}
