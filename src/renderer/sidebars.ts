import type { SidebarContent, SidebarSide } from '../shared/sidebar-config'
import labels from '../shared/sidebar-labels.json'
import { getUiLanguage } from './ui-language'
import { clampSidebarWidth, loadSidebarPreferences, sidebarWidths, SIDEBAR_SIDES, SIDEBAR_STORAGE_KEY } from './sidebar-preferences'

// 只管理侧栏外壳；文件浏览和大纲解析由调用方维护。
export class Sidebars {
  /** 当前窗口的偏好，与窄窗口的临时几何尺寸分开。 */
  private readonly preferences = loadSidebarPreferences(localStorage)
  /** 两侧分别取消收起动画，快速切换互不干扰。 */
  private readonly hideCleanup = new Map<SidebarSide, () => void>()
  /** 首次恢复不播放动画，避免窗口启动时跳动。 */
  private motionReady = false

  // 内容或显隐变化后通知调用方刷新列表，不持有文档状态。
  constructor(private readonly onChange: (side: SidebarSide) => void) {}

  // 开关和内容配置共用一条状态更新路径。
  init(): void {
    for (const side of SIDEBAR_SIDES) {
      this.button(side).addEventListener('click', () => this.toggle(side))
      this.bindResize(side)
    }
    // CodeMirror 会接管 Mod-Shift-Backslash，侧栏快捷键在捕获阶段统一处理。
    document.addEventListener('keydown', event => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.code !== 'Backslash') return
      event.preventDefault()
      event.stopPropagation()
      this.toggle(event.shiftKey ? 'right' : 'left')
    }, true)
    window.addEventListener('resize', () => this.updateWidths())
    window.electronAPI.onToggleSidebar(side => this.toggle(side))
    window.electronAPI.onSetSidebarContent((side, content) => this.setContent(side, content))
    window.electronAPI.onRequestSidebarState(() => this.report())
    this.refresh()
    this.save()
    requestAnimationFrame(() => {
      this.motionReady = true
      document.body.classList.add('panel-motion-ready')
    })
  }

  // 只对当前可见的大纲重建条目，隐藏侧栏不消耗编辑帧。
  hasVisibleContent(content: SidebarContent): boolean {
    return SIDEBAR_SIDES.some(side => this.preferences[side].visible && this.preferences[side].content === content)
  }

  // 单次保存整份左右配置，避免重启时读到半次调整。
  private save(): void {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(this.preferences))
    this.report()
  }

  // 主进程按当前聚焦窗口显示菜单状态，不在此强制同步其他窗口。
  private report(): void {
    void window.electronAPI.reportSidebars(this.preferences)
  }

  // 左右按钮始终控制位置，内容随配置变化。
  toggle(side: SidebarSide): void {
    this.preferences[side].visible = !this.preferences[side].visible
    this.refresh()
    this.save()
    this.onChange(side)
  }

  // 允许两侧同时显示同一种内容，每个侧栏拥有自己的列表和滚动位置。
  private setContent(side: SidebarSide, content: SidebarContent): void {
    this.preferences[side].content = content
    const panel = this.panel(side)
    if (panel.contains(document.activeElement)) this.button(side).focus()
    this.refresh()
    this.save()
    this.onChange(side)
  }

  // 更新语言时只改标题和提示，不重置配置。
  updateLabels(): void {
    const text = labels[getUiLanguage()]
    const modifier = /^Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'
    for (const side of SIDEBAR_SIDES) {
      const panel = this.panel(side)
      const name = side === 'left' ? text.leftSidebar : text.rightSidebar
      panel.setAttribute('aria-label', name)
      panel.querySelector<HTMLElement>('.sidebar-heading')!.textContent = text[this.preferences[side].content]
      const label = `${side === 'left' ? text.toggleLeft : text.toggleRight} (${modifier}${side === 'right' ? 'Shift+' : ''}\\)`
      const button = this.button(side)
      button.title = label
      button.setAttribute('aria-label', label)
      button.querySelector<HTMLElement>('.toolbar-tip')!.textContent = label
    }
  }

  // 应用两侧状态，收起时立刻撤掉焦点与点击能力，动画后再移出布局。
  refresh(): void {
    for (const side of SIDEBAR_SIDES) {
      const state = this.preferences[side]
      const panel = this.panel(side)
      const visibleClass = `show-${side}-sidebar`
      this.hideCleanup.get(side)?.()
      panel.dataset.content = state.content
      panel.querySelector<HTMLElement>('.file-list')!.hidden = state.content !== 'files'
      panel.querySelector<HTMLElement>('.outline-list')!.hidden = state.content !== 'outline'
      if (!state.visible && panel.contains(document.activeElement)) this.button(side).focus()
      panel.inert = !state.visible
      panel.setAttribute('aria-hidden', String(!state.visible))
      const button = this.button(side)
      button.classList.toggle('active', state.visible)
      button.setAttribute('aria-expanded', String(state.visible))
      if (state.visible) {
        panel.hidden = false
        if (!document.body.classList.contains(visibleClass)) {
          if (this.motionReady) void panel.offsetWidth
          document.body.classList.add(visibleClass)
        }
      } else {
        document.body.classList.remove(visibleClass)
        if (this.motionReady && !panel.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) this.hideAfterTransition(side)
        else panel.hidden = true
      }
    }
    this.updateWidths()
    this.updateLabels()
  }

  // 收起任务属于一侧，重开时取消旧任务，避免延迟把新面板隐藏。
  private hideAfterTransition(side: SidebarSide): void {
    const panel = this.panel(side)
    const finish = () => {
      cleanup()
      if (!this.preferences[side].visible) panel.hidden = true
    }
    const ended = (event: TransitionEvent) => {
      if (event.target === panel && event.propertyName === 'transform') finish()
    }
    const timer = window.setTimeout(finish, 500)
    const cleanup = () => {
      clearTimeout(timer)
      panel.removeEventListener('transitionend', ended)
      this.hideCleanup.delete(side)
    }
    this.hideCleanup.set(side, cleanup)
    panel.addEventListener('transitionend', ended)
  }

  // 仅可见侧占正文空间；显示尺寸变化不回写宽度偏好。
  private updateWidths(): void {
    const widths = sidebarWidths(this.preferences, window.innerWidth)
    for (const side of SIDEBAR_SIDES) {
      document.body.style.setProperty(`--${side}-sidebar-space`, `${widths[side]}px`)
      document.body.style.setProperty(`--${side}-sidebar-width`, `${widths[side] || this.preferences[side].width}px`)
    }
  }

  // 拖动只修改这一侧，松手后保存偏好，取消时恢复拖动前的宽度。
  private bindResize(side: SidebarSide): void {
    const resizer = document.getElementById(`${side}-sidebar-resizer`)!
    resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      event.preventDefault()
      resizer.setPointerCapture(event.pointerId)
      resizer.classList.add('dragging')
      document.body.classList.add('panel-resizing')
      const original = this.preferences[side].width
      const edgeDistance = (pointer: PointerEvent) => Math.round(side === 'left' ? pointer.clientX : window.innerWidth - pointer.clientX)
      const start = edgeDistance(event)
      const move = (next: PointerEvent) => {
        this.preferences[side].width = clampSidebarWidth(original + edgeDistance(next) - start)
        this.updateWidths()
      }
      const finish = (end: PointerEvent) => {
        resizer.removeEventListener('pointermove', move)
        resizer.removeEventListener('pointerup', finish)
        resizer.removeEventListener('pointercancel', finish)
        resizer.removeEventListener('lostpointercapture', finish)
        resizer.classList.remove('dragging')
        document.body.classList.remove('panel-resizing')
        if (end.type !== 'pointerup') this.preferences[side].width = original
        this.updateWidths()
        this.save()
      }
      resizer.addEventListener('pointermove', move)
      resizer.addEventListener('pointerup', finish)
      resizer.addEventListener('pointercancel', finish)
      resizer.addEventListener('lostpointercapture', finish)
    })
  }

  // 元素由页面固定结构提供，两侧不动态创建外壳。
  private panel(side: SidebarSide): HTMLElement {
    return document.getElementById(`${side}-sidebar`)!
  }

  // 按钮位置不随侧栏内容改变。
  private button(side: SidebarSide): HTMLButtonElement {
    return document.getElementById(`${side}-sidebar-toggle`) as HTMLButtonElement
  }
}
