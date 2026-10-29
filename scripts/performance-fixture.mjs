// 状态层与真实窗口共用规模、正文和统计口径，便于前后比较。
import { writeFileSync } from 'node:fs'

/** 生成包含普通正文、行内标记和段落分隔的固定文本。 */
export function performanceDocument(paragraphs) {
  return Array.from({ length: paragraphs }, (_, index) =>
    `第 ${index} 段普通正文 mixed English，包含 **加粗文字** 和 \`inline code\`。\n`).join('\n')
}

/** 输出分位数与原始样本，不把机器相关的耗时用作正确性阈值。 */
export function timingSummary(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const percentile = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  return { samples: samples.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), valuesMs: samples }
}

/** 可选结果文件留在调用者指定的位置，运行临时文件由各脚本清理。 */
export function writePerformanceReport(report) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--output')
  if (index >= 0) {
    if (!args[index + 1]) throw new Error('--output 缺少文件路径')
    writeFileSync(args[index + 1], JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report, (key, value) => key === 'valuesMs' ? undefined
    : typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : value, 2))
}
