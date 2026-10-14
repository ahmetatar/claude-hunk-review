import type { Kind } from './highlight'

export type Palette = Record<Kind, string> & {
  bg: string
  bar: string
  border: string
  gutter: string
  text: string
  dim: string
  /** Secondary text on the pane's own background: readable, unlike `dim` (which suits comments). */
  muted: string
  accent: string
  selected: string
  addBg: string
  delBg: string
  addWord: string
  delWord: string
  addFg: string
  delFg: string
}

const tokyo: Palette = {
  bg: '#1a1b26', bar: '#16161e', border: '#3b4261', gutter: '#6b7394', text: '#c0caf5', dim: '#565f89', muted: '#8d96c4',
  accent: '#7aa2f7', selected: '#292e42',
  addBg: '#1b2e2a', delBg: '#331e2b', addWord: '#2a5a45', delWord: '#6b2a44', addFg: '#9ece6a', delFg: '#f7768e',
  plain: '#c0caf5', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', comment: '#565f89',
  func: '#7aa2f7', type: '#2ac3de', constant: '#ff9e64', property: '#73daca', punct: '#89ddff',
}

const catppuccin: Palette = {
  bg: '#1e1e2e', bar: '#181825', border: '#45475a', gutter: '#7a7f99', text: '#cdd6f4', dim: '#7f849c', muted: '#a6adc8',
  accent: '#89b4fa', selected: '#313244',
  addBg: '#1f3329', delBg: '#3a1f2a', addWord: '#2f5d45', delWord: '#7a2f4a', addFg: '#a6e3a1', delFg: '#f38ba8',
  plain: '#cdd6f4', keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', comment: '#6c7086',
  func: '#89b4fa', type: '#f9e2af', constant: '#fab387', property: '#94e2d5', punct: '#9399b2',
}

const dracula: Palette = {
  bg: '#282a36', bar: '#21222c', border: '#44475a', gutter: '#7283b6', text: '#f8f8f2', dim: '#6272a4', muted: '#a9b4dd',
  accent: '#bd93f9', selected: '#343746',
  addBg: '#23392f', delBg: '#3d2530', addWord: '#2f6b47', delWord: '#80304a', addFg: '#50fa7b', delFg: '#ff5555',
  plain: '#f8f8f2', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4',
  func: '#50fa7b', type: '#8be9fd', constant: '#bd93f9', property: '#ffb86c', punct: '#f8f8f2',
}

const githubLight: Palette = {
  bg: '#ffffff', bar: '#f6f8fa', border: '#d0d7de', gutter: '#6e7781', text: '#24292f', dim: '#6e7781', muted: '#57606a',
  accent: '#0969da', selected: '#ddf4ff',
  addBg: '#dafbe1', delBg: '#ffebe9', addWord: '#aceebb', delWord: '#ffc1c0', addFg: '#1a7f37', delFg: '#cf222e',
  plain: '#24292f', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', comment: '#6e7781',
  func: '#8250df', type: '#953800', constant: '#0550ae', property: '#0550ae', punct: '#24292f',
}

export const THEMES = ['tokyo-night', 'catppuccin', 'dracula', 'github-light'] as const

export const paletteFor = (name: unknown): Palette =>
  name === 'catppuccin' ? catppuccin
  : name === 'dracula' ? dracula
  : name === 'github-light' ? githubLight
  : tokyo
