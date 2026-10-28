/** 关闭前对单篇未保存文档的决定；丢弃只在恢复副本写入后返回。 */
export type DocumentCloseChoice = 'save' | 'discard' | 'cancel'

/** 确认框描述当前活动文档，正文同时用于保留恢复副本。 */
export interface DocumentCloseRequest {
  /** 已命名文件的完整路径，未命名时为 null。 */
  path: string | null
  /** 当前缓冲区中尚未保存的完整字节。 */
  content: string
}
