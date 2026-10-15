import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Pencil, Trash2 } from 'lucide-react'
import NoteRender from './NoteRender'
import ChordCard from './ChordCard'
import ScalePicker from './ScalePicker'
import { scales as builtInScales } from './scales'
import { makeScaleContext } from './scaleContext'
import { pcName } from './chordVocab'
import { CHORD_QUALITY_CHOICES } from './noteParse'
import { linkSnippet, titleKey } from './notes'

const pad = (id) => String(id).padStart(2, '0')

// One open note: title, Edit / Preview, an Insert toolbar (scale, chord, note
// link), [[ autocomplete while typing, and the note's links and backlinks.
export default function NoteEditor({
  note,
  mode,
  setMode,
  store,
  ctx,
  customScales,
  scaleNameOf,
  noteNames,
  useFlats,
  onFilterTag,
}) {
  const taRef = useRef(null)
  // Remounted per note (see key in NotesView), so this starts as the note's title.
  const [draft, setDraft] = useState(note.title)
  const [flash, setFlash] = useState('')
  const [suggest, setSuggest] = useState(null) // { start, items, active }
  const [popover, setPopover] = useState(null) // { kind: 'scale'|'chord'|'link', x, y }

  const say = (msg) => {
    setFlash(msg)
    setTimeout(() => setFlash(''), 3500)
  }

  const commitTitle = () => {
    if (draft.trim() === note.title) {
      setDraft(note.title)
      return
    }
    const r = store.rename(note.id, draft)
    setDraft(r.title)
    if (r.rewritten) say(`Renamed. Updated ${r.rewritten} link${r.rewritten === 1 ? '' : 's'} in other notes.`)
  }

  // ---- inserting text at the cursor ---------------------------------------------------
  const insertText = (text) => {
    const ta = taRef.current
    const body = note.body
    if (!ta) {
      // in Preview: add on a new line at the end, then show the editor
      store.updateBody(note.id, body + (body && !body.endsWith('\n') ? '\n' : '') + text)
      setMode('edit')
      return
    }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    store.updateBody(note.id, body.slice(0, start) + text + body.slice(end))
    requestAnimationFrame(() => {
      const t = taRef.current
      if (!t) return
      t.focus()
      t.setSelectionRange(start + text.length, start + text.length)
    })
  }

  // ---- [[ autocomplete ----------------------------------------------------------------------
  const updateSuggest = (el) => {
    const pos = el.selectionStart
    const m = /\[\[([^[\]\n|]*)$/.exec(el.value.slice(0, pos))
    if (!m) {
      setSuggest(null)
      return
    }
    const query = m[1]
    const q = query.toLowerCase()
    const items = store.notes
      .filter((n) => n.id !== note.id && n.title.toLowerCase().includes(q))
      .slice(0, 6)
      .map((n) => ({ label: n.title, insert: n.title }))
    if (query.trim() && !store.notes.some((n) => titleKey(n.title) === titleKey(query))) {
      items.push({ label: `Create link “${query.trim()}”`, insert: query.trim() })
    }
    setSuggest(items.length ? { start: pos - m[0].length, items, active: 0 } : null)
  }
  const acceptSuggest = (item) => {
    const ta = taRef.current
    if (!ta || !suggest) return
    const pos = ta.selectionStart
    const body = note.body
    const closed = body.slice(pos).startsWith(']]')
    const text = `[[${item.insert}${closed ? '' : ']]'}`
    store.updateBody(note.id, body.slice(0, suggest.start) + text + body.slice(pos + (closed ? 2 : 0)))
    setSuggest(null)
    const caret = suggest.start + text.length + (closed ? 2 : 0)
    requestAnimationFrame(() => {
      const t = taRef.current
      if (!t) return
      t.focus()
      t.setSelectionRange(caret, caret)
    })
  }
  const onKeyDown = (e) => {
    if (!suggest) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = suggest.items.length
      setSuggest({ ...suggest, active: (suggest.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      acceptSuggest(suggest.items[suggest.active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setSuggest(null)
    }
  }

  // ---- toolbar popovers --------------------------------------------------------------------
  const open = (kind) => (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setPopover((p) => (p && p.kind === kind ? null : { kind, x: r.left, y: r.bottom + 6 }))
  }

  const index = store.linkIndex
  const outgoing = index.outgoing.get(note.id)
  const backlinks = (index.backlinks.get(note.id) ?? [])
    .map((id) => store.notes.find((n) => n.id === id))
    .filter(Boolean)
  const byId = useMemo(() => new Map(store.notes.map((n) => [n.id, n])), [store.notes])

  return (
    <div className="note-editor">
      <div className="note-editor-head">
        <input
          className="note-title-input"
          value={draft}
          placeholder="Title"
          aria-label="Note title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <div className="note-mode-toggle" role="group" aria-label="Edit or preview">
          <button type="button" className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
            <Pencil size={13} /> Edit
          </button>
          <button type="button" className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
            <Eye size={13} /> Preview
          </button>
        </div>
        <button
          type="button"
          className="note-delete"
          title="Delete this note"
          aria-label="Delete note"
          onClick={() => {
            if (window.confirm(`Delete “${note.title}”? This cannot be undone.`)) store.remove(note.id)
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="note-toolbar">
        <span className="note-toolbar-label">Insert</span>
        <button type="button" className={popover?.kind === 'scale' ? 'on' : ''} onClick={open('scale')}>
          Scale
        </button>
        <button type="button" className={popover?.kind === 'chord' ? 'on' : ''} onClick={open('chord')}>
          Chord
        </button>
        <button type="button" className={popover?.kind === 'link' ? 'on' : ''} onClick={open('link')}>
          Note link
        </button>
        {flash && <span className="note-flash">{flash}</span>}
        <span className="note-toolbar-hint">
          [[note]] · [[scale 7 on D]] · [[chord D Min 7]] · {'{{C D E F# G A B}}'} · #tag
        </span>
      </div>

      <div className="note-content">
        {mode === 'edit' ? (
          <div className="note-edit-wrap">
            <textarea
              ref={taRef}
              className="note-textarea"
              value={note.body}
              spellCheck={false}
              placeholder={'Write in Markdown.\n\nLink a note with [[Title]], a scale with [[scale 7 on D]], a chord with [[chord D Min 7]], name notes with {{D E F G A Bb C}}, tag with #idea.'}
              onChange={(e) => {
                store.updateBody(note.id, e.target.value)
                updateSuggest(e.target)
              }}
              onKeyDown={onKeyDown}
              onClick={(e) => updateSuggest(e.currentTarget)}
              onBlur={() => setTimeout(() => setSuggest(null), 120)}
              autoFocus={!note.body}
            />
            {suggest && (
              <ul className="note-suggest" role="listbox">
                {suggest.items.map((it, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === suggest.active}
                      className={i === suggest.active ? 'on' : ''}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        acceptSuggest(it)
                      }}
                    >
                      {it.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="note-preview-wrap">
            <NoteRender body={note.body} ctx={ctx} />
          </div>
        )}
      </div>

      <div className="note-links">
        <div className="note-links-col">
          <div className="note-links-title">Linked mentions · {backlinks.length}</div>
          {backlinks.length === 0 && <div className="note-links-empty">No note links here yet.</div>}
          {backlinks.map((b) => (
            <button key={b.id} type="button" className="note-backlink" onClick={() => store.open(b.id)}>
              <b>{b.title}</b>
              <span>{linkSnippet(b.body, note.title)}</span>
            </button>
          ))}
        </div>
        <div className="note-links-col">
          <div className="note-links-title">This note links to</div>
          {outgoing &&
            outgoing.notes.size + outgoing.ghosts.size + outgoing.scales.size + outgoing.chords.length + outgoing.templates.size === 0 && (
              <div className="note-links-empty">Nothing yet.</div>
            )}
          <div className="note-links-chips">
            {outgoing &&
              [...outgoing.notes].map((id) => (
                <button key={id} type="button" className="note-chip note" onClick={() => store.open(id)}>
                  {byId.get(id)?.title}
                </button>
              ))}
            {outgoing &&
              [...outgoing.ghosts].map((t) => (
                <button key={t} type="button" className="note-chip muted" title="Does not exist yet: click to create" onClick={() => store.openByTitle(t, { create: true })}>
                  {t} +
                </button>
              ))}
            {outgoing &&
              [...outgoing.scales].map((id) => {
                const s = ctx.scales.find((x) => x.id === id)
                return (
                  <button key={String(id)} type="button" className="note-chip scale" onClick={() => ctx.onOpenScale({ scaleId: id, root: 0, modeStep: null })}>
                    {s ? (s.kind === 'custom' ? `★ ${s.name}` : `scale ${pad(s.id)}`) : String(id)} ↗
                  </button>
                )
              })}
            {outgoing && outgoing.chords.map((c) => <span key={c} className="note-chip muted">chord {c}</span>)}
            {outgoing && [...outgoing.templates].map((t) => <span key={t} className="note-chip muted">template {t}</span>)}
          </div>
          {outgoing && outgoing.tags.length > 0 && (
            <div className="note-links-chips tags">
              {outgoing.tags.map((t) => (
                <button key={t} type="button" className="note-tag" onClick={() => onFilterTag(t)}>
                  #{t}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {popover?.kind === 'scale' && (
        <ScaleInsert
          x={popover.x}
          y={popover.y}
          customScales={customScales}
          scaleNameOf={scaleNameOf}
          noteNames={noteNames}
          useFlats={useFlats}
          onInsert={(text) => {
            insertText(text)
            setPopover(null)
          }}
          onClose={() => setPopover(null)}
        />
      )}
      {popover?.kind === 'chord' && (
        <ChordInsert
          x={popover.x}
          y={popover.y}
          noteNames={noteNames}
          useFlats={useFlats}
          onInsert={(text) => {
            insertText(text)
            setPopover(null)
          }}
          onClose={() => setPopover(null)}
        />
      )}
      {popover?.kind === 'link' && (
        <LinkInsert
          x={popover.x}
          y={popover.y}
          notes={store.notes.filter((n) => n.id !== note.id)}
          onInsert={(title) => {
            insertText(`[[${title}]]`)
            setPopover(null)
          }}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

// ---- insert popovers --------------------------------------------------------------------------

// Pick a scale (+ root, + optional mode) and insert it. A plain pick becomes
// [[scale 7 on D]]; a mode pick becomes the list of its notes, {{D E F ...}},
// which the app then recognises as that mode.
function ScaleInsert({ x, y, customScales, scaleNameOf, noteNames, useFlats, onInsert, onClose }) {
  const [pick, setPick] = useState({ scaleId: builtInScales[0].id, root: 0, modeStep: null })
  const raw = builtInScales.find((s) => s.id === pick.scaleId) ?? customScales.find((s) => s.id === pick.scaleId)
  const insert = () => {
    if (!raw) return
    if (pick.modeStep != null) {
      const c = makeScaleContext(raw, pick.root, pick.modeStep)
      onInsert(`{{${c.scale.notes.map((n) => pcName((n + c.root) % 12, useFlats)).join(' ')}}}`)
    } else {
      const ref = raw.kind === 'custom' ? raw.name : raw.id
      onInsert(`[[scale ${ref} on ${pcName(pick.root, useFlats)}]]`)
    }
  }
  return (
    <ScalePicker
      x={x}
      y={y}
      zone={pick}
      builtIn={builtInScales}
      custom={customScales}
      nameOf={scaleNameOf}
      noteNames={noteNames}
      onChange={(patch) => setPick((p) => ({ ...p, ...patch }))}
      onClose={onClose}
      confirmLabel="Insert scale"
      onConfirm={insert}
    />
  )
}

function ChordInsert({ x, y, noteNames, useFlats, onInsert, onClose }) {
  const ref = useRef(null)
  const [rootPc, setRootPc] = useState(2)
  const [quality, setQuality] = useState('Min 7')
  const [voicing, setVoicing] = useState(0)
  useEffect(() => {
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const key = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <div className="note-popover chord-insert" ref={ref} style={{ left: Math.max(8, Math.min(x, window.innerWidth - 380)), top: y }}>
      <div className="scale-picker-title">Insert a chord diagram</div>
      <div className="scale-picker-roots" role="radiogroup" aria-label="Chord root">
        {noteNames.map((n, pc) => (
          <button key={pc} type="button" role="radio" aria-checked={rootPc === pc} className={rootPc === pc ? 'on' : ''} onClick={() => setRootPc(pc)}>
            {n}
          </button>
        ))}
      </div>
      <select className="note-select" value={quality} onChange={(e) => setQuality(e.target.value)} aria-label="Chord quality">
        {CHORD_QUALITY_CHOICES.map((q) => (
          <option key={q} value={q}>
            {q}
          </option>
        ))}
      </select>
      <ChordCard key={`${rootPc}-${quality}`} rootPc={rootPc} quality={quality} useFlats={useFlats} onVoicing={setVoicing} />
      <button
        type="button"
        className="scale-picker-confirm"
        onClick={() => onInsert(`[[chord ${pcName(rootPc, useFlats)} ${quality}${voicing > 0 ? ` #${voicing + 1}` : ''}]]`)}
      >
        Insert chord
      </button>
    </div>
  )
}

function LinkInsert({ x, y, notes, onInsert, onClose }) {
  const ref = useRef(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const key = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  const query = q.trim()
  const shown = notes.filter((n) => n.title.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
  const exists = notes.some((n) => titleKey(n.title) === titleKey(query))
  return (
    <div className="note-popover link-insert" ref={ref} style={{ left: Math.max(8, Math.min(x, window.innerWidth - 300)), top: y }}>
      <input
        className="scale-picker-search"
        value={q}
        autoFocus
        placeholder="Link to a note…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query) onInsert(shown[0] && !exists ? shown[0].title : query)
        }}
      />
      <div className="scale-picker-list">
        {shown.map((n) => (
          <button key={n.id} type="button" className="scale-picker-row" onClick={() => onInsert(n.title)}>
            <span className="scale-picker-name">{n.title}</span>
          </button>
        ))}
        {query && !exists && (
          <button type="button" className="scale-picker-row" onClick={() => onInsert(query)}>
            <span className="scale-picker-name">Create link “{query}”</span>
          </button>
        )}
        {!query && shown.length === 0 && <div className="scale-picker-empty">No other notes yet. Type a title to link to a new one.</div>}
      </div>
    </div>
  )
}
