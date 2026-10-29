import type { FilePanelRow } from './file-panel-model'

/** 三种行在当前主题和缩放下的真实高度，包含返回行的额外间距。 */
export interface FilePanelDimensions {
  /** 普通文件和目录行高度。 */
  normal: number
  /** 返回上一级行高度。 */
  parent: number
  /** 空目录提示可换行，按缩进深度记录实际高度。 */
  empty: ReadonlyMap<number, number>
  /** 相邻行之间的 CSS gap。 */
  gap: number
}

/** 完整列表的几何索引，滚动时只做二分查找，不重新遍历目录数据。 */
export class FilePanelWindow {
  /** 每行起点和最后一行之后的起点。 */
  private readonly offsets: Float64Array
  /** 整个列表高度，不包含末尾不存在的 gap。 */
  readonly height: number

  // 数据或行尺寸变化时建立一次位置索引。
  constructor(rows: readonly FilePanelRow[], dimensions: FilePanelDimensions) {
    this.offsets = new Float64Array(rows.length + 1)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      const height = row.empty ? dimensions.empty.get(row.depth)! : row.file.kind === 'parent' ? dimensions.parent : dimensions.normal
      this.offsets[index + 1] = this.offsets[index] + height + dimensions.gap
    }
    this.height = rows.length ? this.offsets[rows.length] - dimensions.gap : 0
  }

  // 行的位置同时用于绘制、键盘定位与滚动恢复。
  top(index: number): number {
    return this.offsets[index]
  }

  // 返回与视口及缓冲区相交的半开行范围。
  range(top: number, height: number, buffer: number): { from: number; to: number } {
    const length = this.offsets.length - 1
    if (!length) return { from: 0, to: 0 }
    const start = Math.max(0, top - buffer)
    const end = Math.min(this.height, top + height + buffer)
    const from = Math.max(0, this.upperBound(start) - 1)
    const to = Math.min(length, this.upperBound(end - 0.001))
    return { from, to: Math.max(from, to) }
  }

  // 找到第一个大于目标坐标的行起点。
  private upperBound(value: number): number {
    let low = 0
    let high = this.offsets.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.offsets[middle] <= value) low = middle + 1
      else high = middle
    }
    return low
  }
}
