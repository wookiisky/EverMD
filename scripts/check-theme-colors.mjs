import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const dir_project = process.cwd()
const path_base = path.join(dir_project, 'src/renderer/themes/base.css')
const dir_themes = path.join(dir_project, 'themes')

// 历史 CSS 是兼容样例；新主题仅维护统一配置及生成的 YAML。
const LEGACY_THEME_IDS = new Set(['light', 'elegant', 'notion', 'writer', 'bear', 'sepia',
	'dark', 'gruvbox', 'midnight', 'solarized-dark', 'nord', 'dracula'])

const text_base = fs.readFileSync(path_base, 'utf8')
const bundle = await build({ entryPoints: ['src/shared/theme-definition.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { BUILTIN_THEMES, THEME_COLOR_FIELDS } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

function getVariables(text_block) {
	const values_token = {}
	const pattern_token = /--([a-z-]+):\s*([^;]+);/g

	for (const match_token of text_block.matchAll(pattern_token)) {
		values_token[match_token[1]] = match_token[2].trim().toLowerCase()
	}

	return values_token
}

function getDefaultTheme() {
	return getBuiltInTheme('light')
}

function getCustomTheme(text_theme) {
	return {
		...getDefaultTheme(),
		...getVariables(text_theme)
	}
}

function getBuiltInTheme(name_theme) {
	const theme = BUILTIN_THEMES.find(theme => theme.id === name_theme)
	assert.ok(theme, `Missing built-in theme: ${name_theme}`)
	return Object.fromEntries(THEME_COLOR_FIELDS.filter(field => theme.colors[field.key] !== undefined)
		.map(field => [field.variable.slice(2), theme.colors[field.key].toLowerCase()]))
}

function getStandaloneTheme(name_theme) {
	const path_theme = path.join(dir_themes, `${name_theme}.css`)
	const text_theme = fs.readFileSync(path_theme, 'utf8')
	const match_root = text_theme.match(/:root\s*\{([^}]+)\}/)
	assert.ok(match_root, `Missing :root block: ${name_theme}.css`)
	return getVariables(match_root[1])
}

function getRelativeLuminance(value_hex) {
	const values_rgb = value_hex.slice(1).match(/.{2}/g)
	assert.ok(values_rgb, `Invalid hex color: ${value_hex}`)
	const values_linear = values_rgb.map((value_channel) => {
		const value_srgb = Number.parseInt(value_channel, 16) / 255
		return value_srgb <= 0.04045
			? value_srgb / 12.92
			: ((value_srgb + 0.055) / 1.055) ** 2.4
	})

	return 0.2126 * values_linear[0]
		+ 0.7152 * values_linear[1]
		+ 0.0722 * values_linear[2]
}

function blendColors(value_foreground, value_background, opacity_foreground) {
	const values_foreground = value_foreground.slice(1).match(/.{2}/g)
	const values_background = value_background.slice(1).match(/.{2}/g)
	assert.ok(values_foreground, `Invalid hex color: ${value_foreground}`)
	assert.ok(values_background, `Invalid hex color: ${value_background}`)
	const values_blended = values_foreground.map((value_channel, index_channel) => {
		const channel_foreground = Number.parseInt(value_channel, 16)
		const channel_background = Number.parseInt(values_background[index_channel], 16)
		return Math.round(
			channel_foreground * opacity_foreground
			+ channel_background * (1 - opacity_foreground)
		)
	})

	return `#${values_blended
		.map((value_channel) => value_channel.toString(16).padStart(2, '0'))
		.join('')}`
}

function getContrastRatio(value_foreground, value_background) {
	const luminance_foreground = getRelativeLuminance(value_foreground)
	const luminance_background = getRelativeLuminance(value_background)
	const luminance_light = Math.max(luminance_foreground, luminance_background)
	const luminance_dark = Math.min(luminance_foreground, luminance_background)
	return (luminance_light + 0.05) / (luminance_dark + 0.05)
}

for (const theme of BUILTIN_THEMES) {
	const name_theme = theme.id
	const values_built_in = getBuiltInTheme(name_theme)
	if (!LEGACY_THEME_IDS.has(name_theme)) {
		const codeBackground = theme.colors.codeBlockBackground
		for (const [kind, color] of Object.entries(theme.syntax)) {
			assert.ok(getContrastRatio(color, codeBackground) >= 4.5, `${name_theme} code ${kind} must meet WCAG AA`)
		}
		assert.ok(getContrastRatio(theme.colors.codeBlockText, codeBackground) >= 4.5, `${name_theme} code text must meet WCAG AA`)
		assert.ok(getContrastRatio(theme.styles.inlineCode.color, theme.colors.inlineCodeBackground) >= 4.5, `${name_theme} inline code must meet WCAG AA`)
		for (const surface of ['chromeBackground', 'sidebarBackground']) {
			assert.ok(getContrastRatio(theme.colors.textSecondary, theme.colors[surface]) >= 4.5, `${name_theme} secondary text on ${surface} must meet WCAG AA`)
		}
	}
	const value_secondary = values_built_in['text-secondary']

	if (LEGACY_THEME_IDS.has(name_theme)) {
		assert.equal(getStandaloneTheme(name_theme)['text-secondary'], value_secondary)
	} else {
		for (const key of ['text-color', 'link-color']) {
			assert.ok(getContrastRatio(values_built_in[key], values_built_in['bg-color']) >= 4.5,
				`${name_theme} ${key} must meet WCAG AA`)
		}
	}
	assert.ok(
		getContrastRatio(value_secondary, values_built_in['bg-color']) >= 4.5,
		`${name_theme} secondary text must meet WCAG AA`
	)

	for (const opacity_match of [0.18, 0.32]) {
		const value_match = blendColors(
			values_built_in['link-color'],
			values_built_in['bg-color'],
			opacity_match
		)
		assert.ok(
			getContrastRatio(values_built_in['text-color'], value_match) >= 4.5,
			`${name_theme} search match at ${opacity_match} must meet WCAG AA`
		)
	}
}

for (const name_theme of ['elegant', 'sepia', 'solarized-dark']) {
	const values_built_in = getBuiltInTheme(name_theme)
	const values_standalone = getStandaloneTheme(name_theme)
	const value_link = values_built_in['link-color']

	assert.equal(values_standalone['link-color'], value_link)
	assert.ok(
		getContrastRatio(value_link, values_built_in['bg-color']) >= 4.5,
		`${name_theme} link must meet WCAG AA`
	)
}

const values_solarized = getBuiltInTheme('solarized-dark')
assert.ok(
	getContrastRatio(values_solarized['text-color'], values_solarized['bg-color']) >= 7,
	'Solarized Dark body text must meet WCAG AAA'
)

assert.match(
	text_base,
	/--search-match-bg:\s*color-mix\(in srgb, var\(--link-color\) 18%, transparent\);/
)
assert.match(
	text_base,
	/--search-match-current-bg:\s*color-mix\(in srgb, var\(--link-color\) 32%, transparent\);/
)
assert.doesNotMatch(text_base, /body:not\(\.theme-custom\)/)
assert.match(text_base, /\.search-match\s*\{[^}]*background: var\(--search-match-bg\);/s)
assert.match(
	text_base,
	/\.search-match-current\s*\{[^}]*background: var\(--search-match-current-bg\);/s
)

const values_default = getDefaultTheme()
const values_partial = getCustomTheme(`
body {
	--link-color: #0055aa;
}
`)
assert.equal(values_partial['link-color'], '#0055aa')
assert.equal(values_partial['bg-color'], values_default['bg-color'])
assert.equal(values_partial['text-color'], values_default['text-color'])
assert.equal(values_partial['border-color'], values_default['border-color'])

const values_direct = getCustomTheme(`
#editor .cm-content .cm-md-strong {
	color: #c44b2b;
}
`)
assert.equal(values_direct['bg-color'], values_default['bg-color'])
assert.equal(values_direct['text-color'], values_default['text-color'])
assert.equal(values_direct['border-color'], values_default['border-color'])

console.log(`通过：${BUILTIN_THEMES.length} 套统一主题、历史 CSS 主题的颜色兼容、对比度、搜索高亮与缺省继承契约`)
