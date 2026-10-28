import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SidebarContent, SidebarPreferences, SidebarSide } from '../shared/sidebar-config'
import type { NavigationFileResult, NavigationMenuState } from '../shared/navigation-config'
import type { DocumentCloseChoice, DocumentCloseRequest } from '../shared/document-close-config'

export interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

type FileOpenedData = { path: string | null; content: string; fileUrl: string | null }
type ImageExportPreset = 'desktop' | 'mobile'
type ImageExportSnapshot = { html: string; styles: string; bodyClass: string; background: string }
export type FileManagerName = 'finder' | 'explorer' | 'file-manager'

const pendingFileOpened: FileOpenedData[] = []
let fileOpenedHandler: ((data: FileOpenedData) => void) | null = null

// Register this listener as soon as preload starts. The main process can send
// the initial content before the renderer finishes registering its callbacks.
ipcRenderer.on('file-opened', (_event, data: FileOpenedData) => {
  if (fileOpenedHandler) {
    fileOpenedHandler(data)
  } else {
    pendingFileOpened.push(data)
  }
})

export interface ElectronAPI {
  openFile: () => Promise<{ path: string; content: string } | null>
  openFilePath: (path: string) => Promise<{ path: string; content: string } | null>
  getFileManagerName: () => Promise<FileManagerName>
  revealFile: () => Promise<boolean>
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => Promise<void>
  showTabContextMenu: (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => Promise<void>
  onTabMenuAction: (callback: (payload: { action: string; tabId: string }) => void) => void
  listSiblings: () => Promise<SiblingFile[] | null>
  listDirectory: (path: string) => Promise<SiblingFile[] | null>
  openSibling: (path: string) => Promise<boolean>
  activateFile: (path: string | null) => Promise<{ content: string; fileUrl: string; mtime: number } | null>
  /** 读取后切换文件绑定；已有标签可在磁盘缺失时恢复内存内容。 */
  navigateToFile: (path: string, allowMissing?: boolean) => Promise<NavigationFileResult>
  /** 原生菜单请求在当前窗口的导航历史中前进或后退。 */
  onNavigateHistory: (callback: (direction: -1 | 1) => void) => void
  /** 同步当前窗口的前进后退菜单状态。 */
  reportNavigationState: (state: NavigationMenuState) => Promise<void>
  setTabFiles: (paths: string[]) => void
  fileUrl: (path: string) => Promise<string | null>
  onFocusFile: (callback: (path: string) => void) => void
  onOpenInNewTab: (callback: (path: string, fragment?: string, line?: number) => void) => void
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => Promise<string | null>
  saveFileAs: (content: string, expectedPath?: string) => Promise<string | null>
  exportPDF: () => Promise<boolean>
  exportHTML: (snapshot: { content: string; document: string; html: string; styles: string; bodyClass: string }) => Promise<boolean>
  exportDOCX: (payload: { content: string; images: Record<string, string> }) => Promise<boolean>
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => Promise<boolean>
  getLanguage: () => Promise<'zh' | 'en'>
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => void
  loadCustomTheme: () => Promise<{ name: string; css: string } | null>
  loadThemeCSS: (fileName: string) => Promise<string | null>
  reportTheme: (theme: string) => Promise<void>
  reportTitlebarColors: (colors: { background: string; symbol: string }) => Promise<void>
  popupAppMenu: () => Promise<void>
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => void
  getPathForFile: (file: File) => string
  openExternal: (url: string) => void
  onFileChanged: (callback: (content: string, path: string) => void) => void
  onNewFile: (callback: () => void) => void
  onFileOpened: (callback: (data: FileOpenedData) => void) => void
  onMenuOpen: (callback: () => void) => void
  onMenuSave: (callback: () => void) => void
  onMenuSaveAs: (callback: () => void) => void
  onMenuNewTab: (callback: () => void) => void
  onMenuCloseTab: (callback: () => void) => void
  onMenuExportPDF: (callback: () => void) => void
  onMenuExportHTML: (callback: () => void) => void
  onMenuExportDOCX: (callback: () => void) => void
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => void
  onMenuPlaySlideshow: (callback: () => void) => void
  setSlideshowFullscreen: (on: boolean) => Promise<boolean>
  onSetTheme: (callback: (theme: string) => void) => void
  /** 左右侧栏独立开关和选择内容，渲染层持久化偏好。 */
  onToggleSidebar: (callback: (side: SidebarSide) => void) => void
  onSetSidebarContent: (callback: (side: SidebarSide, content: SidebarContent) => void) => void
  reportSidebars: (preferences: SidebarPreferences) => Promise<void>
  onRequestSidebarState: (callback: () => void) => void
  onSetPageWidth: (callback: (width: string) => void) => void
  reportPageWidth: (width: string) => Promise<void>
  onSetCustomCSS: (callback: (css: string) => void) => void
  onMenuImportTheme: (callback: () => void) => void
  onSearch: (callback: () => void) => void
  onFormatCommand: (callback: (id: string) => void) => void
  readClipboardText: () => Promise<string>
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => void
  onToggleSourceMode: (callback: () => void) => void
  /** 隐藏空行仅改变渲染显示，偏好由渲染层持久化。 */
  onSetHideBlankLines: (callback: (enabled: boolean) => void) => void
  /** 同步原生菜单的勾选状态。 */
  reportHideBlankLines: (enabled: boolean) => Promise<void>
  setEditorFont: (prefs: { family: string; size: number }) => Promise<void>
  listSystemFonts: () => Promise<string[]>
  onEditorFontChanged: (callback: (prefs: { family: string; size: number }) => void) => void
  onOpenFontSettings: (callback: () => void) => void
  onStepFont: (callback: (delta: number) => void) => void
  reportExternalConflict: (content: string) => Promise<void>
  onExternalConflictResult: (callback: (result: { action: 'keep' | 'load'; content?: string; recoveryPath?: string }) => void) => void
  revealPath: (target: string) => Promise<boolean>
  onUpdateAvailable: (callback: (version: string) => void) => void
  onUpdateDownloaded: (callback: (version: string) => void) => void
  onUpdateProgress: (callback: (percent: number) => void) => void
  onUpdateError: (callback: () => void) => void
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  reportDirty: (isDirty: boolean) => void
  reportRendererReady: () => void
  closeWindow: () => Promise<void>
  /** 关闭前由渲染层逐标签保存，确认期间保持文档操作串行。 */
  onPrepareWindowClose: (callback: (requestId: string) => void) => void
  acknowledgeWindowClose: (requestId: string) => void
  respondWindowClose: (requestId: string, approved: boolean) => void
  onCancelWindowClose: (callback: () => void) => void
  confirmDocumentClose: (request: DocumentCloseRequest) => Promise<DocumentCloseChoice>
  logRendererError: (message: string) => Promise<void>
  onRequestDocumentState: (callback: (requestId: string) => void) => void
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  openFilePath: (path: string) => ipcRenderer.invoke('open-file-path', path),
  getFileManagerName: () => ipcRenderer.invoke('get-file-manager-name') as Promise<FileManagerName>,
  revealFile: () => ipcRenderer.invoke('reveal-file') as Promise<boolean>,
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => ipcRenderer.invoke('entry-context-menu', path, kind) as Promise<void>,
  showTabContextMenu: (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => ipcRenderer.invoke('tab-context-menu', payload) as Promise<void>,
  onTabMenuAction: (callback: (payload: { action: string; tabId: string }) => void) => {
    ipcRenderer.on('tab-menu-action', (_event, payload: { action: string; tabId: string }) => callback(payload))
  },
  listSiblings: () => ipcRenderer.invoke('list-siblings'),
  listDirectory: (path: string) => ipcRenderer.invoke('list-directory', path),
  openSibling: (path: string) => ipcRenderer.invoke('open-sibling', path),
  activateFile: (path: string | null) => ipcRenderer.invoke('activate-file', path) as Promise<{ content: string; fileUrl: string; mtime: number } | null>,
  navigateToFile: (path: string, allowMissing = false) => ipcRenderer.invoke('navigate-to-file', path, allowMissing) as Promise<NavigationFileResult>,
  onNavigateHistory: (callback: (direction: -1 | 1) => void) => {
    ipcRenderer.on('navigate-history', (_event, direction: -1 | 1) => callback(direction))
  },
  reportNavigationState: (state: NavigationMenuState) => ipcRenderer.invoke('report-navigation-state', state),
  setTabFiles: (paths: string[]) => { ipcRenderer.send('set-tab-files', paths) },
  fileUrl: (path: string) => ipcRenderer.invoke('file-url', path) as Promise<string | null>,
  onFocusFile: (callback: (path: string) => void) => {
    ipcRenderer.on('focus-file', (_event, path: string) => callback(path))
  },
  onOpenInNewTab: (callback: (path: string, fragment?: string, line?: number) => void) => {
    ipcRenderer.on('open-in-new-tab', (_event, path: string, fragment?: string, line?: number) => callback(path, fragment, line))
  },
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => ipcRenderer.invoke('save-file', content, expectedPath, rebuildMenu, autosave),
  saveFileAs: (content: string, expectedPath?: string) => ipcRenderer.invoke('save-file-as', content, expectedPath),
  exportPDF: () => ipcRenderer.invoke('export-pdf'),
  exportHTML: (snapshot: { content: string; document: string; html: string; styles: string; bodyClass: string }) => ipcRenderer.invoke('export-html', snapshot),
  exportDOCX: (payload: { content: string; images: Record<string, string> }) => ipcRenderer.invoke('export-docx', payload),
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => ipcRenderer.invoke('export-image', snapshot, preset),
  getLanguage: () => ipcRenderer.invoke('get-language') as Promise<'zh' | 'en'>,
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => {
    ipcRenderer.on('language-changed', (_event, language) => {
      if (language === 'zh' || language === 'en') callback(language)
    })
  },
  loadCustomTheme: () => ipcRenderer.invoke('load-custom-theme'),
  loadThemeCSS: (fileName: string) => ipcRenderer.invoke('load-theme-css', fileName),
  reportTheme: (theme: string) => ipcRenderer.invoke('report-theme', theme),
  reportSidebars: (preferences: SidebarPreferences) => ipcRenderer.invoke('report-sidebars', preferences),
  reportPageWidth: (width: string) => ipcRenderer.invoke('report-page-width', width),
  reportTitlebarColors: (colors: { background: string; symbol: string }) => ipcRenderer.invoke('report-titlebar-colors', colors),
  popupAppMenu: () => ipcRenderer.invoke('popup-app-menu'),
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
    ipcRenderer.on('fullscreen-changed', (_event, isFullscreen) => callback(isFullscreen === true))
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onFileChanged: (callback: (content: string, path: string) => void) => {
    ipcRenderer.on('file-changed', (_event, content: string, path: string) => callback(content, path))
  },
  onNewFile: (callback: () => void) => {
    ipcRenderer.on('new-file', () => callback())
  },
  onFileOpened: (callback: (data: FileOpenedData) => void) => {
    fileOpenedHandler = callback
    for (const data of pendingFileOpened.splice(0)) callback(data)
  },
  onMenuOpen: (callback: () => void) => {
    ipcRenderer.on('menu-open', () => callback())
  },
  onMenuSave: (callback: () => void) => {
    ipcRenderer.on('menu-save', () => callback())
  },
  onMenuNewTab: (callback: () => void) => {
    ipcRenderer.on('menu-new-tab', () => callback())
  },
  onMenuCloseTab: (callback: () => void) => {
    ipcRenderer.on('menu-close-tab', () => callback())
  },
  onMenuSaveAs: (callback: () => void) => {
    ipcRenderer.on('menu-save-as', () => callback())
  },
  onMenuExportPDF: (callback: () => void) => {
    ipcRenderer.on('menu-export-pdf', () => callback())
  },
  onMenuExportHTML: (callback: () => void) => {
    ipcRenderer.on('menu-export-html', () => callback())
  },
  onMenuExportDOCX: (callback: () => void) => {
    ipcRenderer.on('menu-export-docx', () => callback())
  },
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => {
    ipcRenderer.on('menu-export-image', (_event, preset) => {
      if (preset === 'desktop' || preset === 'mobile') callback(preset)
    })
  },
  onMenuPlaySlideshow: (callback: () => void) => {
    ipcRenderer.on('menu-play-slideshow', () => callback())
  },
  // The deck asks for the whole screen; the main process remembers what the
  // window was before, so leaving the deck does not also leave a full screen the
  // user had chosen for other reasons.
  setSlideshowFullscreen: (on: boolean) => ipcRenderer.invoke('slideshow-fullscreen', on) as Promise<boolean>,
  onSetTheme: (callback: (theme: string) => void) => {
    ipcRenderer.on('set-theme', (_event, theme) => callback(theme))
  },
  onToggleSidebar: (callback: (side: SidebarSide) => void) => {
    ipcRenderer.on('toggle-sidebar', (_event, side: SidebarSide) => callback(side))
  },
  onSetSidebarContent: (callback: (side: SidebarSide, content: SidebarContent) => void) => {
    ipcRenderer.on('set-sidebar-content', (_event, side: SidebarSide, content: SidebarContent) => callback(side, content))
  },
  onRequestSidebarState: (callback: () => void) => {
    ipcRenderer.on('request-sidebar-state', () => callback())
  },
  onSetPageWidth: (callback: (width: string) => void) => {
    ipcRenderer.on('set-page-width', (_event, width) => callback(width))
  },
  onSetCustomCSS: (callback: (css: string) => void) => {
    ipcRenderer.on('set-custom-css', (_event, css) => callback(css))
  },
  onMenuImportTheme: (callback: () => void) => {
    ipcRenderer.on('menu-import-theme', () => callback())
  },
  onSearch: (callback: () => void) => {
    ipcRenderer.on('editor:search', () => callback())
  },
  onFormatCommand: (callback: (id: string) => void) => {
    ipcRenderer.on('editor:format', (_event, id: string) => callback(id))
  },
  readClipboardText: () => ipcRenderer.invoke('read-clipboard-text') as Promise<string>,
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => {
    ipcRenderer.on('siblings-changed', (_event, files) => callback(files))
  },
  onToggleSourceMode: (callback: () => void) => {
    ipcRenderer.on('toggle-source-mode', () => callback())
  },
  onSetHideBlankLines: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('set-hide-blank-lines', (_event, enabled: boolean) => callback(enabled))
  },
  reportHideBlankLines: (enabled: boolean) => ipcRenderer.invoke('report-hide-blank-lines', enabled),
  setEditorFont: (prefs: { family: string; size: number }) => {
    return ipcRenderer.invoke('set-editor-font', prefs)
  },
  listSystemFonts: () => {
    return ipcRenderer.invoke('list-system-fonts')
  },
  onEditorFontChanged: (callback: (prefs: { family: string; size: number }) => void) => {
    ipcRenderer.on('editor-font-changed', (_event, prefs) => callback(prefs))
  },
  onOpenFontSettings: (callback: () => void) => {
    ipcRenderer.on('open-font-settings', () => callback())
  },
  onStepFont: (callback: (delta: number) => void) => {
    ipcRenderer.on('step-font', (_event, delta: number) => callback(delta === 0 ? 0 : delta > 0 ? 1 : -1))
  },
  reportExternalConflict: (content: string) => {
    return ipcRenderer.invoke('report-external-conflict', content)
  },
  onExternalConflictResult: (callback: (result: { action: 'keep' | 'load'; content?: string; recoveryPath?: string }) => void) => {
    ipcRenderer.on('external-conflict-result', (_event, result) => callback(result))
  },
  revealPath: (target: string) => ipcRenderer.invoke('reveal-path', target) as Promise<boolean>,
  onUpdateAvailable: (callback: (version: string) => void) => {
    ipcRenderer.on('update-available', (_event, version) => callback(version))
  },
  onUpdateDownloaded: (callback: (version: string) => void) => {
    ipcRenderer.on('update-downloaded', (_event, version) => callback(version))
  },
  onUpdateProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on('update-progress', (_event, percent) => callback(percent))
  },
  onUpdateError: (callback: () => void) => {
    ipcRenderer.on('update-error', () => callback())
  },
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  reportDirty: (isDirty: boolean) => ipcRenderer.send('set-dirty', isDirty),
  reportRendererReady: () => ipcRenderer.send('renderer-ready'),
  closeWindow: () => ipcRenderer.invoke('request-close-window'),
  onPrepareWindowClose: (callback: (requestId: string) => void) => {
    ipcRenderer.on('prepare-window-close', (_event, requestId: string) => callback(requestId))
  },
  acknowledgeWindowClose: (requestId: string) => ipcRenderer.send('window-close-started', requestId),
  respondWindowClose: (requestId: string, approved: boolean) => ipcRenderer.send('window-close-response', requestId, approved),
  onCancelWindowClose: (callback: () => void) => {
    ipcRenderer.on('cancel-window-close', callback)
  },
  confirmDocumentClose: (request: DocumentCloseRequest) => ipcRenderer.invoke('confirm-document-close', request),
  logRendererError: (message: string) => ipcRenderer.invoke('log-renderer-error', message),
  onRequestDocumentState: (callback: (requestId: string) => void) => {
    ipcRenderer.on('request-document-state', (_event, requestId) => callback(requestId))
  },
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => {
    ipcRenderer.send('document-state-response', requestId, snapshot)
  }
} satisfies ElectronAPI)
