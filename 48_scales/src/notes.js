// Notes: data model, storage, link resolution and the link index — pure, no React.
//
// A note is { id, title, body, createdAt, updatedAt }. Tags and links are always
// derived from `body`, never stored, so they can never go out of date.
// The notes state is { notes, openIds, activeId }: the notes, which of them are
// open as tabs (in order), and which tab is showing.

import { classifyWiki, parseBlocks, parseNoteList, walkInlines } from './noteParse'
import { recognizeScale } from './scaleRecognize'

export const NOTES_KEY = 'eightFold.notes'

export const makeNoteId = () =>
  `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const titleKey = (t) => String(t ?? '').trim().toLowerCase()

// A free title: "Untitled", "Untitled 2", ... ignoring the note being renamed.
export function uniqueTitle(notes, wanted, ignoreId = null) {
  const base = String(wanted ?? '').trim() || 'Untitled'
  const taken = new Set(notes.filter((n) => n.id !== ignoreId).map((n) => titleKey(n.title)))
  if (!taken.has(titleKey(base))) return base
  for (let i = 2; ; i++) if (!taken.has(titleKey(`${base} ${i}`))) return `${base} ${i}`
}

// ---- storage -------------------------------------------------------------------------
// Corrupt storage must not crash the app: keep what is well formed, repair the rest.
export function sanitizeNotes(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const ids = new Set()
  for (const n of raw) {
    if (!n || typeof n !== 'object') continue
    let id = typeof n.id === 'string' && n.id ? n.id : makeNoteId()
    while (ids.has(id)) id = makeNoteId()
    ids.add(id)
    const now = Date.now()
    out.push({
      id,
      title: uniqueTitle(out, typeof n.title === 'string' ? n.title : ''),
      body: typeof n.body === 'string' ? n.body : '',
      createdAt: Number.isFinite(n.createdAt) ? n.createdAt : now,
      updatedAt: Number.isFinite(n.updatedAt) ? n.updatedAt : now,
    })
  }
  return out
}

export function sanitizeState(raw) {
  const notes = sanitizeNotes(raw && raw.notes)
  const have = new Set(notes.map((n) => n.id))
  const openIds = Array.isArray(raw && raw.openIds)
    ? [...new Set(raw.openIds.filter((id) => have.has(id)))]
    : []
  const activeId = raw && have.has(raw.activeId) ? raw.activeId : openIds[0] ?? null
  return { notes, openIds, activeId: openIds.includes(activeId) ? activeId : openIds[0] ?? null }
}

export function loadNotesState(storage = globalThis.localStorage) {
  try {
    return sanitizeState(JSON.parse(storage.getItem(NOTES_KEY) || 'null'))
  } catch {
    return { notes: [], openIds: [], activeId: null }
  }
}

export function saveNotesState(state, storage = globalThis.localStorage) {
  try {
    storage.setItem(NOTES_KEY, JSON.stringify(state))
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}

// ---- state transitions ------------------------------------------------------------------
export function stateAddNote(state, { id = makeNoteId(), title = 'Untitled', body = '' } = {}) {
  const now = Date.now()
  const note = { id, title: uniqueTitle(state.notes, title), body, createdAt: now, updatedAt: now }
  return {
    notes: [...state.notes, note],
    openIds: state.openIds.includes(id) ? state.openIds : [...state.openIds, id],
    activeId: id,
  }
}

export function stateUpdateBody(state, id, body) {
  return {
    ...state,
    notes: state.notes.map((n) => (n.id === id ? { ...n, body, updatedAt: Date.now() } : n)),
  }
}

// Protect code (fences and `spans`) while rewriting links in the rest of a body.
function mapOutsideCode(body, fn) {
  const parts = String(body).split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('')
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// [[Old]] and [[Old|alias]] become [[New]] / [[New|alias]]. Returns the new body
// and how many links changed.
export function rewriteLinks(body, oldTitle, newTitle) {
  let count = 0
  const re = new RegExp(`\\[\\[\\s*${escapeRe(oldTitle.trim())}\\s*(\\|[^\\]\\n]*)?\\]\\]`, 'gi')
  const next = mapOutsideCode(body, (seg) =>
    seg.replace(re, (_m, alias) => {
      count++
      return `[[${newTitle}${alias ?? ''}]]`
    })
  )
  return { body: next, count }
}

// Renaming a note updates every [[link]] to it in the other notes.
export function stateRename(state, id, wanted) {
  const note = state.notes.find((n) => n.id === id)
  if (!note) return { state, title: wanted, rewritten: 0 }
  const title = uniqueTitle(state.notes, wanted, id)
  if (title === note.title) return { state, title, rewritten: 0 }
  let rewritten = 0
  const now = Date.now()
  const notes = state.notes.map((n) => {
    if (n.id === id) return { ...n, title, updatedAt: now }
    const r = rewriteLinks(n.body, note.title, title)
    if (!r.count) return n
    rewritten += r.count
    return { ...n, body: r.body, updatedAt: now }
  })
  return { state: { ...state, notes }, title, rewritten }
}

export function stateRemove(state, id) {
  const at = state.openIds.indexOf(id)
  const openIds = state.openIds.filter((x) => x !== id)
  const activeId =
    state.activeId === id ? openIds[Math.min(Math.max(at, 0), openIds.length - 1)] ?? null : state.activeId
  return { notes: state.notes.filter((n) => n.id !== id), openIds, activeId }
}

export function stateOpen(state, id) {
  if (!state.notes.some((n) => n.id === id)) return state
  return {
    ...state,
    openIds: state.openIds.includes(id) ? state.openIds : [...state.openIds, id],
    activeId: id,
  }
}

export function stateClose(state, id) {
  const at = state.openIds.indexOf(id)
  if (at < 0) return state
  const openIds = state.openIds.filter((x) => x !== id)
  const activeId =
    state.activeId === id ? openIds[Math.min(at, openIds.length - 1)] ?? null : state.activeId
  return { ...state, openIds, activeId }
}

// ---- what a [[link]] points at ---------------------------------------------------------------
// ctx = {
//   scales:         every scale (built-in + custom) as { id, notes, name?, kind? }
//   scaleNameIndex: optional Map(lowercase name -> scale id) for built-in names
//   notesByTitle:   Map(titleKey -> note)
//   templates:      flat list of saved templates { id, name, ... }
// }
export function findScaleRef(ref, ctx) {
  const text = String(ref).trim()
  if (/^\d+$/.test(text)) return ctx.scales.find((s) => s.id === Number(text)) ?? null
  const key = titleKey(text)
  const custom = ctx.scales.find((s) => s.kind === 'custom' && titleKey(s.name) === key)
  if (custom) return custom
  const id = ctx.scaleNameIndex && ctx.scaleNameIndex.get(key)
  return id != null ? ctx.scales.find((s) => s.id === id) ?? null : null
}

export function resolveWiki(raw, ctx) {
  const c = classifyWiki(raw)
  if (c.kind === 'scale') {
    const scale = findScaleRef(c.ref, ctx)
    if (scale) return { kind: 'scale', scale, root: c.root ?? 0, modeStep: null, raw: c.raw }
  } else if (c.kind === 'chord') {
    if (c.rootPc != null && c.quality) {
      return { kind: 'chord', rootPc: c.rootPc, rootName: c.rootName, quality: c.quality, voicing: c.voicing, raw: c.raw }
    }
  } else if (c.kind === 'template') {
    const key = titleKey(c.name)
    const template = (ctx.templates || []).find((t) => titleKey(t.name) === key) ?? null
    return { kind: 'template', template, name: c.name, raw: c.raw }
  } else {
    const note = ctx.notesByTitle.get(titleKey(c.title)) ?? null
    return { kind: 'note', title: c.title, alias: c.alias, noteId: note ? note.id : null, raw: c.raw }
  }
  // a scale / chord that did not resolve: it is simply a note link to that text
  const note = ctx.notesByTitle.get(titleKey(c.raw)) ?? null
  return { kind: 'note', title: c.raw, alias: '', noteId: note ? note.id : null, raw: c.raw }
}

// {{C D E F# G A B}} -> { pcs, bad, matches } (matches: see recognizeScale)
export function resolveNoteList(raw, scales) {
  const { pcs, bad } = parseNoteList(raw)
  return { pcs, bad, matches: recognizeScale(pcs, scales) }
}

// ---- the link index ------------------------------------------------------------------------------
// For every note: what it links to. And the inverse: who links to a note, which
// notes talk about a scale, which notes carry a tag. This is also what a graph
// view will draw.
export function buildLinkIndex(notes, ctxIn) {
  const notesByTitle = new Map(notes.map((n) => [titleKey(n.title), n]))
  const ctx = { ...ctxIn, notesByTitle }
  const out = new Map() // noteId -> { notes:Set, ghosts:Set(title), scales:Set, chords:[], templates:Set(name), tags:[] }
  const backlinks = new Map()
  const scaleNotes = new Map()
  const tags = new Map()
  const push = (map, key, id) => {
    if (!map.has(key)) map.set(key, [])
    const list = map.get(key)
    if (!list.includes(id)) list.push(id)
  }
  for (const n of notes) {
    const o = { notes: new Set(), ghosts: new Set(), scales: new Set(), chords: [], templates: new Set(), tags: [] }
    walkInlines(parseBlocks(n.body), (node) => {
      if (node.t === 'tag') {
        const t = node.v.toLowerCase()
        if (!o.tags.includes(t)) o.tags.push(t)
      } else if (node.t === 'notes') {
        for (const m of resolveNoteList(node.raw, ctx.scales).matches) o.scales.add(m.scaleId)
      } else if (node.t === 'wiki') {
        const r = resolveWiki(node.raw, ctx)
        if (r.kind === 'note') {
          if (r.noteId) {
            if (r.noteId !== n.id) o.notes.add(r.noteId)
          } else if (r.title) o.ghosts.add(r.title)
        } else if (r.kind === 'scale') o.scales.add(r.scale.id)
        else if (r.kind === 'chord') o.chords.push(`${r.rootName} ${r.quality}`)
        else if (r.kind === 'template') o.templates.add(r.name)
      }
    })
    out.set(n.id, o)
    for (const t of o.notes) push(backlinks, t, n.id)
    for (const s of o.scales) push(scaleNotes, s, n.id)
    for (const t of o.tags) push(tags, t, n.id)
  }
  return { outgoing: out, backlinks, scaleNotes, tags, notesByTitle }
}

// The line of `body` that contains a link to `title`, for a backlink preview.
export function linkSnippet(body, title) {
  const re = new RegExp(`\\[\\[\\s*${escapeRe(title.trim())}\\s*(\\|[^\\]\\n]*)?\\]\\]`, 'i')
  const line = String(body).split('\n').find((l) => re.test(l))
  if (!line) return ''
  const t = line.trim()
  return t.length > 140 ? t.slice(0, 137) + '…' : t
}

// First meaningful line of a body, for the note list.
export function bodyPreview(body) {
  const line = String(body)
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l && !l.startsWith('```'))
  if (!line) return ''
  return line.length > 90 ? line.slice(0, 87) + '…' : line
}
