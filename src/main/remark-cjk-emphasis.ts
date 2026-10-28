import type { Construct, Extension, Token, TokenizeContext } from 'micromark-util-types'
import { cjkEmphasisBoundary } from '../shared/cjk-emphasis-boundary'

// remark 的内建强调负责配对、三的倍数规则和嵌套，扩展只调整中文边界。
function standardAttention(context: TokenizeContext): Construct {
  const constructs = context.parser.constructs.text[42]
  return (Array.isArray(constructs) ? constructs : [constructs]).find(construct => construct?.name === 'attention')!
}

// 在原始语法阶段处理星号，不重解析解码后的文字，避免把转义或代码变成强调。
export function cjkEmphasisSyntax(source: string): Extension {
  const attention: Construct = {
    name: 'CJKAttention',
    tokenize(effects, ok, nok) {
      let sequence: Token
      return standardAttention(this).tokenize.call(this, {
        ...effects,
        exit(type) {
          const token = effects.exit(type)
          if (type === 'attentionSequence') sequence = token
          return token
        },
      }, code => {
        const before = source.slice(Math.max(0, sequence.start.offset - 2), sequence.start.offset).match(/[\s\S]$/u)?.[0] ?? ''
        const after = source.slice(sequence.end.offset, sequence.end.offset + 2).match(/^[\s\S]/u)?.[0] ?? ''
        const boundary = cjkEmphasisBoundary(before, after)
        if (boundary) {
          sequence._open = boundary.open
          sequence._close = boundary.close
        }
        return ok(code)
      }, nok)
    },
    resolveAll(events, context) {
      return standardAttention(context).resolveAll!(events, context)
    },
  }
  return { text: { 42: attention } }
}
