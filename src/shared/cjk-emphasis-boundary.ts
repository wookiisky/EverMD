// 中文强调只放宽星号旁的边界，两个解析器仍各自负责配对和嵌套。
const cjkCharacter = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u
const fullwidthCharacter = /[\uFF01-\uFF60\uFFE0-\uFFE6]/u
const whitespace = /\s|^$/u

/** 中文星号串可开闭的方向；null 表示沿用标准 Markdown 边界。 */
export function cjkEmphasisBoundary(before: string, after: string): { open: boolean; close: boolean } | null {
  const cjkBefore = cjkCharacter.test(before) || fullwidthCharacter.test(before)
  const cjkAfter = cjkCharacter.test(after) || fullwidthCharacter.test(after)
  if (!cjkBefore && !cjkAfter) return null
  return { open: !whitespace.test(after), close: !whitespace.test(before) }
}
