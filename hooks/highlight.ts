// A small line-at-a-time syntax highlighter. A diff shows lines out of context,
// so there is no multi-line state: strings and block comments are judged per line.

export type Kind =
  | 'plain' | 'keyword' | 'string' | 'number' | 'comment'
  | 'func' | 'type' | 'constant' | 'property' | 'punct'

export type Token = { text: string; kind: Kind }
export type MarkedToken = Token & { isMarked: boolean }
export type Lang = 'clike' | 'hash' | 'json' | 'css' | 'markup' | 'md' | 'plain'

const EXT: Record<string, Lang> = {}
const family = (lang: Lang, exts: string) => exts.split(' ').forEach(x => (EXT[x] = lang))
family('clike', 'ts tsx js jsx mjs cjs swift java kt kts go rs c h cc cpp hpp cs dart php scala m mm vue')
family('hash', 'py rb sh bash zsh yml yaml toml conf env r pl ini')
family('json', 'json jsonc')
family('css', 'css scss less')
family('markup', 'html xml svg')
family('md', 'md markdown')

export const langOf = (path: string): Lang => {
  const name = path.split('/').pop() ?? path
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (name === 'Dockerfile' || name === 'Makefile') return 'hash'
  return EXT[ext] ?? 'plain'
}

const KEYWORDS = new Set(
  ('abstract as async await break case catch class const continue default defer delete do else enum export ' +
    'extends extension final finally fn for from func function get guard if impl implements import in init inout ' +
    'instanceof interface internal is lazy let match mod mut namespace new of open operator override package ' +
    'private protected protocol public pub readonly return self Self set static struct super switch this throw ' +
    'throws trait try type typealias typeof union unsafe use using var void where while with yield def elif end ' +
    'lambda not and or pass raise rescue then unless until module require echo fi done esac local').split(' '),
)
const CONSTANTS = new Set('true false null undefined nil None NaN Infinity True False YES NO'.split(' '))
const DEFINES_FUNC = new Set(['def', 'func', 'fn', 'function'])
const DEFINES_TYPE = new Set(['class', 'struct', 'enum', 'interface', 'protocol', 'trait', 'type', 'extension'])

const scanner = (comment: string) =>
  new RegExp(
    `(${comment})|("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)` +
      `|(0x[0-9a-fA-F_]+|\\d[\\d_]*\\.?\\d*(?:[eE][+-]?\\d+)?)|([A-Za-z_$][\\w$]*)|(\\s+)|([\\s\\S])`,
    'g',
  )
const SCAN: Record<Lang, RegExp> = {
  clike: scanner('\\/\\/.*|\\/\\*.*?\\*\\/|\\/\\*.*'),
  hash: scanner('#.*'),
  json: scanner('\\/\\/.*'),
  css: scanner('\\/\\*.*?\\*\\/|\\/\\*.*'),
  markup: scanner('<!--.*?-->|<!--.*'),
  md: scanner('(?!)'),
  plain: scanner('(?!)'),
}

const merge = (tokens: Token[]): Token[] => {
  const out: Token[] = []
  for (const t of tokens) {
    const last = out[out.length - 1]
    if (last && last.kind === t.kind) last.text += t.text
    else out.push({ ...t })
  }
  return out
}

export const tokenize = (line: string, lang: Lang): Token[] => {
  if (line === '') return []
  if (lang === 'plain') return [{ text: line, kind: 'plain' }]
  if (lang === 'md') {
    if (/^\s*#{1,6}\s/.test(line)) return [{ text: line, kind: 'keyword' }]
    return merge(line.split(/(`[^`]*`)/).filter(Boolean).map(p => ({ text: p, kind: p.startsWith('`') ? 'string' : 'plain' }) as Token))
  }
  if ((lang === 'clike' || lang === 'css') && /^\s*(\*(\s|\/|$)|\/\*)/.test(line)) {
    return [{ text: line, kind: 'comment' }]
  }

  const raw: Token[] = []
  for (const m of line.matchAll(SCAN[lang])) {
    const text = m[0]
    if (m[1] !== undefined) raw.push({ text, kind: 'comment' })
    else if (m[2] !== undefined) raw.push({ text, kind: 'string' })
    else if (m[3] !== undefined) raw.push({ text, kind: 'number' })
    else if (m[4] !== undefined) raw.push({ text, kind: 'plain' })
    else if (m[5] !== undefined) raw.push({ text, kind: 'plain' })
    else raw.push({ text, kind: /[A-Za-z0-9_\s]/.test(text) ? 'plain' : 'punct' })
  }

  const nextSolid = (i: number) => raw.slice(i + 1).find(t => t.text.trim() !== '')
  const prevSolid = (i: number) => [...raw.slice(0, i)].reverse().find(t => t.text.trim() !== '')

  raw.forEach((t, i) => {
    if (t.kind === 'string' && lang === 'json' && nextSolid(i)?.text.startsWith(':')) t.kind = 'property'
    if (t.kind !== 'plain' || !/^[A-Za-z_$]/.test(t.text)) return
    const word = t.text
    const prev = prevSolid(i)?.text
    const isCall = nextSolid(i)?.text.startsWith('(') ?? false
    if (prev !== undefined && DEFINES_FUNC.has(prev)) t.kind = 'func'
    else if (prev !== undefined && DEFINES_TYPE.has(prev)) t.kind = 'type'
    else if (CONSTANTS.has(word)) t.kind = 'constant'
    else if (prev === '.') t.kind = isCall ? 'func' : 'property'
    else if (KEYWORDS.has(word)) t.kind = 'keyword'
    else if (isCall) t.kind = 'func'
    else if (/^[A-Z][A-Z0-9_]+$/.test(word)) t.kind = 'constant'
    else if (/^[A-Z]/.test(word)) t.kind = 'type'
  })
  // Brackets and operators read better quiet; only separators keep the accent.
  return merge(raw)
}

/** Splits tokens at [start, end) so the renderer can paint that range (the changed word). */
export const markRange = (tokens: Token[], range: readonly [number, number] | undefined): MarkedToken[] => {
  if (!range) return tokens.map(t => ({ ...t, isMarked: false }))
  const [start, end] = range
  const out: MarkedToken[] = []
  let at = 0
  for (const t of tokens) {
    const from = at
    const to = at + t.text.length
    at = to
    const cuts = [from, Math.max(from, Math.min(to, start)), Math.max(from, Math.min(to, end)), to]
    for (let k = 0; k < 3; k++) {
      const a = cuts[k]!
      const b = cuts[k + 1]!
      if (b > a) out.push({ text: t.text.slice(a - from, b - from), kind: t.kind, isMarked: k === 1 })
    }
  }
  return out
}
