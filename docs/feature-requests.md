# Feature Requests

This is the holding list for requests that have a clear user need but are not committed roadmap work. Entries stay here until they are accepted into a release plan or explicitly declined.

**Issue lifecycle rule (2026-09-15)** — the GitHub issue tracker is a work queue, not an archive. Keep `open` count at zero; do not let issues linger:

1. **Fixed in code** → comment with root cause + verification, then close. The commit message references the issue number.
2. **Big or unscheduled feature requests** → record them here (with need, scope and status), reply pointing to the entry, then close the issue. The list is the tracker; the issue is not.
3. **Outdated or unreproducible reports** (old version, no reply, needs a machine we do not have) → close as not planned, and state exactly what a reopen requires (e.g. reproduce on the latest version + document/platform details).
4. Requests that are declined for good go in this list under `Declined` with the reason — never silently closed.

**How to read the labels**

- `Help wanted` — we cannot finish it alone: it needs hardware, an environment, or a reproduction we do not have. Please comment on the linked issue; Chinese or English both fine.
- `In progress` — someone is building it right now. Comment on the issue instead of starting a second implementation.
- `Candidate` — free to pick up. Say so on the issue first so two people do not meet in the same file.
- `Declined` — not planned, with the reason recorded.

## Help wanted / 急需帮助

The two items below are the ones actually blocking us. Everything else on this page is either being built by the maintainer or is simply not scheduled yet — these are the ones where an outside hand changes the outcome.

### Windows input stutter while typing

