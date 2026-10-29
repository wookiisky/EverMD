// 用原统计定义作差分基线，并报告固定规模的局部性能；不使用机器相关的耗时门槛。
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [new URL('../src/renderer/document-statistics.ts', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
})
const { computeDocumentStatistics, DocumentStatisticsScan } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
)

// 分段大小不必对齐换行、词或 Unicode 字符，最终结果仍必须一致。
function chunkedStatistics(text, size) {
  const scan = new DocumentStatisticsScan(text)
  let value
  while (!(value = scan.advance(size))) { /* 真实扫描器保留跨块边界。 */ }
  return value
}

// 保留优化前的三个表达式，防止性能改动悄悄重定义字、词和段。
function originalStatistics(content) {
  const characters = content.replace(/\s/g, '').length
  const tokens = content.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[A-Za-z]+(?:['’\\-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g)?.length ?? 0
  const normalized = content.replace(/\r\n?/g, '\n').trim()
  const paragraphs = normalized ? normalized.split(/\n\s*\n+/).filter(block => block.trim()).length : 0
  return { characters, tokens, paragraphs }
}

const cases = [
  '', ' ', '\n\r\n\t', '甲', 'a\nb', 'a\n\nb', 'a\r\rb', 'a\r\nb',
  'a\r\n\r\nb', '\r\n a \n \t\r\n b \r\n', '甲\n\u2028\nb',
  "don't l’amour foo-bar foo\\bar foo--bar foo''bar foo\\\\bar",
  '12,345.67 1..2 1,,2 123abc abc123 .12 12. １ ١',
  '中文日本語カタカナ한국어𠀀😀👨‍👩‍👧‍👦e\u0301',
  '\u3400\u4dbf\u4dc0\u4e00\u9fff\uf900\ufaff\u3040\u30ff\uac00\ud7af',
  'a\u00a0b\u1680c\u2000d\u200ae\u2028f\u2029g\u202fh\u205fi\u3000j\ufeffk',
  '# 标题\n\n```js\n// 注释\n\nconst n = 123;\n```\n\n正文。',
  '\ud800\udfff\u0085\u180e\u200b', 'a\r\n\rb', 'a\n\r\nb'
]
for (const text of cases) {
  const expected = originalStatistics(text)
  assert.deepEqual(computeDocumentStatistics(text), expected, JSON.stringify(text))
  for (const size of [1, 2, 3, 7]) assert.deepEqual(chunkedStatistics(text, size), expected, `分块 ${size}: ${JSON.stringify(text)}`)
}

// 固定种子覆盖字符类别与相邻边界，失败时输入可重现。
let randomState = 0x5eed1234
const alphabet = ['a', 'Z', '3', '0', '甲', 'あ', '한', '😀', '𠀀', 'é', '\ud800', '-', '\\', "'", '’', '.', ',', '_', ' ', '\t', '\r', '\n', '\v', '\f', '\u00a0', '\u1680', '\u2000', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '\u0085', '\u180e']
function random() {
  randomState ^= randomState << 13
  randomState ^= randomState >>> 17
  randomState ^= randomState << 5
  return randomState >>> 0
}
for (let sample = 0; sample < 3000; sample++) {
  let text = ''
  const length = random() % 300
  for (let index = 0; index < length; index++) text += alphabet[random() % alphabet.length]
  assert.deepEqual(computeDocumentStatistics(text), originalStatistics(text), `随机样本 ${sample}: ${JSON.stringify(text)}`)
  assert.deepEqual(chunkedStatistics(text, 1 + random() % 31), originalStatistics(text), `随机分块样本 ${sample}`)
}
console.log(`通过：${cases.length} 个固定样本与 3000 个随机样本的同步及分段扫描保持原统计定义`)

// 每个输入预热后轮流测量两种实现，减少先后顺序与 JIT 预热造成的偏差。
function measure(text) {
  const oldTimes = [], newTimes = []
  for (let index = 0; index < 8; index++) {
    originalStatistics(text)
    computeDocumentStatistics(text)
  }
  for (let index = 0; index < 30; index++) {
    const tasks = [[originalStatistics, oldTimes], [computeDocumentStatistics, newTimes]]
    if (index % 2) tasks.reverse()
    for (const [compute, times] of tasks) {
      const start = performance.now()
      compute(text)
      times.push(performance.now() - start)
    }
  }
  const summarize = times => {
    times.sort((a, b) => a - b)
    return { medianMs: Number(times[15].toFixed(3)), p95Ms: Number(times[28].toFixed(3)) }
  }
  return { original: summarize(oldTimes), optimized: summarize(newTimes) }
}
const workloads = {
  '中英混合': '# 性能测试 Heading 123\n\n这是一段用于性能分析的正文。 English paragraph with words and numbers 12345.\n\n',
  '英文密集': "# Heading\n\nAn English paragraph with don't, foo-bar, foo\\bar and numbers 12,345.67.\n\n",
  '空白密集': '甲  \t\r\n\u2000\u2028\n   \r\n\t\t\r   \n\nword\n\n'
}
for (const [name, seed] of Object.entries(workloads)) {
  for (const units of [64 * 1024, 256 * 1024, 512 * 1024, 2 * 1024 * 1024]) {
    const text = seed.repeat(Math.ceil(units / seed.length)).slice(0, units)
    assert.deepEqual(computeDocumentStatistics(text), originalStatistics(text), `${name} ${units}`)
    console.log(JSON.stringify({ workload: name, utf16Units: units, utf8Bytes: Buffer.byteLength(text), samples: 30, ...measure(text) }))
  }
}
