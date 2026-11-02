/** 把文件里的图片地址解析成浏览器能加载的地址。 */
export function resolveImageSrc(raw: string, base: string | null): string {
  const value = raw.trim().replace(/^<|>$/g, '')
  if (/^(?:https?:|file:|data:|blob:)/i.test(value)) return value
  if (!base) return value
  try {
    return new URL(value.replaceAll('\\', '/'), base).href
  } catch {
    return value
  }
}

