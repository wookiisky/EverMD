import { DocumentStatisticsScan, type DocumentStatistics } from './document-statistics'

/** 调度一次可取消的工作；测试可替换队列，生产始终让出当前主线程任务。 */
export type ScheduleStatisticsWork = (work: () => void) => () => void

/** 一个进行中的正文版本，只有全文扫描完成后才能发布。 */
interface StatisticsTask {
  /** 不可变正文值，也是同内容请求的复用依据。 */
  text: string
  /** 跨分块保持计数及相邻字符状态。 */
  scan: DocumentStatisticsScan
  /** 后来的同内容请求可更新语言或目标控件对应的回调。 */
  publish: (value: DocumentStatistics) => void
}

// 定时任务不会占住本轮绘制前回调，浏览器可在分块之间处理输入与布局。
function scheduleStatisticsWork(work: () => void): () => void {
  const timer = setTimeout(work, 0)
  return () => clearTimeout(timer)
}

/** 当前文档的统计任务；新正文替换旧任务，不持有多版本缓存链。 */
export class DocumentStatisticsScheduler {
  /** 当前待完成的扫描，用对象身份拒绝已经排队的旧回调。 */
  private task: StatisticsTask | null = null
  /** 当前排队任务的取消入口，完成或取消后释放闭包。 */
  private cancelScheduled: (() => void) | null = null
  /** 唯一一份完成结果的正文，切换到不同正文时立即释放。 */
  private cachedText: string | null = null
  /** 完整统计才可进入缓存。 */
  private cachedValue: DocumentStatistics | null = null

  // 调度器只负责单个任务队列，文档身份由调用方在发布时核对。
  constructor(private readonly schedule: ScheduleStatisticsWork = scheduleStatisticsWork) {}

  // 相同正文复用结果或扫描进度；新正文取消旧工作并在下一任务开始扫描。
  request(text: string, publish: (value: DocumentStatistics) => void): void {
    if (this.cachedText === text && this.cachedValue !== null) {
      publish(this.cachedValue)
      return
    }
    if (this.task?.text === text) {
      this.task.publish = publish
      return
    }
    this.cancel()
    this.cachedText = null
    this.cachedValue = null
    const task = { text, scan: new DocumentStatisticsScan(text), publish }
    this.task = task
    this.enqueue(task)
  }

  // 取消只释放进行中的任务，已完成结果可用于同正文的语言更新。
  cancel(): void {
    this.cancelScheduled?.()
    this.cancelScheduled = null
    this.task = null
  }

  // 每次只扫描一个有界片段，旧回调即使已出队也不能继续或发布。
  private enqueue(task: StatisticsTask): void {
    this.cancelScheduled = this.schedule(() => {
      if (this.task !== task) return
      this.cancelScheduled = null
      const value = task.scan.advance()
      if (value === null) {
        this.enqueue(task)
        return
      }
      this.task = null
      this.cachedText = task.text
      this.cachedValue = value
      task.publish(value)
    })
  }
}
