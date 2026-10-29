import type { Text } from '@codemirror/state'

/** 不可变文本的全文表示随 Text 一起回收，不保留已关闭文档。 */
const strings = new WeakMap<Text, string>()

/** 多个观察者读取同一文档时只展开一次文本；局部读取仍应使用 sliceString。 */
export function documentText(doc: Text): string {
  let text = strings.get(doc)
  if (text === undefined) {
    text = doc.toString()
    strings.set(doc, text)
  }
  return text
}
