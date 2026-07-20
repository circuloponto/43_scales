import { useSyncExternalStore } from 'react'

// ── Editable hotkeys ────────────────────────────────────────────────────────
// A single source of truth for the discrete action shortcuts. Handlers ask
// `isHotkey('play', e)`; the editor rebinds via `setBinding`. A binding is a
// "signature" string built from e.code + modifiers (layout-independent), e.g.
// 'Space', 'Mod+KeyZ' (Mod = Ctrl OR Cmd), 'Shift+KeyH', 'BracketRight'.

const STORAGE_KEY = 'eightFold.hotkeys'

export const HOTKEY_ACTIONS = [
  { id: 'play', label: 'Play / pause', section: 'Playback', default: 'Space' },
  { id: 'returnPlayhead', label: 'Return playhead to start', section: 'Playback', default: 'Enter' },
  { id: 'undo', label: 'Undo', section: 'Edit', default: 'Mod+KeyZ' },
  { id: 'redo', label: 'Redo', section: 'Edit', default: 'Mod+Shift+KeyZ' },
  { id: 'selectAll', label: 'Select all notes', section: 'Edit', default: 'Mod+KeyA' },
  { id: 'copy', label: 'Copy selection', section: 'Edit', default: 'Mod+KeyC' },
  { id: 'paste', label: 'Paste', section: 'Edit', default: 'Mod+KeyV' },
  { id: 'delete', label: 'Delete selection', section: 'Edit', default: 'Delete' },
  { id: 'rune', label: 'Make Rune from selection', section: 'Edit', default: 'KeyR' },
  { id: 'flipH', label: 'Flip horizontally', section: 'Transform', default: 'Shift+KeyH' },
  { id: 'flipV', label: 'Flip vertically', section: 'Transform', default: 'Shift+KeyV' },
  { id: 'stretch', label: 'Stretch selection', section: 'Transform', default: 'BracketRight' },
  { id: 'compress', label: 'Compress selection', section: 'Transform', default: 'BracketLeft' },
  { id: 'rotate', label: 'Toggle Rotate mode', section: 'Transform', default: 'KeyT' },
]

const DEFAULTS = Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a.id, a.default]))

// Keys the fixed gestures / rhythm entry rely on — the editor warns if a rebind
// would collide with one of these (they aren't rebindable themselves).
export const RESERVED_SIGS = new Set([
  'Escape', 'Backspace', 'KeyM', 'KeyP', 'KeyX',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
])

let bindings = load()
const listeners = new Set()

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { ...DEFAULTS, ...saved }
  } catch {
    return { ...DEFAULTS }
  }
}
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings))
  } catch {}
}
function emit() {
  for (const l of listeners) l()
}

export function getBindings() {
  return bindings
}
export function setBinding(id, sig) {
  bindings = { ...bindings, [id]: sig }
  persist()
  emit()
}
export function resetBindings() {
  bindings = { ...DEFAULTS }
  persist()
  emit()
}
function subscribe(l) {
  listeners.add(l)
  return () => listeners.delete(l)
}
// Reactive read for the editor UI.
export function useHotkeys() {
  return useSyncExternalStore(subscribe, getBindings, getBindings)
}

// Normalise a keyboard event to a signature; null for a lone modifier press.
export function eventToSig(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  const parts = []
  if (e.ctrlKey || e.metaKey) parts.push('Mod')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.code)
  return parts.join('+')
}

// Does this event fire the given action under the current bindings?
export function isHotkey(id, e) {
  return eventToSig(e) === bindings[id]
}

// Human-readable label for a signature, e.g. 'Mod+Shift+KeyZ' → 'Ctrl/⌘ + ⇧ + Z'.
const CODE_LABELS = {
  BracketRight: ']', BracketLeft: '[', Space: 'Space', Comma: ',',
  Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`',
  Backslash: '\\', Minus: '-', Equal: '=', Enter: 'Enter', Delete: 'Delete',
  Backspace: 'Backspace', Tab: 'Tab', Escape: 'Esc',
}
export function sigToLabel(sig) {
  if (!sig) return '—'
  return sig
    .split('+')
    .map((p) => {
      if (p === 'Mod') return 'Ctrl/⌘'
      if (p === 'Shift') return '⇧'
      if (p === 'Alt') return 'Alt'
      if (p.startsWith('Key')) return p.slice(3)
      if (p.startsWith('Digit')) return p.slice(5)
      if (p.startsWith('Arrow')) return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[p]
      return CODE_LABELS[p] || p
    })
    .join(' + ')
}
