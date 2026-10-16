// Note parsing — pure, no React. Turns a note's Markdown body into a small AST
// that NoteRender.jsx draws as React elements (never as raw HTML), and lets the
// app read links and tags out of a note without rendering it.
//
// Block nodes:
//   { t:'h', level, c }  { t:'p', c }  { t:'ul'|'ol', items:[{ depth, checked, c }] }
//   { t:'quote', c: blocks }  { t:'code', lang, v }  { t:'hr' }
// Inline nodes (`c` is an array of these):
//   { t:'text', v } { t:'bold', c } { t:'italic', c } { t:'code', v }
//   { t:'link', href, c } { t:'wiki', raw } { t:'notes', raw } { t:'tag', v } { t:'br' }
// `wiki` is [[...]] and `notes` is {{C D E F# ...}}; what they mean (note, scale,
// chord, template) is decided by classifyWiki / notes.js, not here.

import { CHORD_INTERVALS } from './chordVocab'
import { parseFrets } from './fretParse'

// ---- pitch names ------------------------------------------------------------
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

// "F#", "Gb", "C♯", "B♭", "bb" (B flat) -> 0..11, or null if it is not a note name.
export function parsePc(s) {
  const m = /^([A-Ga-g])([#♯b♭]*)$/.exec(String(s ?? '').trim())
  if (!m) return null
  let pc = LETTER_PC[m[1].toUpperCase()]
  for (const ch of m[2]) pc += ch === '#' || ch === '♯' ? 1 : -1
  return ((pc % 12) + 12) % 12
}

// "C D E F# G A B" -> { pcs: [0,2,4,6,7,9,11] (typed order, repeats dropped), bad: [...] }.
// Separators: spaces, commas, dashes, slashes.
export function parseNoteList(text) {
  const pcs = []
  const bad = []
  for (const tok of String(text ?? '').split(/[\s,;/–-]+/).filter(Boolean)) {
    const pc = parsePc(tok)
    if (pc == null) bad.push(tok)
    else if (!pcs.includes(pc)) pcs.push(pc)
  }
  return { pcs, bad }
}

// ---- chord qualities ----------------------------------------------------------
// CHORD_INTERVALS has several spellings per chord shape ("Min 7", "min7"; "Dominant",
// "7", "dom7"). One readable name is shown per shape: the capitalised one that
// comes first. (Object.keys puts a numeric-looking key like "7" first no matter
// where it was written, so the order alone cannot be trusted.)
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '')
const sigOf = (k) => CHORD_INTERVALS[k].join(',')
const BEST_BY_SHAPE = new Map()
for (const k of Object.keys(CHORD_INTERVALS)) {
  const cur = BEST_BY_SHAPE.get(sigOf(k))
  if (!cur || (/^[A-Z]/.test(k) && !/^[A-Z]/.test(cur))) BEST_BY_SHAPE.set(sigOf(k), k)
}
// Any spelling -> the readable name of its shape ("min7", "7", "dom7" -> ...).
const QUALITY_BY_NORM = new Map()
for (const k of Object.keys(CHORD_INTERVALS)) {
  if (!QUALITY_BY_NORM.has(norm(k))) QUALITY_BY_NORM.set(norm(k), BEST_BY_SHAPE.get(sigOf(k)))
}
export function findChordQuality(text) {
  return QUALITY_BY_NORM.get(norm(text)) ?? null
}
// One name per distinct chord shape, for pickers.
export const CHORD_QUALITY_CHOICES = [...BEST_BY_SHAPE.values()]

// ---- inline parsing --------------------------------------------------------------
// Earliest match wins; ties go to the earlier entry here.
const INLINE_PATTERNS = [
  { t: 'code', re: /`([^`\n]+)`/ },
  { t: 'wiki', re: /\[\[([^\]\n]+)\]\]/ },
  { t: 'notes', re: /\{\{([^}\n]+)\}\}/ },
  { t: 'link', re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/ },
  { t: 'bold', re: /\*\*(.+?)\*\*/ }, // may contain *italic*
  { t: 'italic', re: /(?<!\*)\*([^*\n]+)\*(?!\*)/ },
  // #tag: not glued to a word, URL or another #, starts with a letter. A heading
  // ("# Title") has a space after the #, so it never matches.
  { t: 'tag', re: /(?<![\w&/#])#([A-Za-z][\w/-]*)/ },
]

export function parseInline(text) {
  const out = []
  let rest = String(text)
  while (rest.length) {
    let best = null
    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(rest)
      if (m && (best === null || m.index < best.m.index)) best = { p, m }
    }
    if (!best) {
      out.push({ t: 'text', v: rest })
      break
    }
    const { p, m } = best
    if (m.index > 0) out.push({ t: 'text', v: rest.slice(0, m.index) })
    if (p.t === 'code') out.push({ t: 'code', v: m[1] })
    else if (p.t === 'wiki') out.push({ t: 'wiki', raw: m[1] })
    else if (p.t === 'notes') out.push({ t: 'notes', raw: m[1] })
    else if (p.t === 'link') out.push({ t: 'link', href: m[2], c: parseInline(m[1]) })
    else if (p.t === 'bold') out.push({ t: 'bold', c: parseInline(m[1]) })
    else if (p.t === 'italic') out.push({ t: 'italic', c: parseInline(m[1]) })
    else out.push({ t: 'tag', v: m[1] })
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

// Text of a paragraph: single newlines become line breaks.
function inlineWithBreaks(lines) {
  const out = []
  lines.forEach((ln, i) => {
    if (i > 0) out.push({ t: 'br' })
    out.push(...parseInline(ln))
  })
  return out
}

// ---- blocks ---------------------------------------------------------------------------
const RE_FENCE = /^\s*```(.*)$/
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const RE_UL = /^(\s*)[-*+]\s+(.*)$/
const RE_OL = /^(\s*)\d+[.)]\s+(.*)$/
const RE_QUOTE = /^\s*>\s?(.*)$/

