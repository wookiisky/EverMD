import type { ThemeDefinition, ThemeTextKind, ThemeTextStyle } from '../../shared/theme-config'
import { cloneTheme, getBuiltinTheme, THEME_COLOR_FIELDS, THEME_SYNTAX_FIELDS, THEME_TEXT_KINDS, validateThemeDefinition } from '../../shared/theme-definition'
import labels from '../../shared/theme-settings-labels.json'
import { getUiLanguage } from '../ui-language'
import { getCurrentThemeDefinition, getThemeDefinitions, onThemeLibraryChanged } from './theme-manager'
import { migrateLegacyTheme } from './theme-legacy-migration'
import { ThemePreview } from './theme-preview'

/** 表单字段只负责把已知路径绑定到草稿，配置有效性由共享模型负责。 */
interface ThemeField {
  /** 对应配置中的稳定字段路径，同时供验收定位。 */
  path: string
  /** 外置文案中的字段键。 */
  key: string
  /** 输入控件类型。 */
  type: 'color' | 'number' | 'text' | 'select'
  /** 有限选项的配置值。 */
  options?: readonly string[]
  /** 数值范围与步长。 */
  min?: number
  max?: number
  step?: number
}

/** Markdown 类型支持的可编辑样式，避免展示对该类型无效的设置。 */
const inlineProperties: (keyof ThemeTextStyle)[] = ['color', 'background', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration']
const borderProperties: (keyof ThemeTextStyle)[] = ['borderColor', 'borderWidth', 'borderStyle']
const blockProperties: (keyof ThemeTextStyle)[] = ['spacingBefore', 'spacingAfter', 'textAlign']

// 根据语义提供适用控件；布局与语法始终由同一份主题生成器处理。
function styleProperties(kind: ThemeTextKind): (keyof ThemeTextStyle)[] {
  if (kind === 'horizontalRule') return [...borderProperties, 'opacity', ...blockProperties]
  if (kind.startsWith('heading')) return [...inlineProperties, ...borderProperties, ...blockProperties, 'letterSpacing']
  if (kind === 'quote') return [...inlineProperties, ...borderProperties, ...blockProperties, 'paddingLeft', 'paddingRight']
  if (kind === 'tableHeader' || kind === 'tableCell') return [...inlineProperties, ...borderProperties, 'sideBorders', 'textAlign']
  if (kind === 'paragraph' || kind === 'list' || kind === 'codeBlock') return [...inlineProperties, ...blockProperties]
  return inlineProperties
}

// 只在受控字段表中构造路径，任意导入字段由共享模型校验。
function readPath(theme: ThemeDefinition, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key] : undefined, theme)
}

// 删除值代表恢复继承，避免把自动派生的颜色固化。
function writePath(theme: ThemeDefinition, path: string, value: unknown): void {
  const keys = path.split('.')
  let record = theme as unknown as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    record[key] ??= {}
    record = record[key] as Record<string, unknown>
  }
  if (value === undefined || value === '') delete record[keys.at(-1)!]
  else record[keys.at(-1)!] = value
}

// 取色器使用纯色通道；文本框继续允许透明色、变量和 CSS 颜色表达式。
function colorChannels(value: string): { hex: string; alpha: number } {
  const context = document.createElement('canvas').getContext('2d')!
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
  return { hex: `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`, alpha: a / 255 }
}

// 比较实际字段值，忽略编辑后留下的空对象及属性的插入顺序。
function themeSnapshot(theme: ThemeDefinition): string {
  const entries: [string, unknown][] = []
  const visit = (value: unknown, path: string): void => {
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) visit(item, `${path}.${key}`)
    } else if (value !== undefined) entries.push([path, value])
  }
  visit(theme, '')
  return JSON.stringify(entries)
}

