# ColaMD Themes

ColaMD 的 21 套内置主题和用户主题采用相同的结构化配置。在 **主题 → 主题详细设置** 中修改颜色与排版，或通过 **主题 → 导入主题** 载入 YAML、JSON 和旧 CSS。

配置面板提供界面配色、各级标题、正文、强调、引用、列表、代码、表格及代码语法颜色。段内行高控制同段自动换行和手动续行；段落间距是在段尾增加的额外空隙，两者分别配置。文件里的空行仍遵循「隐藏空行」偏好，主题设置不修改 Markdown 原文。

导出可选格式化 YAML 或 JSON，两种格式表达相同配置。导出的文件独立可用，不引用其他主题文件或本机路径。导入先进入预览草稿，保存后才应用。内置主题可定制并恢复原版，也可另存副本；已有的编辑器字体偏好仍优先于主题字体。

下方 YAML 文件由 `src/shared/builtin-themes.json` 生成，内置主题只维护这一份来源。主题名称统一使用英文，桌面菜单、配置面板和网页预览均读取配置中的 `name`，不随界面语言切换。更新后运行 `node scripts/export-builtin-themes.mjs`，检查使用 `node scripts/export-builtin-themes.mjs --check`。

See the [theme swatches](../docs/images/theme-swatches.svg) for a visual preview.

## Light Themes

| Theme | File | Description |
|-------|------|-------------|
| Light | [light.yaml](light.yaml) | GitHub-inspired clean white. |
| Elegant | [elegant.yaml](elegant.yaml) | Warm serif with terracotta accents. |
| Notion | [notion.yaml](notion.yaml) | Clean minimal workspace. |
| Writer | [writer.yaml](writer.yaml) | Monospace body, restrained decoration. |
| Bear | [bear.yaml](bear.yaml) | Crisp white with red accents. |
| Sepia | [sepia.yaml](sepia.yaml) | Warm paper and serif text. |
| VS Code Light Modern | [vscode-light-modern.yaml](vscode-light-modern.yaml) | White page, gray shell and compact technical typography. |
| Solarized Light | [solarized-light.yaml](solarized-light.yaml) | Warm ivory, teal accents and spacious paragraphs. |
| Catppuccin Latte | [catppuccin-latte.yaml](catppuccin-latte.yaml) | Soft light surfaces and pastel code colors. |

## Dark Themes

| Theme | File | Description |
|-------|------|-------------|
| Dark | [dark.yaml](dark.yaml) | Soft black with blue links. |
| Gruvbox | [gruvbox.yaml](gruvbox.yaml) | Warm dark background and cream text. |
| Midnight | [midnight.yaml](midnight.yaml) | Black background and blue links. |
| Solarized Dark | [solarized-dark.yaml](solarized-dark.yaml) | Deep teal with muted accents. |
| Nord | [nord.yaml](nord.yaml) | Cool blue-grays and pale links. |
| Dracula | [dracula.yaml](dracula.yaml) | Dark background and vivid accents. |
| VS Code Dark Modern | [vscode-dark-modern.yaml](vscode-dark-modern.yaml) | Charcoal surfaces and compact technical typography. |
| One Dark | [one-dark.yaml](one-dark.yaml) | Atom blue-gray surfaces and restrained headings. |
| Monokai | [monokai.yaml](monokai.yaml) | Warm black with classic green, yellow and pink code colors. |
| GitHub Dark Default | [github-dark.yaml](github-dark.yaml) | Neutral dark surfaces and balanced README typography. |
| Tokyo Night | [tokyo-night.yaml](tokyo-night.yaml) | Deep blue surfaces, blue-purple code and relaxed spacing. |
| Catppuccin Mocha | [catppuccin-mocha.yaml](catppuccin-mocha.yaml) | Soft dark surfaces and pastel code colors. |

## 经典编辑器主题的适配

新增九套主题参考原项目的配色，适配 ColaMD 的文档、外壳、选区和代码语法。正文、引用、列表和加粗继续共用正文颜色，代码与链接保留各自的颜色。少数原版正文、次要文字或链接颜色因对比度不足而调整，因此是针对 Markdown 阅读的适配版本。

VS Code、One Dark 和 Monokai 使用较紧凑的行高与段间距，GitHub 使用均衡排版，Solarized Light、Tokyo Night 和 Catppuccin 使用较舒展的段落。字体使用本机字体及中文回退，不下载字体；用户已有字体和字号设置继续优先。主题只调整文档排版，侧栏位置、宽度、显隐、正文列宽与窗口结构仍由原有视图设置控制。