export function parseBlocks(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = RE_FENCE.exec(line)
    if (fence) {
      const lang = fence[1].trim()
      const buf = []
      i++
      while (i < lines.length && !RE_FENCE.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence (or end of text)
      blocks.push({ t: 'code', lang, v: buf.join('\n') })
      continue
    }
    const h = RE_HEADING.exec(line)
    if (h) {
      blocks.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) })
      i++
      continue
    }
    if (RE_HR.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    if (RE_QUOTE.test(line)) {
      const buf = []
      while (i < lines.length && RE_QUOTE.test(lines[i])) buf.push(RE_QUOTE.exec(lines[i++])[1])
      blocks.push({ t: 'quote', c: parseBlocks(buf.join('\n')) })
      continue
    }
    const ulm = RE_UL.exec(line)
    const olm = RE_OL.exec(line)
    if (ulm || olm) {
      const ordered = !!olm && !ulm
      const items = []
      while (i < lines.length) {
        const m = (ordered ? RE_OL : RE_UL).exec(lines[i])
        if (!m) break
        let text = m[2]
        let checked = null
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
        if (task) {
          checked = task[1] !== ' '
          text = task[2]
        }
        items.push({ depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2), checked, c: parseInline(text) })
        i++
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items })
      continue
    }
    // paragraph: runs until a blank line or the start of another block
    const buf = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !RE_FENCE.test(lines[i]) &&
      !RE_HEADING.test(lines[i]) &&
      !RE_UL.test(lines[i]) &&
      !RE_OL.test(lines[i]) &&
      !RE_QUOTE.test(lines[i]) &&
      !RE_HR.test(lines[i])
    ) {
      buf.push(lines[i++])
    }
    blocks.push({ t: 'p', c: inlineWithBreaks(buf) })
  }
  return blocks
}

// ---- walking the AST ----------------------------------------------------------------------
// Calls fn(inlineNode) for every inline node in the blocks (code is excluded
// because code blocks / code spans hold no links or tags).
export function walkInlines(blocks, fn) {
  const walkList = (list) => {
    for (const n of list) {
      fn(n)
      if (n.c && Array.isArray(n.c)) walkList(n.c)
    }
  }
  for (const b of blocks) {
    if (b.t === 'h' || b.t === 'p') walkList(b.c)
    else if (b.t === 'ul' || b.t === 'ol') for (const it of b.items) walkList(it.c)
    else if (b.t === 'quote') walkInlines(b.c, fn)
  }
}

export function extractTags(body) {
  const tags = []
  walkInlines(parseBlocks(body), (n) => {
    if (n.t === 'tag') {
      const v = n.v.toLowerCase()
      if (!tags.includes(v)) tags.push(v)
    }
  })
  return tags
}

// ---- what a [[...]] means (syntactically) --------------------------------------------------
// scale:    [[scale 7]]  [[scale 7 on D]]  [[scale My Pentatonic on D]]
// chord:    [[chord D Min 7]]  [[chord D Min 7 #3]]
// template: [[template Some name]]
// otherwise a note title, with an optional |alias.
// A scale/chord/template reference that cannot be resolved later falls back to
// a plain note link (a note may legitimately be called "Scale choices").
export function classifyWiki(raw) {
  const text = String(raw).trim()
  let m = /^scale\s+(.+?)(?:\s+on\s+([A-Ga-g][#♯b♭]*))?$/i.exec(text)
  if (m) {
    const root = m[2] ? parsePc(m[2]) : null
    return { kind: 'scale', ref: m[1].trim(), root, rootName: m[2] ?? null, raw: text }
  }
  m = /^chord\s+([A-Ga-g][#♯b♭]*)\s+(.+?)(?:\s+#(\d+))?$/i.exec(text)
  if (m) {
    return {
      kind: 'chord',
      rootPc: parsePc(m[1]),
      rootName: m[1],
      quality: findChordQuality(m[2]),
      voicing: m[3] ? Math.max(0, Number(m[3]) - 1) : 0,
      raw: text,
    }
  }
  // [[frets x 3 2 0 1 0]]  or  [[frets x 3 2 0 1 0 | C major]]: a hand-drawn shape
  m = /^frets?\s+(.+?)(?:\s*\|\s*(.*))?$/i.exec(text)
  if (m) {
    const frets = parseFrets(m[1])
    if (frets) return { kind: 'frets', frets, label: (m[2] ?? '').trim(), raw: text }
  }
  m = /^template\s+(.+)$/i.exec(text)
  if (m) return { kind: 'template', name: m[1].trim(), raw: text }
  const bar = text.indexOf('|')
  const title = (bar >= 0 ? text.slice(0, bar) : text).trim()
  const alias = bar >= 0 ? text.slice(bar + 1).trim() : ''
  return { kind: 'note', title, alias, raw: text }
}