// 面板同时最多一份草稿，重复菜单操作只聚焦现有窗口。
export function showThemeSettingsPanel(imported?: ThemeDefinition): void {
  const existing = document.getElementById('theme-settings-dialog') as HTMLDialogElement | null
  if (existing) { existing.focus(); return }
  const t = labels[getUiLanguage()]
  const fieldLabels = t.fields as Record<string, string>
  const categoryLabels = t.categories as Record<string, string>
  const api = window.electronAPI
  const focused = document.activeElement as HTMLElement | null
  let draft = migrateLegacyTheme(imported ?? getCurrentThemeDefinition())
  let baseline = cloneTheme(getBuiltinTheme(draft.id) ?? draft)
  let loadedSnapshot = themeSnapshot(draft)
  let newDraft = Boolean(imported)
  let dirty = Boolean(imported)
  let busy = false
  let category = 'interface'
  let libraryVersion = JSON.stringify(getThemeDefinitions().find(theme => theme.id === draft.id))
  const invalid = new Map<string, string>()
  let prompt: HTMLDialogElement | null = null
  let promptFocus: HTMLElement | null = null

  const overlay = document.createElement('div')
  overlay.id = 'theme-settings-overlay'
  overlay.className = 'math-modal-overlay theme-settings-overlay'
  const dialog = document.createElement('dialog')
  dialog.id = 'theme-settings-dialog'
  dialog.className = 'theme-settings-dialog'
  dialog.setAttribute('aria-labelledby', 'theme-settings-title')
  dialog.tabIndex = -1
  const title = document.createElement('h3')
  title.id = 'theme-settings-title'
  title.textContent = t.title
  const header = document.createElement('header')
  header.className = 'theme-settings-header'
  header.appendChild(title)

  const nameLabel = document.createElement('label')
  nameLabel.className = 'theme-settings-name'
  nameLabel.textContent = t.theme
  const themeSelect = document.createElement('select')
  themeSelect.id = 'theme-settings-theme'
  nameLabel.appendChild(themeSelect)
  const rename = actionButton('rename', t.rename, renameTheme)
  const appearanceLabel = document.createElement('label')
  appearanceLabel.textContent = t.appearance
  const appearance = document.createElement('select')
  appearance.dataset.themePath = 'appearance'
  for (const value of ['light', 'dark'] as const) appearance.add(new Option(t[value], value))
  appearance.value = draft.appearance
  appearanceLabel.appendChild(appearance)
  header.append(nameLabel, rename, appearanceLabel)

  const body = document.createElement('div')
  body.className = 'theme-settings-body'
  const nav = document.createElement('nav')
  nav.className = 'theme-settings-nav'
  const categorySelect = document.createElement('select')
  categorySelect.id = 'theme-settings-category'
  categorySelect.setAttribute('aria-label', t.category)
  const categories = ['interface', 'typography', ...THEME_TEXT_KINDS, 'syntax', 'advanced']
  const navButtons = new Map<string, HTMLButtonElement>()
  for (const key of categories) {
    categorySelect.add(new Option(categoryLabels[key], key))
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = categoryLabels[key]
    button.dataset.themeCategory = key
    button.addEventListener('click', () => selectCategory(key))
    navButtons.set(key, button)
    nav.appendChild(button)
  }
  const controls = document.createElement('section')
  controls.className = 'theme-settings-controls'
  const fields = document.createElement('div')
  fields.className = 'theme-settings-fields'
  const categoryTitle = document.createElement('h4')
  const resetCategory = actionButton('resetCategory', t.resetCategory, () => {
    for (const field of categoryFields()) writePath(draft, field.path, readPath(baseline, field.path))
    if (category === 'advanced') draft.extensions = baseline.extensions ? { ...baseline.extensions } : undefined
    invalid.clear()
    renderFields()
    changed()
  })
  const groupHeader = document.createElement('div')
  groupHeader.className = 'theme-settings-group-header'
  groupHeader.append(categoryTitle, resetCategory)
  controls.append(categorySelect, groupHeader, fields)
  const previewColumn = document.createElement('section')
  previewColumn.className = 'theme-settings-preview-column'
  const previewTitle = document.createElement('h4')
  previewTitle.textContent = t.preview
  const frame = document.createElement('iframe')
  frame.id = 'theme-settings-preview'
  frame.title = t.preview
  // 脚本由父文档创建，兼容 CSS 无法在预览文档执行脚本或导航父窗口。
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.tabIndex = -1
  previewColumn.append(previewTitle, frame)
  body.append(nav, controls, previewColumn)
  const status = document.createElement('p')
  status.id = 'theme-settings-status'
  status.setAttribute('role', 'status')
  const footer = document.createElement('footer')
  footer.className = 'theme-settings-footer'
  const files = document.createElement('div')
  files.className = 'theme-settings-actions'
  const format = document.createElement('select')
  format.setAttribute('aria-label', t.format)
  format.add(new Option(t.yaml, 'yaml'))
  format.add(new Option(t.json, 'json'))
  files.append(
    actionButton('import', t.import, importFile),
    format,
    actionButton('export', t.export, exportFile),
    actionButton('reset', t.reset, () => {
      draft = cloneTheme(baseline)
      invalid.clear()
      refreshThemes()
      appearance.value = draft.appearance
      renderFields()
      changed()
    })
  )
  const actions = document.createElement('div')
  actions.className = 'theme-settings-actions'
  actions.append(actionButton('copy', t.copy, () => save(true)), actionButton('cancel', t.cancel, close), actionButton('save', t.save, () => save(false)))
  footer.append(files, actions)
  dialog.append(header, body, status, footer)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  dialog.showModal()
  const preview = new ThemePreview(frame, t.sample)
  const unsubscribe = onThemeLibraryChanged(() => {
    const updated = JSON.stringify(getThemeDefinitions().find(theme => theme.id === draft.id))
    if (dirty && updated !== libraryVersion) status.textContent = t.conflict
    libraryVersion = updated
    refreshThemes()
  })

  // 当前草稿可能尚未落盘，或已经重命名；列表始终保留它自己的选项。
  function refreshThemes(): void {
    const themes = getThemeDefinitions()
    const current = themes.findIndex(theme => theme.id === draft.id)
    if (current < 0) themes.push(draft)
    else themes[current] = draft
    themeSelect.replaceChildren(...themes.map(theme => new Option(theme.name, theme.id)))
    themeSelect.value = draft.id
  }

  // 重置基准与修改快照各司其职，切换后不沿用上一个主题的字段或错误。
  function loadDraft(theme: ThemeDefinition, imported = false): void {
    draft = migrateLegacyTheme(theme)
    baseline = cloneTheme(getBuiltinTheme(draft.id) ?? draft)
    loadedSnapshot = themeSnapshot(draft)
    newDraft = imported
    dirty = imported
    libraryVersion = JSON.stringify(getThemeDefinitions().find(item => item.id === draft.id))
    invalid.clear()
    appearance.value = draft.appearance
    refreshThemes()
    renderFields()
    preview.update(draft)
    status.textContent = imported ? t.unsaved : ''
  }

  // 子对话框复用主题控件样式，由原生 dialog 处理焦点范围和背景隔离。
  function openPrompt(id: string, text: string): HTMLDialogElement {
    promptFocus = document.activeElement as HTMLElement | null
    prompt = document.createElement('dialog')
    prompt.id = id
    prompt.className = 'theme-settings-dialog theme-settings-prompt'
    const heading = document.createElement('h3')
    heading.id = `${id}-title`
    heading.textContent = text
    prompt.setAttribute('aria-labelledby', heading.id)
    prompt.appendChild(heading)
    // Electron 会在同一次 Escape 中请求关闭两层 dialog，先消费按键只取消当前弹窗。
    prompt.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismissPrompt()
    })
    prompt.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); dismissPrompt() })
    dialog.appendChild(prompt)
    return prompt
  }

  // 关闭子对话框后恢复触发控件，Escape 不影响外层面板。
  function dismissPrompt(): void {
    prompt?.close()
    prompt?.remove()
    prompt = null
    promptFocus?.focus({ preventScroll: true })
  }

  // 名称在确认前只存在于弹窗输入中，取消不会触碰草稿。
  function renameTheme(): void {
    const popup = openPrompt('theme-settings-rename-dialog', t.rename)
    const form = document.createElement('form')
    const label = document.createElement('label')
    label.textContent = t.name
    const name = document.createElement('input')
    name.id = 'theme-settings-name'
    name.value = draft.name
    name.maxLength = 100
    label.appendChild(name)
    const error = document.createElement('p')
    error.className = 'theme-settings-prompt-message'
    error.setAttribute('role', 'alert')
    const buttons = document.createElement('div')
    buttons.className = 'theme-settings-actions'
    const confirm = actionButton('renameConfirm', t.confirm)
    confirm.type = 'submit'
    buttons.append(actionButton('renameCancel', t.cancel, dismissPrompt), confirm)
    form.append(label, error, buttons)
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!name.value.trim()) {
        error.textContent = t.requiredName
        name.setAttribute('aria-invalid', 'true')
        name.focus()
        return
      }
      draft.name = name.value.trim()
      refreshThemes()
      changed()
      dismissPrompt()
    })
    popup.appendChild(form)
    popup.showModal()
    name.focus()
    name.select()
  }

  // 切换只更换配置对象；保存成功后才沿用既有应用主题的行为。
  function switchTheme(id: string): void {
    themeSelect.value = draft.id
    if (busy || id === draft.id) return
    themeSelect.focus()
    const loadSelected = (): void => {
      const selected = getThemeDefinitions().find(theme => theme.id === id)
      if (selected) loadDraft(selected)
      else status.textContent = t.themeMissing
      themeSelect.focus()
    }
    if (!dirty) { loadSelected(); return }
    const popup = openPrompt('theme-settings-switch-dialog', t.switchTitle)
    const message = document.createElement('p')
    message.className = 'theme-settings-prompt-message'
    message.textContent = t.switchMessage.replace('{name}', () => draft.name)
    const buttons = document.createElement('div')
    buttons.className = 'theme-settings-actions'
    buttons.append(
      actionButton('switchCancel', t.cancel, dismissPrompt),
      actionButton('switchDiscard', t.switchDiscard, async () => {
        dismissPrompt()
        setBusy(true)
        status.textContent = t.recovering
        try {
          const result = await api.recoverThemeDraft(cloneTheme(draft), Object.fromEntries(invalid))
          if (!result.ok) { status.textContent = `${t.recoveryFailed} ${result.error}`; return }
          loadSelected()
          status.textContent = t.recovered.replace('{path}', () => result.recoveryPath)
        } catch { status.textContent = t.recoveryFailed }
        finally { setBusy(false); themeSelect.focus({ preventScroll: true }) }
      }),
      actionButton('switchSave', t.switchSave, async () => {
        dismissPrompt()
        if (await persist(false)) loadSelected()
      })
    )
    popup.append(message, buttons)
    popup.showModal()
    buttons.querySelector('button')?.focus()
  }

  // 行为按钮共享样式和忙碌状态，异步失败保留全部输入。
  function actionButton(action: string, text: string, callback?: () => void | Promise<void>): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.themeAction = action
    button.textContent = text
    if (callback) button.addEventListener('click', () => { if (!busy) void callback() })
    return button
  }

  // 分类与窄窗口下的原生下拉框保持同一状态。
  function selectCategory(key: string): void {
    category = key
    categorySelect.value = key
    for (const [id, button] of navButtons) button.setAttribute('aria-current', String(id === key))
    renderFields()
  }

  // 统一字段定义使所有颜色与样式使用相同的输入和恢复行为。
  function categoryFields(): ThemeField[] {
    if (category === 'interface') return THEME_COLOR_FIELDS.map(f => ({ path: `colors.${f.key}`, key: f.key, type: 'color' }))
    if (category === 'syntax') return THEME_SYNTAX_FIELDS.map(f => ({ path: `syntax.${f.key}`, key: f.key, type: 'color' }))
    if (category === 'typography') return [
      { path: 'typography.fontFamily', key: 'fontFamily', type: 'text' },
      { path: 'typography.codeFontFamily', key: 'codeFontFamily', type: 'text' },
      { path: 'typography.fontSize', key: 'fontSize', type: 'number', min: 8, max: 72, step: 1 },
      { path: 'typography.codeFontSize', key: 'codeFontSize', type: 'number', min: 8, max: 72, step: 1 },
      { path: 'typography.lineHeight', key: 'lineHeight', type: 'number', min: 0.8, max: 4, step: 0.05 },
      { path: 'typography.paragraphSpacing', key: 'paragraphSpacing', type: 'number', min: 0, max: 8, step: 0.1 }
    ]
    if (category === 'advanced') return []
    const options: Partial<Record<keyof ThemeTextStyle, readonly string[]>> = {
      fontStyle: ['normal', 'italic'], textDecoration: ['none', 'underline', 'line-through'],
      borderStyle: ['none', 'solid', 'dashed', 'dotted'], textAlign: ['left', 'center', 'right'], sideBorders: ['true', 'false']
    }
    return styleProperties(category as ThemeTextKind).map(key => ({
      path: `styles.${category}.${key}`, key,
      type: ['color', 'background', 'borderColor'].includes(key) ? 'color' : options[key] ? 'select' : 'number',
      options: options[key], min: key === 'letterSpacing' ? -0.2 : key === 'fontSize' ? 0.25 : key === 'fontWeight' ? 100 : 0,
      max: key === 'fontWeight' ? 900 : key === 'opacity' ? 1 : key === 'fontSize' ? 8 : key === 'letterSpacing' ? 2 : key === 'paddingLeft' || key === 'paddingRight' ? 160 : 12,
      step: key === 'fontWeight' ? 100 : key === 'fontSize' || key === 'opacity' || key === 'letterSpacing' ? 0.05 : 0.1
    }))
  }

  // 帮助与错误留在面板内，不给编辑器增加常驻元素。
  function renderFields(): void {
    fields.replaceChildren()
    categoryTitle.textContent = categoryLabels[category]
    if (category === 'typography') {
      const help = document.createElement('p')
      help.className = 'theme-settings-help'
      help.textContent = t.spacingHelp
      fields.appendChild(help)
      if (document.body.classList.contains('has-custom-font') || document.body.classList.contains('has-custom-font-size')) {
        const note = document.createElement('p')
        note.className = 'theme-settings-help'
        note.textContent = t.fontOverride
        fields.appendChild(note)
      }
    }
    if (category === 'advanced') {
      const help = document.createElement('p')
      help.className = 'theme-settings-help'
      help.textContent = draft.extensions?.css ? t.compatibility : t.noCompatibility
      fields.appendChild(help)
      if (draft.extensions?.css) {
        const css = document.createElement('textarea')
        css.className = 'theme-settings-css'
        css.value = draft.extensions.css
        css.readOnly = true
        css.setAttribute('aria-label', categoryLabels.advanced)
        fields.appendChild(css)
      }
    }
    for (const field of categoryFields()) fields.appendChild(fieldRow(field))
  }

  // 文本输入保留错误原文；预览仅接收完整且有效的草稿。
  function fieldRow(field: ThemeField): HTMLElement {
    const row = document.createElement('div')
    row.className = 'theme-settings-row'
    const label = document.createElement('label')
    const id = `theme-field-${field.path.replaceAll('.', '-')}`
    label.htmlFor = id
    label.textContent = fieldLabels[field.key]
    if (field.key === 'fontSize' && category !== 'typography') label.textContent = fieldLabels.fontSizeRelative
    const input = field.type === 'select' ? document.createElement('select') : document.createElement('input')
    input.id = id
    input.dataset.themePath = field.path
    const value = readPath(draft, field.path)
    if (input instanceof HTMLSelectElement) {
      input.add(new Option(t.inherit, ''))
      for (const option of field.options ?? []) input.add(new Option((t as Record<string, unknown>)[option] as string ?? option, option))
    } else {
      input.type = field.type === 'color' ? 'text' : field.type
      input.placeholder = t.inherit
      if (field.type === 'number') {
        input.min = String(field.min)
        input.max = String(field.max)
        input.step = 'any'
      }
    }
    input.value = invalid.get(field.path) ?? (value === undefined ? '' : String(value))
    input.setAttribute('aria-invalid', String(invalid.has(field.path)))
    const editor = document.createElement('div')
    editor.className = 'theme-settings-field-editor'
    editor.appendChild(input)
    const commit = (): void => {
      const raw = input.value.trim()
      const parsed = !raw ? undefined : field.type === 'number' ? Number(raw) : field.key === 'sideBorders' ? raw === 'true' : raw
      const candidate = cloneTheme(draft)
      writePath(candidate, field.path, parsed)
      try {
        if (field.type === 'color' && raw && !CSS.supports('color', raw)) throw new Error('invalid color')
        if (input instanceof HTMLInputElement && !input.checkValidity()) throw new Error('invalid input')
        validateThemeDefinition(candidate)
        draft = candidate
        invalid.delete(field.path)
        input.setAttribute('aria-invalid', 'false')
        changed()
      } catch {
        invalid.set(field.path, input.value)
        input.setAttribute('aria-invalid', 'true')
        changed()
      }
    }
    input.addEventListener('input', commit)
    if (field.type === 'color') {
      const picker = document.createElement('input')
      picker.type = 'color'
      picker.className = 'theme-settings-color'
      picker.setAttribute('aria-label', label.textContent)
      let channels = colorChannels(typeof value === 'string' ? value : '#000000')
      picker.value = channels.hex
      const alpha = document.createElement('input')
      alpha.type = 'range'
      alpha.className = 'theme-settings-alpha'
      alpha.min = '0'
      alpha.max = '1'
      alpha.step = '0.01'
      alpha.value = String(channels.alpha)
      alpha.setAttribute('aria-label', `${label.textContent} ${fieldLabels.opacity}`)
      const pick = (): void => {
        const hex = picker.value
        const opacity = Number(alpha.value)
        input.value = opacity === 1 ? hex : `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${opacity})`
        commit()
      }
      picker.addEventListener('input', pick)
      alpha.addEventListener('input', pick)
      input.addEventListener('input', () => {
        if (!invalid.has(field.path)) {
          channels = colorChannels(input.value || '#000000')
          picker.value = channels.hex
          alpha.value = String(channels.alpha)
        }
      })
      editor.prepend(picker)
      editor.appendChild(alpha)
    }
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'theme-settings-field-reset'
    reset.textContent = t.inherit
    reset.title = t.resetField
    reset.setAttribute('aria-label', `${label.textContent} ${t.resetField}`)
    reset.addEventListener('click', () => {
      writePath(draft, field.path, readPath(baseline, field.path))
      invalid.delete(field.path)
      renderFields()
      changed()
    })
    row.append(label, editor, reset)
    return row
  }

  // 未保存的改动只刷新样张，主编辑器及文件状态保持原样。
  function changed(): void {
    dirty = newDraft || invalid.size > 0 || themeSnapshot(draft) !== loadedSnapshot
    status.textContent = invalid.size ? t.invalid : dirty ? t.unsaved : ''
    if (!invalid.size) preview.update(draft)
  }

  // 原生面板取消不替换草稿；导入总是新建，避免静默覆盖同名主题。
  async function importFile(): Promise<void> {
    try {
      const result = await api.importThemeFile()
      if (!result) return
      if (!result.ok) { status.textContent = `${t.failed} ${result.error}`; return }
      const imported = cloneTheme(result.theme)
      imported.id = `user-${crypto.randomUUID()}`
      loadDraft(imported, true)
    } catch { status.textContent = t.failed }
  }

  // 导出完整草稿，导出不会顺带保存或应用到编辑器。
  async function exportFile(): Promise<void> {
    if (!validate()) return
    try {
      const result = await api.exportThemeDefinition(cloneTheme(draft), format.value as 'yaml' | 'json')
      if (!result.ok) status.textContent = `${t.failed} ${result.error}`
      else if (!result.canceled) status.textContent = t.exported
    } catch { status.textContent = t.failed }
  }

  // 名称和字段都有效后才允许写盘。
  function validate(): boolean {
    if (!draft.name.trim()) { status.textContent = t.requiredName; rename.focus(); return false }
    if (invalid.size) { status.textContent = t.invalid; return false }
    try { validateThemeDefinition(draft); return true }
    catch { status.textContent = t.invalid; return false }
  }

  // 存储成功后再切换当前窗口；失败留在面板，允许修正后重试。
  async function save(copy: boolean): Promise<void> {
    if (await persist(copy)) close()
  }

  // 所有异步写入共用忙碌态，避免草稿在等待结果时被修改或重复提交。
  function setBusy(value: boolean): void {
    busy = value
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('button,input,select,textarea')) control.disabled = value
  }

  // 保存返回明确结果，切换流程只有成功时才载入目标主题。
  async function persist(copy: boolean): Promise<boolean> {
    if (!validate()) return false
    const next = cloneTheme(draft)
    if (copy) { next.id = `user-${crypto.randomUUID()}`; next.name += ` ${t.copySuffix}` }
    setBusy(true)
    status.textContent = t.working
    try {
      const result = await api.saveThemeDefinition(next)
      if (!result.ok) { status.textContent = `${t.failed} ${result.error}`; return false }
      // 广播可能比 invoke 返回更晚，先将成功保存的定义交给当前窗口。
      dialog.dispatchEvent(new CustomEvent('theme-saved', { bubbles: true, detail: result.theme }))
      loadDraft(result.theme)
      status.textContent = t.saved
      return true
    } catch { status.textContent = t.failed; return false }
    finally { setBusy(false) }
  }

  // 退出时恢复原来的键盘焦点，销毁隔离视图和监听。
  function close(): void {
    dismissPrompt()
    unsubscribe()
    preview.destroy()
    dialog.close()
    overlay.remove()
    focused?.focus({ preventScroll: true })
  }

  themeSelect.addEventListener('change', () => switchTheme(themeSelect.value))
  appearance.addEventListener('change', () => { draft.appearance = appearance.value as 'light' | 'dark'; changed() })
  categorySelect.addEventListener('change', () => selectCategory(categorySelect.value))
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close() })
  // 原生 dialog 处理 Tab 焦点范围与背景不可交互，Escape 由 cancel 统一清理。
  selectCategory(category)
  refreshThemes()
  preview.update(draft)
  status.textContent = imported ? t.unsaved : ''
  themeSelect.focus()
}
