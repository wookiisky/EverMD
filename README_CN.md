# EverMD

**Language / 语言：[English](README.md) · [中文](README_CN.md)**

EverMD 是基于 [ColaMD](https://github.com/marswaveai/colamd) 修改的开源 Markdown 编辑器，在原有编辑能力上调整阅读、导航和排版体验。

## Introduction

试过很多Markdown editor，但没有能完全满足我的需求的。

**每个人都应该有自己的 Markdown 编辑器。**

## 基于 ColaMD 的主要修改

- **左右侧栏独立配置**：可同时查看文件列表和文档大纲，每侧独立选择内容、开关和调整宽度，并记住设置。
- **隐藏空行视图**：通过「视图 → 隐藏空行」收起正文及引用中的空白行，只改变显示，保留 Markdown 原文和保存内容；正在编辑的空行临时显示。
- **导航前进与后退**：记录光标跳转和跨文件切换的位置，通过视图菜单或快捷键返回。macOS 使用 `⌘⌥←` / `⌘⌥→`，Windows 和 Linux 使用 `Alt+←` / `Alt+→`；纯滚动不进入历史。
- **链接跳转与显示**：普通点击即可跳转到标题、HTML 锚点、其他 Markdown 文件或网页，支持跨文件锚点和中文标题；表格中的有效链接显示下划线。
- **中文强调兼容**：改善中文标点附近的星号加粗、斜体及组合强调的识别，保留原始 Markdown 字符。
- **段内行距调整**：收紧正文、列表续行、引用和表格中的行距，同时保留段落之间的间隔。

具体设计与边界见[需求记录](docs/feature-requests.md)。

## 性能优化

- **长文档编辑**：复用文档分析结果，隐藏空行改用增量解析，减少输入和光标移动时的重复计算。
- **大目录浏览**：仅渲染可见范围附近的条目，复用文件列表与大纲节点；各目录独立刷新，避免慢目录阻塞其他目录。
- **大文件处理**：字数统计分段执行并取消过期任务，复用保存内容的行尾转换结果，减少连续计算和重复转换。

本机 macOS 测试中，约 23 万字符文档的输入处理与同步布局耗时下降约 77%–80%，一万个文件的目录显示耗时降至约 35 ms。数据不包含最终屏幕呈现延迟，也不代表其他平台的固定收益；大文件首次打开尚无稳定提速。详细测量与限制见[性能验证文档](docs/performance.md)。

## 保留的基础能力

- Markdown 即时渲染与源码模式切换。
- 文件外部修改后自动刷新，可配合其他编辑器、脚本或 AI 工具使用。
- 多标签页、多窗口、查找替换和文档大纲。
- 待办列表、数学公式、Mermaid 图表和富文本复制。
- PDF、HTML、Word 和图片导出。
- 12 个内置主题、自定义 CSS 主题及编辑器字体设置。
- macOS、Windows 和 Linux 桌面支持。

主题文件位于 [`themes/`](themes/)，可参考[主题编写说明](themes/README.md)和[模板](themes/template.css)。

## 上游与致谢

EverMD 基于 [ColaMD](https://github.com/marswaveai/colamd) 开发。感谢 [Cola.app](https://cola.app) 和 [orange2ai](https://github.com/orange2ai) 及上游贡献者提供的编辑器基础。

[ColaMD 官网](https://colamd.com/)和[上游 Releases](https://github.com/marswaveai/colamd/releases)提供原项目的信息与发行版，EverMD 的修改以本仓库为准。

## 开源协议

采用 [MIT 协议](LICENSE)，保留上游版权声明。
