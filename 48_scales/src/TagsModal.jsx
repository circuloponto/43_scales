import { useEffect, useRef, useState } from 'react'
import { Search, Plus, Minus, Copy, Pencil } from 'lucide-react'

// Tag library manager. The "Tags" section is a working set assembled from the
// library (click a tag's green + to add it here); it can be copied as text. The
// search filters the tag LIST below (not template names). [+] adds a tag to the
// Tags section; [−] deletes it from the library (and from every template).
export default function TagsModal({
  allTags,
  workingTags,
  setWorkingTags,
  onNewTag,
  onDeleteTag,
  onRenameTag,
  onClose,
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const newRef = useRef(null)

  const inWorking = (t) =>
    workingTags.some((x) => x.toLowerCase() === t.toLowerCase())
  const addToWorking = (t) =>
    setWorkingTags((prev) => (inWorking(t) ? prev : [...prev, t]))
  const removeFromWorking = (t) =>
    setWorkingTags((prev) => prev.filter((x) => x.toLowerCase() !== t.toLowerCase()))

  // The search filters the tag list only.
  const shown = allTags.filter((t) =>
    t.toLowerCase().includes(query.trim().toLowerCase())
  )

  const createTag = () => {
    const t = newRef.current?.value.trim()
    if (!t) return
    onNewTag(t)
    addToWorking(t)
    newRef.current.value = ''
    newRef.current.focus()
  }

  const copyText = async () => {
    const text = workingTags.join(', ')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {}
      document.body.removeChild(ta)
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal tags-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tags-modal-actions">
          <div className="tags-modal-new">
            <input
              ref={newRef}
              className="tags-new-input"
              placeholder="New tag…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') createTag()
              }}
            />
            <button type="button" className="tags-new-btn" onClick={createTag} title="Create tag">
              <Plus size={14} />
            </button>
          </div>
          <button
            type="button"
            className="tags-action"
            onClick={copyText}
            disabled={!workingTags.length}
            title="Copy the Tags set as text"
          >
            <Copy size={13} /> Copy
          </button>
          <button
            type="button"
            className={`tags-action ${editing ? 'on' : ''}`}
            onClick={() => setEditing((v) => !v)}
            title="Rename tags"
          >
            <Pencil size={13} /> Edit
          </button>
          <button
            type="button"
            className="finder-modal-close"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </div>

        <div className="tags-section">
          <div className="tags-section-title">Tags</div>
          <div className="tags-working">
            {workingTags.length === 0 ? (
              <span className="tags-working-empty">
                Click a tag’s + below to add it here.
              </span>
            ) : (
              workingTags.map((t) => (
                <span key={t} className="tag-chip working">
                  {t}
                  <button
                    type="button"
                    className="tag-chip-x"
                    onClick={() => removeFromWorking(t)}
                    aria-label={`Remove ${t} from set`}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        <div className="tags-divider" />

        <div className="tags-modal-search">
          <Search size={13} />
          <input
            className="tags-search-input"
            placeholder="Search tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <ul className="tags-list">
          {shown.length === 0 && (
            <li className="tags-empty">No tags{query ? ' match' : ' yet'}.</li>
          )}
          {shown.map((t) => (
            <li key={t} className="tags-row">
              <button
                type="button"
                className="tag-del"
                onClick={() => onDeleteTag(t)}
                title="Delete tag from library (removes it from all templates)"
                aria-label={`Delete tag ${t}`}
              >
                <Minus size={12} />
              </button>
              {editing ? (
                <input
                  className="tag-rename-input"
                  defaultValue={t}
                  onBlur={(e) => onRenameTag(t, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    else if (e.key === 'Escape') {
                      e.currentTarget.value = t
                      e.currentTarget.blur()
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={`tag-name ${inWorking(t) ? 'active' : ''}`}
                  onClick={() =>
                    inWorking(t) ? removeFromWorking(t) : addToWorking(t)
                  }
                  title="Add to / remove from the Tags set"
                >
                  {t}
                </button>
              )}
              <button
                type="button"
                className="tag-add"
                onClick={() => addToWorking(t)}
                disabled={inWorking(t)}
                title="Add tag to the Tags set"
                aria-label={`Add tag ${t} to set`}
              >
                <Plus size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
