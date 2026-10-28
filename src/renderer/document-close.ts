import type { DocumentCloseChoice } from '../shared/document-close-config'

/** 标签状态由外壳拥有；关闭协调只复用激活、确认与保存，不删除标签。 */
export interface DocumentCloseHost {
  /** 进入确认流程前的活动标签。 */
  activeId(): string | null
  /** 所有未保存标签，包括没有路径的后台标签。 */
  dirtyIds(): string[]
  /** 激活目标时不顺带保存正在离开的文档。 */
  activate(id: string): Promise<boolean>
  /** 丢弃前已经成功写入恢复副本，失败则取消。 */
  confirm(): Promise<DocumentCloseChoice>
  /** 使用活动文档已有的保存及另存为路径。 */
  save(): Promise<boolean>
}

// 每篇文档单独决定；失败或取消保留标签与未保存内容。
export async function prepareDocumentsForClose(host: DocumentCloseHost): Promise<boolean> {
  const original = host.activeId()
  try {
    for (const id of host.dirtyIds()) {
      if (!await host.activate(id)) return false
      const choice = await host.confirm()
      if (choice === 'cancel') return false
      if (choice === 'save' && !await host.save()) return false
    }
    return true
  } finally {
    if (original) await host.activate(original)
  }
}