**Sources:** [#78](https://github.com/marswaveai/ColaMD/issues/78)

**Reported:** Windows 11, NVIDIA GPU, AMD CPU. Typing stalls roughly every six characters.

**Needed:** reproduction and profiling on Windows: does the stall follow IME composition, autosave, Mermaid rendering, or the renderer's paint loop? Is it the editor, the file watcher, or the GPU process?

**Why it is stuck:** the maintainer only has macOS hardware. Startup time is already instrumented (`COLAMD_STARTUP_TRACE=1`), so a Windows user can produce a comparable trace; nobody has been able to run it on a machine that shows the stall.

**How to help:** comment on [#78](https://github.com/marswaveai/ColaMD/issues/78) (closed pending data; reopen with it) or open a new issue, with your GPU and driver version, input method, document size, and whether the stutter changes when the document contains no Mermaid block or when autosave is off.

### Image export failures

**Sources:** [#88](https://github.com/marswaveai/ColaMD/issues/88)

**Reported:** export to image fails for some users, on both desktop and mobile export modes.

**Needed:** a document that reproduces it. Export draws the document in one hidden window and captures it, and a document taller than 16384 device pixels continues as numbered pages, so a failure now points at either the render window or that limit. The earlier debugging-protocol and scrolling fallbacks are gone (2026-09-21), which is why a failure seen before that change is worth re-reporting against the current release.

**How to help:** comment on [#88](https://github.com/marswaveai/ColaMD/issues/88) with the failing document (or a cut-down version), the platform, the export option used, and whether the current release still fails.

## Implemented On Main

### 统一主题配置与详细设置面板

**来源：** 用户需求（2026-10-29）：配置界面多处颜色及各类 Markdown 文字样式，旧主题统一纳入新体系，使用格式化 YAML 或 JSON 导入导出；同段落自动换行的行高与段落之间的间距分别配置。

**范围：** 12 套内置主题、内置主题的本地定制和用户主题共用结构化配置与渲染流程。主题菜单打开临时配置面板，提供界面颜色、正文排版、各级标题、强调、引用、列表、代码、表格和语法颜色，以及隔离的只读 Markdown 样张。预览不修改用户文档，保存成功后应用，支持恢复原版和另存副本；已有编辑器字体偏好高于主题。段内行高与段落后的额外间距独立，文件里的空行仍遵循隐藏空行偏好。

**配置交互补充（2026-10-29）：** 面板右上角使用下拉列表选择正在配置的主题，独立的重命名按钮打开名称输入框，确认后修改草稿。下拉切换只加载配置与预览，不立即应用到主编辑器；有修改时提供保存并切换、不保存并切换、取消。保存成功后应用刚保存的主题，并留在面板配置所选主题；失败或字段无效时保留当前草稿和选择。不保存切换前先将草稿及无效字段原文写入恢复目录并显示路径，恢复副本写入失败则留在当前主题。修改状态与载入快照比较，改回原值后不再询问。中英文预览以各级标题下的普通段落串起引用、列表、表格和代码，便于比较真实阅读时的排版。

**主题名称简化（2026-10-29）：** 内置主题及随附独立主题文件统一使用英文名称。桌面菜单、配置下拉列表和网页预览直接读取同一份配置中的 `name`，移除重复的中英文名称表；用户保存的重命名也直接显示。主题说明与色卡同步使用英文名称。

**本次交互验证：** 97 项真实 Electron 离屏检查通过，覆盖三种切换选择、保存和恢复副本写入失败、无效输入原文、重命名的 Enter 与 Escape、焦点恢复、主题库更新、深浅主题及窄窗口，并验证中英文菜单与配置下拉的名称一致、保存重命名后菜单更新。子弹窗按内容高度显示，截图核对通过；原 Markdown 及排版夹具的字节和修改时间保持不变。网页实测切换界面语言后 12 个主题名不变。恢复副本的真实文件测试、主题配置与生成文件检查、四份类型检查、桌面及网页构建和 `git diff --check` 通过。改动仍在工作区，尚未发布。

**兼容与导出：** 旧 CSS 原件保留并迁移到统一主题记录；能确定结果且符合配置契约的声明转换为字段，条件规则、复杂选择器及无法表达的声明保留在 `extensions.css`。YAML 和 JSON 表达相同配置，导入先进入新草稿，导出携带完整主题及兼容 CSS。编辑器、HTML、PDF 与图片消费同一配置；Word 和公众号复制继续使用自身排版。主题选择属于各窗口，保存定义同步更新正在使用同一主题的窗口。

**验证与状态：** 已在工作区实现，尚未发布。64 项主题面板真实 Electron 离屏检查通过，覆盖 12 套内置外观基线、预览取消、错误草稿、字体与字号、段内行高与段间距独立、同主题多窗口同步及不同主题隔离、重启恢复、YAML/JSON 真实文件往返、HTML 导出重载和旧 CSS 迁移边界；补充覆盖链接实际文字颜色、旧边线方向，以及同内容旧主题按文件身份恢复与保存隔离。原 Markdown、旧 CSS 和独立排版夹具的字节与修改时间保持不变。配置模型、真实文件存储、主题颜色及生成文件契约检查通过；现有 97 项段落排版、575 项编辑功能、198 项源码切换、4 个滚动位置、100 份 Markdown 保存保真检查，以及电脑和手机的长短图片四种场景与 PDF 导出均通过。四份类型检查、桌面与网页构建、`git diff --check` 通过。内置 YAML 文件由唯一配置来源生成，历史 CSS 文件作为迁移兼容样例保留；使用方法见 [主题说明](../themes/README.md)。

### 同一段落内的换行更紧凑

**来源：** 用户反馈（2026-10-28）：适当减少同段落换行的行间距；引用与嵌套引用、表格内部换行先收紧 10%，随后确认所有段内行距再缩小 10%，段落之间的实际距离保持不变，开启隐藏空行时也适用。

**范围：** 正文与列表续行依据 Markdown 语法树的段落边界收紧行高，默认正文先由 1.75 倍降到 1.6 倍，再乘 0.9；引用与嵌套引用在 1.6 倍基础上累计乘 0.81，表头与单元格相对原行高累计乘 0.81。自动折行、手动换行与表格内 `<br>` 使用对应的行高，各段或单元格首尾补回减少的半行距，使段落之间的实际文字间隔和单行总高度保持不变。补偿与收紧比例共用同一变量，隐藏空行仍只压缩空白行。行内代码使用自身的自然字体行盒，避免小字号代码继承正文的绝对行高后撑开整行。表格复用主题原有行高，作家主题的字号缩放自然参与计算；旧导入主题无需重新导入，倍率、公式、变量及长度通过浏览器实际解析区分。空行、标题与代码块保持原有间距。不新增设置，不修改文档内容。

**导出边界：** HTML 导出同步现有语义段落和表格内的行距样式。原有导出器会把正文和引用的手动同段换行拆成独立段落，这类换行尚不能共享一个语义段落中的紧凑行距；本次保留原有导出结构。

**验证：** 先在真实 Electron 离屏窗口采集原排版并确认新用例失败，再调整渲染。`verify:paragraph-spacing` 的 97 项检查通过，直接使用用户提供的原文，覆盖五套深浅主题、普通正文与引用的自动折行、手动和硬换行、混排行内代码、嵌套引用、表头与单元格，以及隐藏空行前后的跨段字形距离。纯文本的实际步长再缩小 10%；原文中行内代码原来将行距撑到 26.6px，修正后实际步长与当前设定的 23.04px 一致。用户原文在隐藏空行后跨段字形距离的变化约 0.016px；所有夹具中跨段字形间隔最大变化约 0.64px，来自边界两端的字体基线取整，单行单元格高度最大变化小于 0.01px。八种自定义主题覆盖旧版与当前作家主题、像素、相对长度、百分比、公式、变量及编辑器祖先作用域；首次在编辑器创建之前加载主题、源码切换、现有 HTML 语义产物的自动折行、增量合段拆段、文件字节和修改时间保护也通过。完整功能回归的 574 项检查、198 项源码切换检查、四个滚动位置、主题验收、24 项隐藏空行真机检查、图片导出桌面与手机的长短文档四种场景，以及 100 份 Markdown 保存保真检查均通过；四份类型检查、构建与 `git diff --check` 通过。完整功能回归首次因截图请求挂起而终止，清理测试进程后，以关闭后台节流、为请求增加超时的临时启动方式重跑通过。已在工作区实现，尚未发布。

### 表格链接显示下划线

**来源：** 用户反馈（2026-10-28）：表格中的链接也应按链接展示，并显示下划线。

**实现：** 表格中带有效地址的链接复用正文链接的主题色与手形光标，并始终显示下划线，覆盖表头与正文中的网页、本地文件和文内锚点。空地址不增加链接样式，沿用现有点击跳转。

**验证：** 补充检查后先在原样式下复现主题色不一致，再修复样式。`verify:links` 的 106 项检查通过，包含真实 Electron 离屏窗口中深浅主题的默认样式、空地址边界、三类链接点击，以及所有测试文件的字节与修改时间保护。主题验收、四份类型检查、构建与 `git diff --check` 通过。已在工作区实现，尚未发布。

### 中文标点旁的星号强调

**来源：** 用户反馈（2026-10-28）：`**结果与边界：**不恢复` 未显示加粗。

**范围：** 星号串紧邻汉字、假名、韩文、注音及其共享标点，或全角字符时，允许在标点内外识别强调；单星斜体、双星加粗、三星组合共用边界规则。依据 Unicode 文字属性和全角字符区间判断，不枚举标点。纯英文与下划线沿用 CommonMark 规则，代码、转义、标记内侧空白和段落边界仍按原规则处理。这是本产品的中文显示兼容约定，不声明完整实现所有 CJK-friendly Unicode 宽度及变体选择符规则。

**实现：** 将既有 `@lezer/markdown` 升至 1.8.0，通过公开的 `InlineContext.emphasisAsterisk` 仅扩展边界判断；强调配对、嵌套和星号长度规则继续使用上游实现。源码字符与偏移不变，复用编辑器原有的渲染、HTML 复制和导出路径。Word 导出使用独立的 remark 解析器，本次未调整。

**验证：** `verify:emphasis` 的 26 个目标用例、26 个标准语法兼容用例及增量编辑检查通过；完整 `verify:features` 的 574 项真实 Electron 离屏验收通过，包含深浅主题的字体、标记隐藏、列表、引用、链接、表格、HTML 导出和复制，也可用 `--emphasis-only` 单独运行本次回归。`verify:markdown` 的 100 份文件打开再保存均为零字节差异，`verify:scroll-render` 的 4 个滚动位置通过。四份类型检查、构建与 `git diff --check` 通过。已在工作区实现，尚未发布。

### 跨文件前进与后退

**来源：** 用户需求（2026-10-28），明确只记录光标跳转和跨文件切换，不记录纯滚动。

**范围：** 每个窗口在内存中保存最多 100 个位置（包含当前位置），不跨窗口、不随重启恢复。视图菜单提供后退和前进，macOS 使用 ⌘⌥← / ⌘⌥→，Windows 和 Linux 使用 Alt+← / Alt+→。不增加顶栏控件；菜单文字跟随界面语言，无法继续时禁用。

**记录规则：** 普通光标移动停止 500ms 后记录；相邻位置的源码行差小于 5 且 UTF-16 字符偏移差小于 80 时合并，累计小移动与固定起点比较。文件切换前收妥位置，A → B → A 的真实访问顺序保留。后退后只有有效新导航才截断前进分支。输入、撤销重做、热更新、模式切换和历史回放不新增记录。

**恢复边界：** 锚点只保存文件身份和位置，不保存旧正文。已打开文件复用标签，即使磁盘文件已删除或移走，也能恢复内存副本并保存或另存；已关闭文件按现有浏览方式重开。未命名文档关闭后移除对应记录，另存为迁移身份。切换成功后才移动历史指针；取消或读取错误保留当前文档，没有内存副本且确认不存在的文件移除后继续。恢复缺失文件后，外部重新创建的内容仍受自动保存冲突保护。编辑时映射锚点，源码全部替换按实际的多处修改分别映射；外部整体重载时按原行列夹限恢复选区并保留焦点与阅读视口，不能保证跟随外部任意重排后的原段落。

**实现参考：** [VS Code 导航历史](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/history/browser/historyService.ts)的相近选区合并与回放抑制；容量、防抖和过滤阈值采用本次确认的行为。

**验证：** `verify:navigation-history` 的 14 项历史规则测试通过；`verify:editor-navigation` 覆盖选区观察、输入映射、重载、只读状态，以及源码批量替换的等长、增长和删除场景。`verify:navigation-ui` 的 58 项真实 Electron 离屏验收通过，覆盖菜单和快捷键、两种编辑模式、跨文件恢复、撤销隔离、文件字节与修改时间、读取失败、慢读取期间写入保护、连续取消保存、缺失文件的内存恢复与独立保存、外部重建后的自动保存保护、热更新期间的搜索焦点和阅读视口，以及批量替换后的历史定位。四份类型检查、构建、93 个 Markdown 往返用例、198 项源码切换和 94 项链接回归通过。功能已在工作区实现，尚未发布。

### 左右侧栏独立配置

**来源：** 用户需求（2026-10-28），已确认左右各自配置内容，而非固定文件与大纲的位置。

**范围：** 默认左文件、右大纲，每侧都可选择文件或大纲，也允许两侧显示同一种内容。左右独立开关、调宽并持久化；视图菜单按左右侧栏组织，顶栏提供对应的两个开关。两侧同时打开时正文在剩余空间居中；窄窗口至少给正文留 320px，侧栏按比例暂时缩窄，放大后恢复原宽度。

**配置与兼容：** `colamd-sidebars` 按 `left` / `right` 保存各自的 `content`、`visible` 和 `width`。旧文件面板的显隐和宽度迁移到左侧；右侧首次隐藏。旧的面板位置配置不再参与布局，左右内容改由新配置决定。只改变视图，不修改文档或触发保存；导出和演示临时隐藏侧栏，退出后保留原选择。

**状态与验证：** 已在工作区实现，尚未发布。`verify:sidebar-preferences` 验证迁移、配置恢复与空间分配；`verify:sidebars` 的 46 项真实 Electron 断言覆盖双栏布局、内容对调、独立拖宽、快捷键、焦点、大纲跳转、深浅主题、演示恢复、多窗口菜单、重启与文档字节及修改时间保护。

### 持久化的隐藏空行视图

**来源：** 用户需求（2026-10-26），2026-10-28 确认改为纯显示偏好。

**范围：**「视图 → 隐藏空行」是默认关闭的勾选项，选择后立即应用于当前渲染视图，打开文件、切换标签或重启后沿用同一偏好。正文空白行、段落分隔及只含 `>`、`> >` 的引用空行在视觉上收起，保留原文中的段落和引用结构；代码、公式、HTML 和 YAML 属性区内部沿用原有显示。正在编辑的空行临时显示。入口复用原生菜单，中英同步，不增加常驻控件。

**数据约定：** 只修改编辑器装饰，不改 Markdown 缓冲区，不标记已编辑，不触发自动保存，也不进入撤销历史。源码模式、复制的 Markdown 和保存内容保留原文。编辑正文后保存，只写入用户真正改过的文字，隐藏的空行仍然保留。关闭选项恢复完整显示。

**实现：** 复用 CodeMirror 完整解析和行装饰保护特殊块，按文档缓存空行候选。开关由渲染层持久化并同步原生菜单，恢复标签状态后重新采用应用当前偏好；导出时恢复正常空行显示。`verify:blank-lines` 检查候选、焦点、装饰及撤销栈，`verify:blank-lines-ui` 验证真实菜单、行高度、字节保真、编辑后保存、跨标签与重启持久化。

### Inline HTML pairs (#125)

`<span style="color:red">文字</span>` in the middle of a paragraph styles the text between the tags. A matched pair on one line hides both tags and paints the inner text with a mark carrying the sanitized style; the text stays editable. Fixed 2026-10-08 (`8615cc0`), with `verify:features` asserting the computed colour. The earlier reply that said it already worked was wrong, and the issue was reopened with a correction.

These features are implemented on `main` and await release verification.

### Footnote hover preview

**Source:** [#25](https://github.com/marswaveai/ColaMD/issues/25)

**Status:** hovering a footnote reference shows its definition in a floating card, read from the document itself. The card is part of the hover zone so a long definition can be scrolled, moving the pointer across the gap does not dismiss it, and multi-block definitions keep their paragraphs apart.

### Markdown formatting shortcuts

**Source:** [#58](https://github.com/marswaveai/ColaMD/issues/58)

**Status:** the Edit menu carries a Format submenu with bold, italic, inline code, strikethrough, link (URL from the clipboard), bullet list and ordered list, so the shortcuts are discoverable from the menu rather than only from documentation. Commands apply only while the editor has focus. Customising or disabling them stays a candidate below.

### Remember window size and view zoom

**Source:** [#95](https://github.com/marswaveai/ColaMD/issues/95)

**Status:** the window's position, size and view zoom are stored next to the other preferences and restored on the next launch. A stored position that no longer overlaps any attached display falls back to the default size, so unplugging a monitor cannot strand the window off screen.

### Themes as standalone files, with a guide for writing your own

**Source:** [#91](https://github.com/marswaveai/ColaMD/issues/91)

All twelve built-in themes already ship as standalone, commented CSS files in [`themes/`](../themes), and [`themes/README.md`](../themes/README.md) documents the variables, direct selectors, and the rule that omitted variables inherit the Light defaults. The request was filed because nobody could find them: the README named twelve themes without linking the folder. README and README_CN now link both files. Nothing else is owed here, so the issue is closed.

### Export Word (.docx)

**Sources:** [#31](https://github.com/marswaveai/ColaMD/issues/31)

**Status:** Exports GFM document structure, common inline formatting, lists, tables, links, code blocks, and standalone local images to `.docx`. HTML and unsupported syntax degrade to text. Mermaid diagrams are drawn into the document as images, see below.

### Diagrams in the Word export

**Sources:** [#107](https://github.com/marswaveai/ColaMD/issues/107)

**Status:** Every Mermaid block in the document becomes a picture in the `.docx`. Diagrams are drawn again for the export with the app's light palette inlined into the SVG, because Word is a white page: the one on screen may belong to a dark theme, and in source mode there is no diagram on screen at all. A diagram that cannot be rendered keeps its code fence, so one broken block cannot fail an export.

### Text width

**Sources:** [#110](https://github.com/marswaveai/ColaMD/issues/110)

**Status:** View → Text Width switches the reading column between narrow (640), standard (780, the default) and wide (1080). The preference lives beside the other local preferences and applies to the editor, to source mode (which stays aligned with the editor, see [#48](https://github.com/marswaveai/ColaMD/issues/48)) and to the HTML and PDF exports. An exported image is not affected: it is drawn at its own reading width by design.

### Export shareable images

**Sources:** [#35](https://github.com/marswaveai/ColaMD/issues/35), [PR #121](https://github.com/marswaveai/ColaMD/pull/121)

**Status:** Exports the whole document as one continuous PNG at the desktop or mobile reading width. A document too tall for a single image (16384 device pixels on a side) continues as numbered reading pages, with the final page trimmed to its content, so every document still exports.

### Document outline

**Sources:** [#21](https://github.com/marswaveai/ColaMD/issues/21), [#27](https://github.com/marswaveai/ColaMD/issues/27), [#64](https://github.com/marswaveai/ColaMD/issues/64)

**Status:** Adds a Files / Outline switch in the existing sidebar. Headings navigate in both visual and Markdown source modes. The outline doubles as a reading-progress view: the entry for the section at the top of the viewport is highlighted while scrolling (both modes), the active entry stays revealed in long documents, and jumping from the outline or an anchor link flashes the landing heading once so the arrival is visible. Colors derive from each theme's link color. Long headings expose their full text through a hover tooltip.

### MDX support

**Source:** [#179](https://github.com/marswaveai/ColaMD/issues/179)

Declined. ColaMD opens a Markdown file and shows that file character for character (`save(open(x)) === x`); MDX is a JavaScript module that compiles to a component tree, so a document stops being text and becomes code that must be built, resolved and run, with a bundler, a React runtime and a security boundary inside the editor.

### Two sidebars at once (files and outline)

**Source:** [#188](https://github.com/marswaveai/ColaMD/issues/188)

Declined. The panel is one, and one press swaps what it shows. A second column is a permanent sidebar, the reading column has to give way on both sides, and narrow windows lose the place to write; the editor is a canvas that stays out of the way. If the real need is "when reading the outline I lose track of which folder I am in", a single line of the current directory at the top of the outline is the cheap answer.

### Tab drag to reorder and drag out to a new window

**Source:** [#185](https://github.com/marswaveai/ColaMD/pull/185)

Declined. Drag affordances have been rejected elsewhere in the product (panel resizing became fixed rules plus a narrow hot zone), and dragging a tab out is multi-window under another name; tabs answered that need ([#44](https://github.com/marswaveai/ColaMD/issues/44)).

### Resizable file panel

**Sources:** [#64](https://github.com/marswaveai/ColaMD/issues/64)

**Status:** The panel's right edge offers a lightweight drag hot zone (no permanent handle icon, hover stripe only, per design.md) to resize between 200px and 420px. The choice persists locally, the default stays 220px, and the hot zone hides with the panel. The floor is 200 because the window controls sit in this column's top row: at 180 the last button would land on the pixel where the tab strip starts.

### 编辑、侧栏与启动的整体性能优化

**来源：** 2026-10-29 用户要求全面排查并优化性能，确认统一实施范围。

**范围：** 复用文档分析和完整空行语法树；合并新文档安装时的路径与视图配置；减少源码导航和查找的重复全文处理；统计保持原口径并合并展示更新；大纲和文件列表复用节点并校验异步刷新版本；启动正文交付不等待目录列表。

**判断：** 保持文本优先、撤销隔离、外部修改冲突和现有渲染规则。显示惰性树、空行保护完整树和列表重编号局部解析分别保留，不为了共享缓存改变契约。已建立状态层、真实离屏窗口及外壳回归入口，测量边界见 [性能验证](performance.md)。本地 macOS 验证不替代下述 Windows 特定问题的复现，也不表示已发布。

**后续范围（2026-10-29 用户确认）：** 修复慢目录阻塞其他目录已完成结果的问题；大目录按视口挂载文件条目，保留完整目录、排序、双侧滚动、原生右键及 Tab 遍历；大文档统计分段执行，重复保存快照复用当前内容的行尾编码，空行分析跳过确定不存在的公式。保持现有大文件自动源码阈值，不改保存、冲突和标签磁盘校验顺序。目录枚举已经使用 `withFileTypes`，测量表明首屏成本主要在 DOM 与布局，因此本轮不引入后台目录服务。

### Windows startup performance

**Sources:** [#32](https://github.com/marswaveai/ColaMD/issues/32)

**Status:** Adds opt-in `COLAMD_STARTUP_TRACE=1` timing from main-process load through editor readiness. Export dependencies are dynamically loaded, reducing the main startup bundle from about 1.73 MB to 604 KB.

### Diagram rendering (Mermaid)

**Sources:** [#26](https://github.com/marswaveai/ColaMD/issues/26)

**Status:** Mermaid blocks are rendered by [Pele](https://github.com/obsidianmd/pele) (MIT), the renderer Obsidian ships next. It is synchronous and dependency-free, so the hidden iframe, the 400ms debounce and the 15s timeout recovery are all gone; the engine itself is loaded on demand, so a document without a diagram pays nothing. Kept: click-to-edit source mode, and a block that fails to render keeps its code fence. Diagram colour comes from CSS variables that are derived from the theme (`themes/editor-preview.css`), so switching themes repaints the diagram without re-rendering it.

Zoom (#129): a diagram that does not fit the column can be zoomed with Ctrl/⌘ + scroll wheel, the buttons in its corner, or a double click, and dragged to pan while zoomed. A diagram that already fits gets no controls at all. Exports reset the viewport and hide the buttons, so a zoomed diagram still leaves the whole picture on paper.

### Visible save status hint

**Source:** [#49](https://github.com/marswaveai/ColaMD/issues/49)

**Status:** A quiet `未保存 / 已保存` hint sits beside the filename in the title bar. It is also the one place that reports an external-edit conflict waiting on a choice, and, after the disk version is loaded, that the dropped version is still on disk (the hint is clickable there and reveals the file). No timestamps, no toasts.

### A copy is kept before unsaved work is discarded

**Sources:** [#115](https://github.com/marswaveai/ColaMD/issues/115)

**Status:** Loading the disk version after an external edit is the one action that used to throw unsaved input away with no trace (the editor flushes its undo history at the same time). The dropped version is now written to `~/.colamd/recovered/<document>-<timestamp>.md` first, the dialog button says so before it happens, and the title bar reports where it went. If the copy cannot be written, nothing is discarded: the editor keeps its version. The wider request behind this issue (a version history with retention and a restore view) is not planned; see Candidates.

### Link and anchor navigation

**Source:** [#50](https://github.com/marswaveai/ColaMD/issues/50)

**Status:** Plain clicks follow all links: `[text](#anchor)` navigates within the document, `[text](other.md#anchor)` opens or activates the target Markdown tab and then navigates, and HTTP/HTTPS links open in the system browser. Relative file paths resolve against the current document's directory. Modifier keys are optional.

Targets include headings and explicit HTML IDs such as `<a id="1-先区分五类对象">`. Exact HTML IDs take precedence over generated heading anchors; duplicate IDs use the first occurrence. Heading resolution preserves Chinese, decodes URL-encoded fragments, removes punctuation, allows case-insensitive fallback, and uses `-1`/`-2` suffixes for repeated headings. HTML tags embedded in a heading do not become part of its generated anchor. Code examples, comments, frontmatter, and filtered HTML content do not create HTML targets. Full-document source lookup finds offscreen targets; once an HTML block is rendered, navigation locates the target inside that block without moving the caret into HTML source. Missing anchors leave the current position unchanged. Navigation does not edit document bytes or create duplicate tabs.

### Theme menu selected state

**Status:** Theme menu entries are now checkboxes showing the active theme, including imported custom themes. The renderer reports the applied theme to the main process, which rebuilds the menu on change.

### Recent files and restore last session

**Source:** [#28](https://github.com/marswaveai/ColaMD/issues/28), [#45](https://github.com/marswaveai/ColaMD/issues/45)

**Status:** File → Open Recent lists the last 10 documents (stale paths pruned). Opening or Save-As records the file in `~/.colamd/recent.json`. At launch the app reopens the most recent document by default; a checkbox in the same submenu turns restore off, and Clear Recent wipes the list. The startup restore policy is queued for redesign; the desired default is a blank launch unless the previous session ended unexpectedly or the system restarted.

### Configurable editor font

**Source:** User request (#7752855)

**Status:** View → Editor Font… opens a settings dialog with font family and size plus a live preview. The preference is layered user > theme > defaults, overriding only the editor prose and source mode; code blocks and UI keep their theme fonts. Stored locally, synced across windows.

### Multiple windows

**Source:** [#44](https://github.com/marswaveai/ColaMD/issues/44)

**Status:** File → New Window opens an independent editor window; opening a file that is already open focuses its window, and an empty window is reused before spawning a new one. Each window keeps its own file, save queue, watcher, and unsaved-changes guard.

### Startup session restore policy

**Source:** User feedback (2026-08-28)

**Need:** Keep normal launches blank instead of automatically reopening the last document. Reopen documents only when there is a clear recovery context, such as an unexpected app exit or system restart.

**Scope:** Separate the recent-files list from session recovery, define how intentional quit differs from a crash or restart, and keep recovery explicit and predictable. Remove or redesign the current default-on "restore last document" behavior.

**Status:** Deferred. The current restore behavior remains in `v2.0.0`; do not change it in this release.

### Reveal in file manager (hover on the document title)

**Sources:** [#83](https://github.com/marswaveai/ColaMD/issues/83), [#84](https://github.com/marswaveai/ColaMD/pull/84) by @moyu12-ae

The reveal button shipped in v2.0.4 and v2.0.5 was unreachable, but not because hover in the titlebar is unreliable. Commit `8dc5097` (stop undo from crossing documents) refactored `main.ts` and deleted every renderer hookup for the button: the element accessor, the `fileManagerName` state, `fileLocationLabel()`, `updateFileRevealButton()` and the click binding, while `index.html` kept its hardcoded `disabled`. The visibility rule is `#titlebar:hover #reveal-file-btn:not(:disabled)`, so a permanently disabled button can never match and stays at `opacity: 0`, which presents as a broken hover. The wiring is restored, and the button appears when the file name is hovered.

**Decision (2026-09-12):** the button stays hover-only. A constant fourth titlebar icon was considered and dropped: the hover reveal works, and the titlebar should stay as empty as possible.

### Tabs and multi-document workspace

**Sources:** [#59](https://github.com/marswaveai/ColaMD/issues/59)

**Status:** Shipped in `v2.1.0`. Keep several documents open in one window instead of replacing the current document. Each tab holds its own content, unsaved state, undo history and scroll position.

**In progress (maintainer).** The tab strip itself is actively being refined — chrome height, the hover `⌘W` affordance, tab widths and the title-bar relationship are all still moving ([#90](https://github.com/marswaveai/ColaMD/issues/90)). Do not start a parallel tab implementation; comment on the issue or open a PR against the maintainer's current work instead.

Re-opened as a candidate on 2026-09-11 instead of staying declined, then designed and built during 2026-09-13. The spec lives in `design.md` (section on tabs): user-created tabs only, no strip until there are two tabs, no persistence, no drag between windows. Creation entries are `⌘T`, File → New Tab, and the file panel's right-click Open in New Tab; there is deliberately no plus button in the chrome.

## Security Maintenance

### Upgrade Electron and transitive security dependencies

**Source:** `npm audit` (2026-08-28)

**Need:** Upgrade the Electron runtime and its transitive dependencies to versions that address the currently reported security advisories, without weakening the app's document and renderer security model.

**Scope:** Evaluate the required Electron major-version upgrade, then verify macOS code signing and notarization, Windows and Linux builds, auto-update manifests, Mermaid rendering, file opening, IPC boundaries, and unsaved-document protection on every supported platform.

**Status:** Planned. Do not mix this with issue #55, whose reported PostCSS version is outdated and is not present in the current dependency tree.

## Website feature cards (positioning)

**Decision (2026-09-13):** the nine cards on colamd.com are ordered by user demand, not by internal build order:

1. True WYSIWYG (真正的所见即所得)
2. Always in Sync (文件永远是最新的)
3. Export (导出)
4. Tabs (标签页)
5. Diagrams (图表)
6. Same-Directory Files (同目录文件管理)
7. Outline & Find (长文档导航)
8. Rich Text Copy (富文本复制)
9. Cross-Platform (跨平台)

Evidence used:

- **Our own issue tracker** (40 issues). By topic: 代码块 4 (#29, #30, #53, #54), 图表 3 (#40, #42, #51), 导出 3 (#31, #35, #71), 大纲 3 (#27, #37, #64), 保存与自动保存 3 (#34, #39, #49), 多文档 3 (#44, #59, #65), Windows 性能 2 (#32, #78), 最近文件与会话还原 2 (#28, #45).
- **Search suggestions.** Baidu's suggester returns queries ordered by popularity, and every one of these exists as a popular query: `markdown转word`, `markdown导出pdf`, `markdown实时预览`, `markdown所见即所得`, `markdown自动保存`, `markdown流程图`. Google's suggestion endpoint was unreachable from the build machine, so it was not used. `markdown大纲` drifts to 「大纲是什么意思」, meaning the term itself has low awareness: that is why card 7 says 「长文档导航」 rather than 「大纲」.

**Dropped: Clean by Design / 界面克制.** It is an identity, not a feature, and no issue asked for it. The feeling it carried (极简无负担) now lives in the hero description instead: "a quiet home: your text and a file list, no toolbar and nothing to configure".

**Added: Diagrams / 图表** (Mermaid, shipped in v2.0.0).

Rule kept: exactly nine cards. The order is documented in an HTML comment above the card list on the gh-pages branch.

## Candidates

### 整理空行（一次动作，不自动）

**Source:** [#188](https://github.com/marswaveai/ColaMD/issues/188)

LLM 生成的 Markdown 常常在段落之间留一串空行，读起来松垮。要的是一个「整理空行」的命令：连续空行并成一条，代码块和属性区里不动，行尾空白顺手去掉，整篇只留一次撤销。

**Not automatic.** 打开文件时悄悄改一遍别人的文档，和「文件是最新的、也是你写的那个样子」直接冲突；只有用户按下它才动。

**Status:** Candidate, not scheduled.

### 文件重命名 (#185)

**Source:** [#185](https://github.com/marswaveai/ColaMD/pull/185)

改文件名现在要去文件管理器。需要的是文件列表右键里的「重命名」：保留扩展名、同名冲突要提示、成功后同步已打开的标签、文件监听和最近打开记录。PR #185 里这一半是可以要的。

**Not wanted from that PR:** 标签拖拽排序和拖出独立窗口。拖拽在本产品里反复被否（面板调宽改成固定规则加窄热区、标签排序一直是 Candidate 里「先问值不值得」的那条），而拖出窗口就是多窗口，多窗口的需求在 [#44](https://github.com/marswaveai/ColaMD/issues/44) 里已经由标签页回答了。

**Status:** Candidate, not scheduled.

### 右键菜单：插入表格、待办、列表、标题层级 (#163)

**Source:** [#163](https://github.com/marswaveai/ColaMD/issues/163)

**Need:** 写项目文档时表格用得多，但画一张表只能手敲 `|---|---|`。要的是编辑器里的右键菜单：插入表格（能选几行几列）、待办、有序/无序列表，以及把当前行调成某一级标题。参考对象是 Typora 的右键菜单。

**Scope:** 菜单挂在正文上，条目跟光标所在的块走（在表格里给表格相关的操作，在列表里给列表的）。插入表格要能继续填格子，不是只塞进一行语法。不新增常驻工具栏。

**Status:** Candidate, not scheduled.

### 公众号排版模式（WeChat article formatting）

**Source:** User request (2026-10-06).

**Need:** 稿子写完要贴进公众号，但现在复制出去的是给网页看的 HTML：粘进公众号编辑器之后背景被抹掉、宽度撑爆、代码块散架。要的是一个**模式**——点进去之后，复制拿到的就是微信公众号编辑器吃得下的那种 HTML。用户对要求的原话是「不支持背景，宽度也有要求，反正有一堆要求」，这一堆要求就是下面这些。

**Constraints（公众号编辑器的硬规矩，写下来免得重新踩）:**

- 只吃**行内样式**：`<style>`、`class`、`id` 会被丢掉。输出必须把每条样式内联到元素上，不能依赖主题 CSS，也不能带任何 `cm-` 之类的编辑器类名。
- 不支持页面背景、阴影、固定定位、动画。输出是一张白底、系统字体族、行高固定的「公众号纸张」，主题里的这些效果在这个模式下要关掉。
- 宽度按手机算（375–414 逻辑像素）。图片 `max-width: 100%`，而且必须先变成公众号能自己搬走的形态：本地文件路径在公众号里打不开，需要 URL 或 data URL。**这是第一个要先拍板的事。**
- 代码块在公众号里不能横向滚动。需要等宽内联样式加换行策略，长行怎么处理要定。
- 公式、Mermaid、图片这些「不是文字」的东西公众号不渲染，只能先转成图片。图片导出那条链路已经有渲染器（`src/main/image-export.ts`、`mermaid-export.ts`），可以直接复用。
- 正文里的外链在公众号不跳转（只能走「阅读原文」或白名单）。保留成纯文本、还是加一句提示，**这是第二个要先拍板的事。**
- 脚注、锚点跳转同样不生效，只能落在末尾当列表。

**Architecture note:** 现有的富文本复制（`writeRichCopy()`）已经能产出语义 HTML，所以这个模式的本质是「同一套渲染 + 一份公众号专用的输出样式」，不是第二个渲染器。按「如非必要，勿增实体」，入口落在菜单里，不新增常驻工具栏。

**Status:** Candidate, not scheduled. 参考实现是现成的（mdnice / markdown-nice 那一路：Markdown → 行内样式 HTML）。按项目里「参考老前辈的决策」的原则，先研究它们的样式表怎么定，再决定我们的做法，不自己发明一套。

### Selectable text inside a rendered block (#141, #153)

**Source:** [#141](https://github.com/marswaveai/ColaMD/issues/141), [#153](https://github.com/marswaveai/ColaMD/issues/153)

A rendered block (table, diagram, image, formula, raw HTML) is a replacement widget, so its own text never enters the selection model: dragging across a rendered table selects nothing, and the same holds for a diagram's labels.

2026-10-15 changed what a click does (#153): block widgets reveal their Markdown while the caret is inside, and clicking a table cell lands the caret in that cell of the source (`isBlockActive` in `live-preview.ts`, `tableCellAnchor` in `editor.ts`). The reported problem, that typing after clicking a table destroyed it, is gone with that.

Still open: editing and selecting text inside the rendered block itself, without stepping into the source. The document is text and rendering is a layer of decoration over it (`docs/editor-architecture.md`), so that is a structural change rather than a styling fix: the rendered table would have to stay real text, with the pipes hidden and the cells padded so the columns line up. Undecided.

### XDG data directories on Linux (#142)

**Source:** [#142](https://github.com/marswaveai/ColaMD/issues/142)

Three paths are hardcoded under the home directory on all three platforms: `~/.colamd/themes`, `~/.colamd/recovered` and `~/.colamd/recent.json` (`src/main/index.ts`). Everything Electron manages already follows the platform convention: window state, language, the update flag and the renderer error log live in `userData`, which on Linux is `$XDG_CONFIG_HOME/colamd`. Moving the three to `$XDG_CONFIG_HOME` and `$XDG_DATA_HOME` means deciding what macOS and Windows do in the same breath, plus a migration for data already written. Reported as a standards issue rather than a breakage. Undecided.

### One row title bar with tabs

**Source:** [#90](https://github.com/marswaveai/ColaMD/issues/90)

Following the tab strip, the title bar and the strip cost two rows of vertical space. Chrome collapses them into one. ColaMD's title bar also carries a centred filename and three buttons on the right, so the merge needs a decision about where those go before it is a visual change.

### Tab reordering by drag

**Source:** [#59](https://github.com/marswaveai/ColaMD/issues/59)

Tabs can be opened and closed but not reordered. Not decided. Drag interactions have been declined elsewhere in the product (panel resize was replaced by fixed rules plus a narrow hot zone), so this needs the same question asked: does the value justify a drag affordance that appears nowhere else.

### Renderer costs found while measuring startup (#100)

**Source:** [#100](https://github.com/marswaveai/ColaMD/issues/100)

Measured, not guessed, and cheap enough to be worth listing:

- Word count runs three full-document regex passes about 200ms after typing stops, although the number is only shown on hover. Compute on demand or maintain incrementally.
- KaTeX sits on the startup path: 473KB is parsed even for a document with no math. Lazy-load it the way the diagram engine already is.
- `releaseMermaidRenderer()` destroys the sandbox iframe on every file open, so a document with diagrams rebuilds and recompiles them each time. Being checked together with [#94](https://github.com/marswaveai/ColaMD/issues/94).
- Windows-only compositing costs (`backdrop-filter`, several `box-shadow`) on integrated graphics, and documents between the source-mode threshold and "large". Measure before touching.

### Portable build (zip distribution)

**Sources:** [#63](https://github.com/marswaveai/ColaMD/issues/63), user feedback again on 2026-09-13

Publish the existing mac zip artifact as a visible download alongside the dmg so the app can run unzipped without installation. The mac side is already published.

**Decision (2026-09-13):** ship the `zip` target on Windows. A folder you unzip and run beats a self-extracting exe for an editor that has to feel immediate on launch, and someone will package it anyway if we do not. Settings stay in `%APPDATA%` like the installed build, so the green build leaves that folder behind; revisit if users ask for a fully self-contained folder.

Windows is the open half, and a Windows user asked again. Two shapes, and they are not equivalent:

- `zip` target: the unpacked app in an archive. Unzip anywhere and run, nothing touches the registry, "uninstall" is deleting the folder, and startup is unchanged. This is the classic green build.
- `portable` target: one self-extracting exe. Friendlier to hand around, but it unpacks to a temp folder on every launch, which costs startup time, and antivirus heuristics are less friendly to it.

Both lose what the installer provides: `.md` file association, a Start Menu entry, and automatic updates. A green build needs its own update path (tell the user a new version exists and send them to the download page). Settings location also needs a decision: keep them in `%APPDATA%` like the installed build, or keep them next to the executable for a fully self-contained folder.

### Slow second-file open

**Sources:** [#63](https://github.com/marswaveai/ColaMD/issues/63)

Bug report: opening the first .md is fast, but opening another file while one is already open stalls for a long time. Profile the second-open path (window reuse, watcher re-establish, editor re-init) before optimizing; measure first per the Windows startup performance precedent.


### Merge documents from different directories into one tab group

**Sources:** [#59](https://github.com/marswaveai/ColaMD/issues/59)

**Status:** partially addressed on `main` (#99): files arriving from the OS (double-click, second launch) now open as tabs of the existing window, and ⌘O / recent files open as tabs too. What remains is the in-app path: the file panel still browses only the active document's directory, so collecting documents from several folders into one window needs a panel-level decision (recents view, pinned folders, or a full picker). Not scheduled.



### Document version history (bounded snapshots)

**Sources:** [#115](https://github.com/marswaveai/ColaMD/issues/115)

**Status:** Candidate, the wider version of what shipped. A snapshot schedule, a retention policy and a list with diffs to restore from is a subsystem: it needs a place to live, a story for how long copies survive, and a view to pick from. What shipped instead is the safety net for the one irreversible path (a copy of the version being discarded, written next to the other app data). Revisit if the copies prove hard to find, or if a second irreversible path appears.

### Plugin ecosystem

**Raised:** 2026-09-11, by the maintainer.

Let people write their own plugins, so ColaMD grows through an ecosystem instead of shipping every capability itself. Mermaid is the first candidate to be extracted into a plugin, which would prove the API and keep the core small.

Requests already queued for this direction: image hosting such as PicGo ([#79](https://github.com/marswaveai/ColaMD/issues/79)), which is exactly the kind of integration that should not be built in.

Open questions before any implementation: what a plugin may touch (editor commands, menus, export pipeline, file I/O), how plugins are installed and updated, the security and permission model (plugins run in the renderer, so sandboxing matters), and how to keep a default install zero-configuration.

### Knap interop (data to Markdown templates)

**Raised:** 2026-09-11, after Obsidian's author released [Knap](https://github.com/obsidianmd/knap) (MIT, `obsidianmd/knap`), a template language that turns data into Markdown, shared by Obsidian Web Clipper and Importer.

ColaMD's thesis is Markdown as a database: fixed fields in `.md`, many views on top. Knap is the mirror step, data into Markdown, so it is closer to an ingestion standard than a competitor. Two shapes worth considering, neither committed:

- Point users at Knap instead of inventing a template language: `npx knap render template.md --data article.json --output note.md` writes a file that ColaMD already hot-reloads, which makes ColaMD the live view for generated Markdown.
- Later, treat Knap as the structured-input path for the database workflow (fields in, Markdown out) and keep HTML templates as the view layer.

Interop is cheap because Knap is an AST interpreter with no `eval` and ships a CLI; reimplementing a templating language would not be.

The maintainer also raised the mirror idea on 2026-09-11: ColaMD itself could ship as a plugin for another host, so the product is both a host for templates and guests in other ecosystems. Tracked here as direction only, with no scope decided.


### Shortcut customization (keybinding preferences)

**Source:** User request (2026-09-13), raised while reviewing the formatting shortcuts.

**Need:** Let users remap or disable shortcuts, starting with the format shortcuts.

**Scope:** This is a preferences subsystem, not a toggle: storage, conflict detection against existing accelerators, re-registration, and a settings dialog in the pattern of the editor-font dialog (the only preference UI in the app). macOS users can already remap any menu accelerator in System Settings → Keyboard → App Shortcuts without code; Windows and Linux have no such mechanism, which is where the real gap sits.

**Status:** Candidate. Explicitly out of #58's first version per its scope note. Revisit when the shortcut surface grows or Windows/Linux users ask.

### Import local images

**Source:** [#21](https://github.com/marswaveai/ColaMD/issues/21)

**Need:** Insert local images into Markdown without compromising editor stability or document content.

**Status:** Deferred. The initial menu, paste, and drag-and-drop implementation was removed before `v1.9.0` after it proved unreliable.

**Scope constraint (2026-09-11):** two complete image pipelines were declined this day (see Declined → Rich image pipelines). If this is ever restarted it must stay minimal: zero configuration by default, images written next to the document as relative references, no new menu, settings panel, floating toolbar, or other persistent UI.

### Publish ColaMD for iOS

**Source:** User request

**Need:** Publish the iOS app under the unified `ColaMD` product name so anyone can install it from the App Store.

**Scope:** Publish the main ColaMD app first: create the App Store Connect record, configure Release distribution signing, upload an archive, run internal and external TestFlight verification, prepare screenshots and store metadata, complete privacy and export-compliance declarations, submit App Review, and verify public installation plus `.md` / `.txt` opening after release. Defer the Share Extension until it has a clear user need; it is an optional later update, not a prerequisite for the first release.

**Signing note:** Development signing is only for registered test devices. App Store distribution signing is a separate profile that Xcode can create and manage automatically from the company Apple Developer Program account. No manual profile editing is planned.

**Status:** Deferred. First release scope is the main app only; Share Extension remains optional.

### Merge Windows menu bar into title bar

**Source:** [#46](https://github.com/marswaveai/ColaMD/issues/46)

**Need:** On Windows, put menu items on the same row as the document title and window controls (like VS Code), reclaiming one row of vertical space.

**Why it fits:** Reduces top chrome on Windows where the separate native menu bar wastes height.

**Constraints:** Keep native minimize/maximize/close behavior, keyboard access to menus, existing shortcuts, and window dragging. Only affects Windows; macOS already integrates menus natively.

### AI-assisted features (scope undecided)

**Raised:** 2026-09-11, by the maintainer, without a chosen scope (translation mentioned as one example).

No decision yet on which AI capabilities belong in the editor, and therefore no commitment. The earlier notes on built-in translation still describe the cost of getting this wrong (provider, configuration, privacy, product scope). Any concrete proposal should start from a narrow, zero-configuration shape that does not add persistent UI, and be reviewed against the same principles as everything else.

**Need:** fenced code blocks currently render as plain monospace. Highlight common languages with a lightweight highlighter that stays out of the startup bundle, loaded lazily the way Mermaid is, so a document with no code still costs nothing.

### Code block syntax highlighting

**Sources:** [#54](https://github.com/marswaveai/ColaMD/issues/54)

Fenced code blocks currently render as plain styled text with a copy button, without language-aware colouring. Adding it means shipping a highlighter and deciding which languages to support, so it stays tracked rather than committed. The issue remains open.


## Declined

### Official Homebrew tap

**Source:** [#140](https://github.com/marswaveai/ColaMD/issues/140)

Declined (2026-10-08). A tap is a second distribution channel that has to be kept in step with every release, with its own failure modes, and macOS already has a signed and notarized dmg plus a zip that updates itself. Keeping a personal cask is fine and does not need us: the artifact name is fixed (`ColaMD-<version>-<arch>.dmg`), the app is `ColaMD.app`, and the GitHub API publishes a `sha256` digest per asset. The details are in the issue.

### Theme following the system appearance

**Source:** [#113](https://github.com/marswaveai/ColaMD/issues/113), [PR #116](https://github.com/marswaveai/ColaMD/pull/116)

Declined (2026-09-21). Two reasons, both visible in the proposed PR. It is a default behaviour change with no switch, so a reader who picked a theme would have it overridden by the OS, and the automatic switch writes its choice into the saved theme, so a chosen theme is lost and does not come back. The payoff is small: the theme menu is one click away, and it is the reader who knows whether a document wants light or dark paper. Recorded here so the same request does not have to be re-argued from scratch.

### Cross-directory file tree in the panel

**Source:** [#96](https://github.com/marswaveai/ColaMD/issues/96)

Declined (2026-09-15), after re-examining it rather than on first instinct. An expanding tree would bring expansion state, cached directory reads, and level navigation into a panel whose single job is the current document's folder, and the edge cases are exactly where such a tree gets expensive (deep paths in a 220px panel, hover and renaming per level, right-click menus at every depth). The user-facing answer is that a hierarchy is not being introduced for now. Tabs already hold documents from any path in one window, so cross-folder work has an answer that costs no new structure.


### System WebView shell (Tauri) migration

**Declined (2026-09-13).** On macOS a system-WebView shell would collapse the download from 82 MB to roughly Typora's 14 MB, because the OS supplies the browser. It does not pay off anywhere else: Typora's own Windows installer is 86 to 108 MB for the same reason ours is 115 MB, there is no dependable system WebView on Windows, and WebKitGTK on Linux carries real distro and rendering risk. A main-process rewrite for one of three platforms is not worth it. Revisit only if ColaMD ever becomes macOS-only.


### Built-in translation

Translation introduces provider, configuration, privacy, and product-scope complexity outside ColaMD's focused Markdown editing role.

### Resizable file panel

Implemented in the `2.0.2` candidate: the file panel width can be adjusted and is retained locally.

### Rich image pipelines

**Sources:** [#73](https://github.com/marswaveai/ColaMD/pull/73), [#74](https://github.com/marswaveai/ColaMD/pull/74)

Two full image workflows were declined: a configurable import pipeline (Image menu, seven folder choices, copy/reference/embed modes) and a paste pipeline with a Feishu-style floating toolbar, lightbox, and base64 migration. Both add persistent UI, settings, or image-management subsystems, and the product keeps the interface to title bar, editor, and file panel，one setting screen is already too much, and a default that needs configuring is the wrong default.

### Heuristic agent activity indicator

The status dot driven by file-watcher timing was removed on 2026-09-11. It could not distinguish an agent from any other external write (a checkout, a sync tool, another editor), so its "Agent is editing" label was a guess; and it duplicated the signal the hot reload already gives, since the document visibly updates. A real agent indicator would require an actual session handshake，an agent runtime telling the app which document it is editing，and is a separate feature, not a watcher heuristic.

### Ultrawide paged reading layouts

**Source:** [#67](https://github.com/marswaveai/ColaMD/pull/67)

Two- and three-page reading layouts for ultrawide displays were declined. ColaMD is an editor, not a paginated reader; the feature costs ~480 lines of pagination logic, hijacks wheel/trackpad/page keys, and sits on the known-fragile CSS multicol + contenteditable ground (IME, cross-column selection, position loss after external reload) for a single edge-case scenario.

### Temporary same-directory document switcher

**Superseded — do not build.** This was the 2026-09-01 direction for the same need as tabs ([#59](https://github.com/marswaveai/ColaMD/issues/59)): a quiet strip below the title bar holding up to three same-directory documents. The tab strip shipped in `v2.1.0` covers that need with an explicit model instead (open a tab when you want one, the file panel keeps replacing the current document), so the switcher is closed and the prototype in `temporary-document-switcher-prototype.html` is history rather than a plan.
