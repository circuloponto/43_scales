import { useEffect, useMemo, useState } from 'react'
import { NotebookPen, Plus, Search, X } from 'lucide-react'
import NoteEditor from './NoteEditor'
import { bodyPreview } from './notes'

// The Notes screen: a note list on the left, the open notes as tabs across the
// top, and the editor below them. All state lives in the notes store (App).
export default function NotesView({
  store,
  scales,
  customScales,
  scaleNameOf,
  scaleNameIndex,
  templates,
  useFlats,
  noteNames,
  onClose,
  onOpenScale,
}) {
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState(null)

  // Esc closes the window, unless Esc was meant for something inside it: a
  // popover (scale / chord / diagram / link picker) or the [[ suggestions.
  // Those are still on screen while this runs, so their presence is the signal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.scale-picker, .note-popover, .note-suggest')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tagList = useMemo(
    () =>
      [...store.linkIndex.tags.entries()]
        .map(([tag, ids]) => ({ tag, count: ids.length }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    [store.linkIndex.tags]
  )

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const withTag = activeTag ? new Set(store.linkIndex.tags.get(activeTag) ?? []) : null
    return store.notes
      .filter((n) => !withTag || withTag.has(n.id))
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [store.notes, store.linkIndex.tags, activeTag, q])

  const byId = useMemo(() => new Map(store.notes.map((n) => [n.id, n])), [store.notes])
  const active = store.activeId ? byId.get(store.activeId) : null
  const tabs = store.openIds.map((id) => byId.get(id)).filter(Boolean)

  // What the renderer needs to turn links into chips / ghost links / tags.
  const ctx = useMemo(
    () => ({
      scales,
      scaleNameIndex,
      templates,
      notesByTitle: store.linkIndex.notesByTitle,
      useFlats,
      onOpenNote: (title) => store.openByTitle(title, { create: true }),
      onOpenScale,
      onTag: (tag) => setActiveTag(tag),
    }),
    // store.openByTitle is stable (see useNotes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scales, scaleNameIndex, templates, store.linkIndex.notesByTitle, useFlats, onOpenScale]
  )

  const modeOf = (n) => store.modes[n.id] ?? (n.body.trim() ? 'preview' : 'edit')

  return (
    <div className="notes-view">
      <div className="notes-header">
        <h2>
          <NotebookPen size={17} /> Notes
        </h2>
        <button type="button" className="notes-new" onClick={() => store.create({})}>
          <Plus size={14} /> New note
        </button>
        <button type="button" className="notes-close" aria-label="Close notes" title="Close (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="notes-body">
        <aside className="notes-sidebar">
          <label className="notes-search">
            <Search size={13} />
            <input
              value={query}
              placeholder="Search notes…"
              aria-label="Search notes"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {tagList.length > 0 && (
            <div className="notes-tags">
              {tagList.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  className={`note-tag ${activeTag === tag ? 'on' : ''}`}
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  title={`${count} note${count === 1 ? '' : 's'}`}
                >
                  #{tag}
                </button>
              ))}
              {activeTag && (
                <button type="button" className="notes-tags-clear" onClick={() => setActiveTag(null)}>
                  clear filter
                </button>
              )}
            </div>
          )}
          <ul className="notes-list">
            {shown.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`notes-item ${n.id === store.activeId ? 'on' : ''}`}
                  onClick={() => store.open(n.id)}
                >
                  <b>{n.title}</b>
                  <span>{bodyPreview(n.body)}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="notes-empty-list">
                {store.notes.length === 0 ? 'No notes yet.' : 'No notes match.'}
              </li>
            )}
          </ul>
        </aside>

        <section className="notes-main">
          <div className="notes-tabs" role="tablist">
            {tabs.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === store.activeId}
                className={`notes-tab ${t.id === store.activeId ? 'on' : ''}`}
                onClick={() => store.activate(t.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) store.close(t.id)
                }}
              >
                <span className="notes-tab-title">{t.title}</span>
                <button
                  type="button"
                  className="notes-tab-close"
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    store.close(t.id)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="notes-tab-add" aria-label="New note" onClick={() => store.create({})}>
              <Plus size={14} />
            </button>
          </div>

          {active ? (
            <NoteEditor
              key={active.id}
              note={active}
              mode={modeOf(active)}
              setMode={(m) => store.setMode(active.id, m)}
              store={store}
              ctx={ctx}
              customScales={customScales}
              scaleNameOf={scaleNameOf}
              noteNames={noteNames}
              useFlats={useFlats}
              onFilterTag={setActiveTag}
            />
          ) : (
            <div className="notes-empty">
              <NotebookPen size={30} />
              <p>Open a note from the list, or start a new one.</p>
              <button type="button" className="notes-new" onClick={() => store.create({})}>
                <Plus size={14} /> New note
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
