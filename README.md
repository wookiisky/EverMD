# EverMD

**Language / 语言: [English](README.md) · [中文](README_CN.md)**

EverMD is an open-source Markdown editor based on [ColaMD](https://github.com/marswaveai/colamd), with changes to reading, navigation, and typography built on its existing editing capabilities.

## Introduction

I have tried so many good Markdown editors. But none of them satisfy all my requirements.

**Everyone should have his own Markdown editor.**

## Changes built on ColaMD

- **Independent left and right sidebars**: View files and the document outline together. Choose the content, visibility, and width of each sidebar independently, with settings remembered.
- **Hide blank lines**: Use View → Hide Blank Lines to collapse blank lines in the document and blockquotes. This changes the view while preserving the Markdown source and saved content; the blank line being edited remains visible.
- **Back and forward navigation**: Return to previous cursor locations and files through the View menu or keyboard shortcuts. Use `⌘⌥←` / `⌘⌥→` on macOS and `Alt+←` / `Alt+→` on Windows and Linux. Scrolling alone does not add history entries.
- **Link navigation and appearance**: Click links to visit headings, HTML anchors, other Markdown files, or web pages, including cross-file anchors and Chinese headings. Links with valid destinations in tables are underlined.
- **Emphasis around Chinese punctuation**: Improve recognition of asterisk-based bold, italic, and combined emphasis near Chinese punctuation while preserving the original Markdown characters.
- **Tighter line spacing within paragraphs**: Reduce line spacing in body text, list continuations, blockquotes, and tables while preserving the gaps between paragraphs.

See the [feature decisions](docs/feature-requests.md) for details and scope.

## Performance improvements

- **Long-document editing**: Reuse document analysis and parse blank-line visibility incrementally to reduce repeated work during typing and cursor movement.
- **Large-directory browsing**: Render only entries near the visible area and reuse file-list and outline nodes. Each directory refreshes independently, so a slow directory does not hold up the others.
- **Large-file processing**: Split word counts into cancellable chunks and reuse line-ending conversion results for saving, reducing uninterrupted computation and repeated conversions.

Local macOS tests measured a 77%–80% reduction in input handling and synchronous layout time for a roughly 230,000-character document, and about 35 ms to display a directory of 10,000 files. These measurements exclude final screen presentation latency and are not fixed gains across platforms. Large-file first-open time has not shown a consistent improvement. See [performance measurements and limitations](docs/performance.md) for details.

## Inherited capabilities

- Live Markdown rendering and source mode.
- Automatic refresh when files change on disk, for use alongside other editors, scripts, or AI tools.
- Tabs, multiple windows, search and replace, and a document outline.
- Task lists, mathematical formulas, Mermaid diagrams, and rich-text copy.
- PDF, HTML, Word, and image export.
- Twelve built-in themes, custom CSS themes, and editor font settings.
- Desktop support for macOS, Windows, and Linux.

Theme files are in [`themes/`](themes/), with a [theme authoring guide](themes/README.md) and a [template](themes/template.css).

## Upstream and acknowledgments

EverMD is based on [ColaMD](https://github.com/marswaveai/colamd). Thanks to [Cola.app](https://cola.app), [orange2ai](https://github.com/orange2ai), and the upstream contributors for the editor foundation.

The [ColaMD website](https://colamd.com/) and [upstream releases](https://github.com/marswaveai/colamd/releases) describe and distribute the original project. This repository contains the EverMD changes.

## License

Licensed under [MIT](LICENSE), with the upstream copyright notice retained.
