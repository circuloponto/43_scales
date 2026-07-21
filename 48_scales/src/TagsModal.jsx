import { useEffect, useRef, useState } from 'react'
import { Search, Plus, Minus, Copy, Check, Pencil, Trash2 } from 'lucide-react'

// Tag library manager + filter builder. The red [−] and green [+] buttons on a
// tag build a FILTER — red excludes that tag, green includes it — they don't
// touch the library. "Apply as filters" commits the selection to the template
// list. Edit mode swaps the list rows for a rename field + trash can: the only
// library mutations are renaming (case-sensitive) and deleting. Creating a tag
// with [+] adds it to the list below only; it doesn't join the filter.
export default function TagsModal({
  allTags,
  tagFilter,
  setTagFilter,
  onApply,
  onClearFilter,
  filtering,
  onNewTag,
  onDeleteTag,
  onRenameTag,
  onClose,
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const newRef = useRef(null)

  const { include, exclude } = tagFilter
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase()
  const has = (arr, t) => arr.some((x) => eq(x, t))
  const without = (arr, t) => arr.filter((x) => !eq(x, t))
  const isIncluded = (t) => has(include, t)
  const isExcluded = (t) => has(exclude, t)

  // Green and red are mutually exclusive per tag, and each toggles itself off.
  const toggleInclude = (t) =>
    setTagFilter((f) => ({
      include: isIncluded(t) ? without(f.include, t) : [...without(f.include, t), t],
      exclude: without(f.exclude, t),
    }))
  const toggleExclude = (t) =>
    setTagFilter((f) => ({
      include: without(f.include, t),
      exclude: isExcluded(t) ? without(f.exclude, t) : [...without(f.exclude, t), t],
    }))
  const dropFromFilter = (t) =>
    setTagFilter((f) => ({
      include: without(f.include, t),
      exclude: without(f.exclude, t),
    }))

  const filterCount = include.length + exclude.length

  // The search filters the tag list only.
  const shown = allTags.filter((t) =>
    t.toLowerCase().includes(query.trim().toLowerCase())
  )

  const createTag = () => {
    const t = newRef.current?.value.trim()
    if (!t) return
    onNewTag(t)
    newRef.current.value = ''
    newRef.current.focus()
  }

  // Copy confirms itself for a beat — the button swaps to a check + "Copied"
  // so the click clearly landed.
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(null)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const copyText = async () => {
    const text = include.join(', ')
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
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1400)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // The veil and the modal are separate layers so the templates panel can sit
    // BETWEEN them (see `.variation-panel.above-veil`): everything else dims and
    // blurs, the template list stays sharp, and you can watch it filter live.
    <>
      <div className="tags-veil" onMouseDown={onClose} />
      <div className="tags-modal-layer">
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
            <button
              type="button"
              className="tags-new-btn"
              onClick={createTag}
              title="Create tag (adds it to the list below)"
            >
              <Plus size={14} />
            </button>
          </div>
          <button
            type="button"
            className={`tags-action ${copied ? 'copied' : ''}`}
            onClick={copyText}
            disabled={!include.length}
            title="Copy the included tags as text"
          >
            {copied ? (
              <>
                <Check size={13} /> Copied
              </>
            ) : (
              <>
                <Copy size={13} /> Copy
              </>
            )}
          </button>
          <button
            type="button"
            className={`tags-action ${editing ? 'on' : ''}`}
            onClick={() => setEditing((v) => !v)}
            title="Rename or delete tags"
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
          <div className="tags-section-title">Filter</div>
          <div className="tags-working">
            {filterCount === 0 ? (
              <span className="tags-working-empty">
                Use a tag’s + to include it, − to exclude it.
              </span>
            ) : (
              <>
                {include.map((t) => (
                  <span key={`i-${t}`} className="tag-chip include">
                    {t}
                    <button
                      type="button"
                      className="tag-chip-x"
                      onClick={() => dropFromFilter(t)}
                      aria-label={`Remove ${t} from filter`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {exclude.map((t) => (
                  <span key={`e-${t}`} className="tag-chip exclude">
                    {t}
                    <button
                      type="button"
                      className="tag-chip-x"
                      onClick={() => dropFromFilter(t)}
                      aria-label={`Remove ${t} from filter`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
          <div className="tags-apply-row">
            <button
              type="button"
              className="tags-apply"
              onClick={onApply}
              disabled={filterCount === 0}
            >
              Apply as filters
            </button>
            {filtering && (
              <button
                type="button"
                className="tags-clear-filter"
                onClick={onClearFilter}
              >
                Clear filter
              </button>
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

        <ul className={`tags-list ${editing ? 'editing' : ''}`}>
          {shown.length === 0 && (
            <li className="tags-empty">No tags{query ? ' match' : ' yet'}.</li>
          )}
          {shown.map((t) =>
            editing ? (
              // Edit mode: rename field + trash can only — no filter buttons.
              <li key={t} className="tags-row">
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
                <button
                  type="button"
                  className="tag-trash"
                  onClick={() => onDeleteTag(t)}
                  title="Delete tag (removes it from all templates)"
                  aria-label={`Delete tag ${t}`}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ) : (
              <li key={t} className="tags-row">
                <button
                  type="button"
                  className={`tag-del ${isExcluded(t) ? 'active' : ''}`}
                  onClick={() => toggleExclude(t)}
                  title="Exclude this tag from the filter"
                  aria-label={`Exclude tag ${t}`}
                >
                  <Minus size={12} />
                </button>
                <button
                  type="button"
                  className={`tag-name ${
                    isIncluded(t) ? 'included' : isExcluded(t) ? 'excluded' : ''
                  }`}
                  onClick={() => toggleInclude(t)}
                  title="Include this tag in the filter"
                >
                  {t}
                </button>
                <button
                  type="button"
                  className={`tag-add ${isIncluded(t) ? 'active' : ''}`}
                  onClick={() => toggleInclude(t)}
                  title="Include this tag in the filter"
                  aria-label={`Include tag ${t}`}
                >
                  <Plus size={12} />
                </button>
                </li>
              )
            )}
          </ul>
        </div>
      </div>
    </>
  )
}
