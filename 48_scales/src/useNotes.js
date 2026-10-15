import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildLinkIndex,
  loadNotesState,
  makeNoteId,
  sanitizeState,
  saveNotesState,
  stateAddNote,
  stateClose,
  stateOpen,
  stateRemove,
  stateRename,
  stateUpdateBody,
  titleKey,
} from './notes'

// The notes store: state + persistence + actions + the link index. Lives in App
// so notes survive switching views and are available on the scale panel.
//   scales          every scale (built-in + custom), to resolve [[scale ...]]
//   scaleNameIndex  Map(lowercase name -> built-in scale id)
//   templates       flat list of saved templates, to resolve [[template ...]]
export function useNotes({ scales, scaleNameIndex, templates }) {
  const [state, setState] = useState(loadNotesState)
  // 'edit' | 'preview' per note, kept while the app is open (not saved). A note
  // with no entry opens in Edit while empty and in Preview otherwise.
  const [modes, setModes] = useState({})
  // A ref mirrors the state so actions can read the latest value and return
  // a result (a new id, how many links a rename rewrote) synchronously. Every
  // change goes through `apply`, which keeps the ref and the state in step.
  const ref = useRef(state)

  // Typing writes the body on every key: save shortly after the last change,
  // and always on the way out.
  useEffect(() => {
    const t = setTimeout(() => saveNotesState(state), 250)
    return () => clearTimeout(t)
  }, [state])
  useEffect(() => {
    const flush = () => saveNotesState(ref.current)
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const apply = useCallback((fn) => {
    const next = fn(ref.current)
    ref.current = next
    setState(next)
    return next
  }, [])

  const linkIndex = useMemo(
    () => buildLinkIndex(state.notes, { scales, scaleNameIndex, templates }),
    [state.notes, scales, scaleNameIndex, templates]
  )

  const actions = useMemo(
    () => ({
      create: ({ title, body } = {}) => {
        const id = makeNoteId()
        apply((s) => stateAddNote(s, { id, title, body }))
        setModes((m) => ({ ...m, [id]: 'edit' })) // a new note opens ready to type in
        return id
      },
      updateBody: (id, body) => apply((s) => stateUpdateBody(s, id, body)),
      rename: (id, wanted) => {
        const r = stateRename(ref.current, id, wanted)
        if (r.state !== ref.current) apply(() => r.state)
        return { title: r.title, rewritten: r.rewritten }
      },
      remove: (id) => apply((s) => stateRemove(s, id)),
      open: (id) => apply((s) => stateOpen(s, id)),
      close: (id) => apply((s) => stateClose(s, id)),
      activate: (id) =>
        apply((s) => (s.openIds.includes(id) ? { ...s, activeId: id } : s)),
      // Open the note with this title in a tab; create it when asked to.
      openByTitle: (title, { create = false } = {}) => {
        const note = ref.current.notes.find((n) => titleKey(n.title) === titleKey(title))
        if (note) {
          apply((s) => stateOpen(s, note.id))
          return note.id
        }
        if (!create) return null
        const id = makeNoteId()
        apply((s) => stateAddNote(s, { id, title, body: '' }))
        setModes((m) => ({ ...m, [id]: 'edit' }))
        return id
      },
      setMode: (id, mode) => setModes((m) => ({ ...m, [id]: mode })),
      exportState: () => ref.current,
      importState: (raw) => apply(() => sanitizeState(raw)),
    }),
    [apply]
  )

  return { ...state, linkIndex, modes, ...actions }
}
