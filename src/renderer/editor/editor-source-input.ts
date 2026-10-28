import type { ChangeSet } from '@codemirror/state'

/** 源码的程序化编辑携带真实变更，让导航位置保留未修改的文本区间。 */
export class SourceInputEvent extends Event {
  /** 以输入前的文本为基准，包含本次编辑的所有不连续修改。 */
  readonly changes: ChangeSet

  /** 沿用原生 input 通知，正文同步、已编辑状态与导航观察同一次操作。 */
  constructor(changes: ChangeSet) {
    super('input', { bubbles: true })
    this.changes = changes
  }
}
