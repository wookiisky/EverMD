import { app } from 'electron'
import type { AppUpdater } from 'electron-updater'
import appConfig from '../shared/app-config.json'

// 加载与监听注册共用一次任务，其他入口只能取得已完成配置的实例。
let updaterReady: Promise<AppUpdater> | null = null

// 先检查运行模式，再加载更新器；失败交给调用方，后续显式操作仍可重试。
export function loadAutoUpdater(initialize: (updater: AppUpdater) => void): Promise<AppUpdater | null> {
  if (!app.isPackaged || !appConfig.updatesEnabled) return Promise.resolve(null)
  updaterReady ??= import('electron-updater').then(({ autoUpdater }) => {
    initialize(autoUpdater)
    return autoUpdater
  }).catch((error) => {
    updaterReady = null
    throw error
  })
  return updaterReady
}
