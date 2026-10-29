// 可控任务队列用于验证分段执行和取消，不替代生产统计逻辑。
export function statisticsTestScheduler() {
  const tasks = []
  let scheduled = 0
  return {
    schedule(callback) {
      const task = { callback, cancelled: false }
      tasks.push(task)
      scheduled++
      return () => { task.cancelled = true }
    },
    runOne(includeCancelled = false) {
      const task = tasks.shift()
      if (!task) return false
      if (!task.cancelled || includeCancelled) task.callback()
      return true
    },
    drain() {
      while (this.runOne()) { /* 每次只执行一个分段任务。 */ }
    },
    get scheduled() { return scheduled },
  }
}
