/** 主题颜色具有稳定名称，CSS 变量由统一生成器映射。 */
export type ThemeColorKey = 'bg' | 'text' | 'textSecondary' | 'textMuted' | 'border' | 'link'
  | 'inlineCodeBackground' | 'codeBlockBackground' | 'codeBlockText' | 'quoteBorder' | 'quoteBackground'
  | 'tableHeaderBackground' | 'tableBorder' | 'selection' | 'highlight' | 'chromeBackground'
  | 'sidebarBackground' | 'controlHover' | 'icon' | 'shellLine' | 'cursor' | 'searchMatch' | 'searchCurrent'

/** Markdown 的稳定语义类别，同时用于表单和两个文档渲染目标。 */
export type ThemeTextKind = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6'
  | 'strong' | 'emphasis' | 'strikethrough' | 'link' | 'linkUrl' | 'quote' | 'list' | 'inlineCode'
  | 'codeBlock' | 'tableHeader' | 'tableCell' | 'highlight' | 'horizontalRule'

/** 代码语法配色的八类语义。 */
export type ThemeSyntaxKey = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'type' | 'property' | 'meta'

/** 仅声明的字段覆盖通用样式，缺省值继续继承。 */
export interface ThemeTextStyle {
  /** CSS 文字颜色。 */ color?: string
  /** CSS 背景颜色。 */ background?: string
  /** 相对父级字号，单位 em。 */ fontSize?: number
  /** 字重。 */ fontWeight?: number
  /** 正常或斜体。 */ fontStyle?: 'normal' | 'italic'
  /** 行内装饰。 */ textDecoration?: 'none' | 'underline' | 'line-through'
  /** 对应内容边线的颜色。 */ borderColor?: string
  /** 对应内容边线的宽度，单位 px。 */ borderWidth?: number
  /** 对应内容边线的形状。 */ borderStyle?: 'none' | 'solid' | 'dashed' | 'dotted'
  /** 块前留白，单位 em。 */ spacingBefore?: number
  /** 块后留白，单位 em。 */ spacingAfter?: number
  /** 文字对齐方式。 */ textAlign?: 'left' | 'center' | 'right'
  /** 字间距，单位 em。 */ letterSpacing?: number
  /** 左内边距，单位 px。 */ paddingLeft?: number
  /** 右内边距，单位 px。 */ paddingRight?: number
  /** 内容的不透明度。 */ opacity?: number
  /** 表格是否保留左右边线。 */ sideBorders?: boolean
}

/** 段内行高与段间空隙分别存储，空值保留现有默认排版。 */
export interface ThemeTypography {
  /** 正文字体族。 */ fontFamily?: string
  /** 代码字体族。 */ codeFontFamily?: string
  /** 正文字号，单位 px。 */ fontSize?: number
  /** 代码字号，单位 px。 */ codeFontSize?: number
  /** 同一段自动及手动换行的行高倍率。 */ lineHeight?: number
  /** 段落之间增加的空隙，单位 em。 */ paragraphSpacing?: number
  /** 原主题容器的行高基准，迁移后保持标题和表格等继承规则。 */ baseLineHeight?: number
}

/** 每个文件都是独立主题，不依赖另一台设备的基础主题文件。 */
export interface ThemeDefinition {
  /** 文件格式版本。 */ version: 1
  /** 稳定存储标识，不使用展示名称作为路径。 */ id: string
  /** 用户可编辑的主题名。 */ name: string
  /** 主题的明暗属性。 */ appearance: 'light' | 'dark'
  /** 界面和文档的主题颜色。 */ colors: Partial<Record<ThemeColorKey, string>>
  /** 基础排版。 */ typography: ThemeTypography
  /** 各种 Markdown 内容的显式样式。 */ styles: Partial<Record<ThemeTextKind, ThemeTextStyle>>
  /** 代码语法配色；空值按代码背景自动选择。 */ syntax: Partial<Record<ThemeSyntaxKey, string>>
  /** 旧 CSS 中无法转换为结构化字段的兼容规则。 */ extensions?: { css?: string }
}

/** 只有恢复副本完整写入后，界面才允许离开当前草稿。 */
export type ThemeDraftRecoveryResult = { ok: true; recoveryPath: string } | { ok: false; error: string }