配色来源、版权和许可见 [主题来源与许可](NOTICE.md)。色卡及 YAML 由同一份内置配置生成，主题名称和数量随配置更新。

## 配置格式

配置包含 `version`、`id`、`name`、`appearance`、`colors`、`typography`、`styles`、`syntax` 和可选的 `extensions`。完整字段与单位见 [theme-config.d.ts](../src/shared/theme-config.d.ts)。省略样式字段会继承公共排版，省略代码语法颜色会根据代码背景明暗自动选择。

`typography.lineHeight` 是同段内行高倍率，`typography.paragraphSpacing` 是段落后增加的 em 空隙。`baseLineHeight` 保留旧主题的容器行高基准，供未单独配置的内容继承。表单中的「跟随默认」可恢复原配置值。

## 旧 CSS 的兼容

本目录中的 `.css` 文件是历史主题兼容样例，新主题以 YAML/JSON 为主。应用启动时会将 `~/.colamd/themes/` 中的旧 CSS 纳入统一主题库，并保留原文件；旧选中记录也会恢复到对应主题。

可识别的颜色、字体和 Markdown 样式进入可编辑字段。复杂选择器、媒体查询等仍由 `extensions.css` 保留；明确设置的配置项优先。兼容样式可在面板中查看，无法保证任意 CSS 都能反推为表单。导出 YAML/JSON 时会携带兼容样式。

以下记录历史 CSS 格式，供兼容和迁移参考。

## Historical CSS Format

The historical [template.css](template.css) documents the variable and selector hooks used by older theme files.

### CSS Variables

```css
:root {
  --bg-color: #ffffff;
  --text-color: #24292f;
  --text-secondary: #656d76;
  --text-muted: #656d76;
  --border-color: #d0d7de;
  --link-color: #0969da;
  --code-bg: rgba(0,0,0,0.05);
  --code-block-bg: #f6f8fa;
  --code-block-text: #24292f;
  --blockquote-border: #d0d7de;
  --blockquote-bg: transparent;
  --table-header-bg: #f6f8fa;
  --selection-bg: rgba(0,0,0,0.1);
}
```

`--text-secondary` is for readable labels and secondary copy. `--text-muted`
is reserved for subdued icons and disabled states. Search highlights derive
from `--link-color` automatically and can be overridden with
`--search-match-bg` and `--search-match-current-bg` when needed.

### Direct Selectors

For more control, target the editor's own class names. The editor keeps the file's
text as text and draws the formatting on top of it, so there are no `<h1>` or
`<blockquote>` elements to select. A heading is a *line* with a class, a quote is one
`div` per line, and bold text is a span:

```css
#editor .cm-content { font-family: Georgia, serif; }
#editor .cm-content .cm-md-inlinecode { color: #c44b2b; }
#editor .cm-content .cm-md-atxheading1 { letter-spacing: -0.01em; }
#editor .cm-content .cm-md-codeblock { background: #2c2c2c; color: #e0dcd7; }
```

The hooks available are:

| Selector | What it is |
|----------|------------|
| `#editor .cm-content` | The text column itself: font, size, line height, width |
| `.cm-md-atxheading1` ... `.cm-md-atxheading6` | Heading lines |
| `.cm-md-strong`, `.cm-md-em`, `.cm-md-strike`, `.cm-md-inlinecode`, `.cm-md-highlight` | Inline spans |
| `.cm-md-link`, `.cm-md-url` | Link text and the address behind it |
| `.cm-md-blockquote` | Quote lines |
| `.cm-md-codeblock` | Code block lines (the first and last also carry `-first` / `-last`, which is where the rounding goes) |
| `.cm-md-table-widget th`, `.cm-md-table-widget td` | Table cells |
| `.cm-md-hr` | Horizontal rule |
| `.cm-md-li-0` ... `.cm-md-li-6` | List indentation by depth |

Because a quote or a code block is one `div` per line rather than one box around the
whole thing, keep vertical padding off them: it would be added once for every line.
Use `padding-left` / `padding-right` for breathing room instead.

A selector that matches nothing is a silent no-op, which is how the built-in themes
once shipped rules for an editor they no longer ran on. `npm run verify:themes` in the
repository fails on exactly that: every rule has to hit a real element and change at
least one computed style.

### Tips

- Theme files should be self-contained (no external imports)
- Omitted variables inherit ColaMD's Light defaults, so override only the tokens your theme needs
- Name the file descriptively: `dark-ocean.css`, `solarized-light.css`, etc.
