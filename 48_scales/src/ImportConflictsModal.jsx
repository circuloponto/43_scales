import { useState } from 'react'

// Shown when an import contains templates that clash with the existing library.
// Each conflicting incoming template is either a CONTENT duplicate (identical
// notes to one already present) or a NAME clash (same name, different notes).
// The user resolves each one — skip it, import a duplicate anyway, or rename a
// clash — before anything is written. Templates with no conflict aren't listed;
// they just import. `items` is the classified list:
//   { node, status: 'content-dup' | 'name-clash' | 'new', matchName }
export default function ImportConflictsModal({ items, onConfirm, onCancel }) {
  const conflicts = items.filter((i) => i.status !== 'new')
  const newCount = items.length - conflicts.length

  // Sensible defaults: true duplicates are skipped, name clashes are renamed.
  const [choices, setChoices] = useState(() =>
    items.map((i) =>
      i.status === 'content-dup'
        ? 'skip'
        : i.status === 'name-clash'
        ? 'rename'
        : 'import'
    )
  )
  const set = (idx, val) =>
    setChoices((c) => c.map((x, i) => (i === idx ? val : x)))
  const setAll = (predicate, val) =>
    setChoices((c) => c.map((x, i) => (predicate(items[i]) ? val : x)))

  const importCount = choices.filter((c) => c !== 'skip').length
  const confirm = () =>
    onConfirm(items.map((it, i) => ({ ...it, choice: choices[i] })))

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal import-conflicts-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-header">
          <h3 className="import-conflicts-title">
            Import — {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}
          </h3>
          <button
            type="button"
            className="finder-modal-close"
            onClick={onCancel}
            aria-label="cancel import"
          >
            ×
          </button>
        </div>

        <p className="import-conflicts-sub">
          {newCount > 0 && (
            <>
              <strong>{newCount}</strong> new item{newCount === 1 ? '' : 's'} will
              import.{' '}
            </>
          )}
          Choose what to do with the {conflicts.length} below.
        </p>

        <div className="import-conflicts-bulk">
          <button
            type="button"
            onClick={() => setAll((i) => i.status !== 'new', 'skip')}
          >
            Skip all
          </button>
          <button
            type="button"
            onClick={() => setAll((i) => i.status === 'content-dup', 'import')}
          >
            Keep all duplicates
          </button>
          <button
            type="button"
            onClick={() => setAll((i) => i.status === 'name-clash', 'rename')}
          >
            Rename all clashes
          </button>
        </div>

        <div className="import-conflicts-list">
          {items.map((it, i) =>
            it.status === 'new' ? null : (
              <div className="import-conflict-row" key={i}>
                <div className="import-conflict-info">
                  <span className="import-conflict-name">
                    {it.kind === 'folder' && (
                      <span className="import-conflict-kind">Folder</span>
                    )}
                    <span className="import-conflict-label">
                      {it.node.name ||
                        (it.kind === 'folder' ? 'Folder' : 'Template')}
                    </span>
                    {it.kind === 'folder' && (
                      <span className="import-conflict-count">
                        {it.childCount} template{it.childCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  <span className="import-conflict-msg">
                    {it.kind === 'folder'
                      ? it.status === 'content-dup'
                        ? `Identical folder “${it.matchName}” already exists`
                        : `Folder “${it.matchName}” already exists (different contents)`
                      : it.status === 'content-dup'
                      ? `Identical to existing “${it.matchName}”`
                      : `Name “${it.matchName}” already exists`}
                  </span>
                </div>
                <div className="import-conflict-choices">
                  {it.status === 'content-dup' ? (
                    <>
                      {/* An identical folder duplicate is skipped by default —
                          that's the resting state, so Skip is shown disabled and
                          the only action is opting into a copy via Import anyway
                          (which toggles back to skip). Duplicate templates keep
                          both choices enabled. */}
                      <button
                        type="button"
                        className={
                          choices[i] === 'skip' && it.kind !== 'folder'
                            ? 'active'
                            : ''
                        }
                        disabled={it.kind === 'folder'}
                        onClick={() => set(i, 'skip')}
                        title={
                          it.kind === 'folder'
                            ? 'An identical folder already exists — skipped by default'
                            : undefined
                        }
                      >
                        Skip
                      </button>
                      <button
                        type="button"
                        className={choices[i] === 'import' ? 'active' : ''}
                        onClick={() =>
                          set(
                            i,
                            it.kind === 'folder' && choices[i] === 'import'
                              ? 'skip'
                              : 'import'
                          )
                        }
                      >
                        Import anyway
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={choices[i] === 'rename' ? 'active' : ''}
                        onClick={() => set(i, 'rename')}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className={choices[i] === 'skip' ? 'active' : ''}
                        onClick={() => set(i, 'skip')}
                      >
                        Skip
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          )}
        </div>

        <div className="import-conflicts-actions">
          <button type="button" className="import-conflicts-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="import-conflicts-go"
            onClick={confirm}
            disabled={importCount === 0}
          >
            Import {importCount}
          </button>
        </div>
      </div>
    </div>
  )
}
