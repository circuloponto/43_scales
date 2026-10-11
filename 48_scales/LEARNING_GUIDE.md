# Rebuild Guide: the 48 Scales app (a React refresher in disguise)

Goal: rebuild this app yourself, from an empty folder, learning React and the
music-theory logic as you go. This file gives you **maps, concepts, small
unrelated examples, exercises and quiz questions**. It deliberately does *not*
give you the finished code. The finished code is in `src/`, use it as the
"answer key" only after you've tried (see rule 3).

## How to use this guide

1. **Work in a new empty folder** (e.g. `48_scales_rebuild`), never in this repo.
2. **One stage at a time.** Each stage ends with a *Checkpoint* (what must work)
   and *Quiz* (questions to answer in your own words, write answers in a
   `NOTES.md`). Bring the quiz answers to me and I'll check them.
3. **Stuck protocol** (in order): re-read the stage's concept section, then
   try the browser console / `console.log`, then ask me for a pointer, and
   only last peek at the matching file in this repo. Peek at the *shape* (what
   data goes in/out), then close it and write your own.
4. **Commit after every stage** (`git init` in your new folder). Cheap undo =
   freedom to experiment.
5. Expect your first version of everything to be ugly. Style last.

---

## Part 0: The big picture

### What the app does

- **Matrix screen**: 48 rows, one per 8-note scale. Each row shows a glyph
  (hand-drawn SVG art), which of the 12 notes are in the scale, and its two
  "chord pair" names. You choose a root note; everything transposes.
- **Piano roll screen**: click a scale to open a full editor: notes on a grid,
  playback, tracks/songs, templates, swing, fretboard + guitar voicings,
  hotkeys, export.
- No backend. Persistence = `localStorage`.

### The one idea that makes it all simple

> **Everything is a pitch class (0-11) plus a root offset.**

C=0, C#=1 ... B=11. A scale is an array like `[0,1,3,4,6,7,9,10]`. Transposing
to another root = `(pc + root) % 12`. Chords are described by *position inside
the scale* (scale degree), not fixed notes, so one chord definition works in all
48 scales. If you truly get this, 70% of the logic is just array manipulation.

### Data-flow map (in this repo)

```
scales.js        scales as pitch-class arrays + rootSteps
chordPairs.js    per scale: { left: 'Min7b5', distance: 'Maj 3rd', right: 'Dominant' }
chordVocab.js    chord NAME -> intervals; resolveChordPair() -> real pitches
chords.js        chords defined by scale DEGREE (rootDegree + offsets)
glyphs*.js       SVG stroke data per scale (pure art data)
customScales.js  user-made scales, saved in localStorage
templates.js     saved note patterns {beat, degree, octave, length}
hotkeys.js       tiny shared store for keyboard shortcuts
voicings.js      guitar chord shapes from notes
useSaveAs/zip    export files
            \            |            /
             App.jsx  (matrix, top-level state, audio preview)
                 |  user opens a scale
                 v
             PianoRoll.jsx (+ Fretboard, ChordDiagram, modals, TemplateTree)
```

### Suggested file growth (don't create these upfront!)

You'll start with 1 file and split when it hurts:
`main.jsx` -> `App.jsx` -> `scales.js` -> `theory.js` -> components...

---

## Part 1: React refresher (read this once, return when stuck)

You said you haven't coded in a year, so this is the cheat-sheet. Every example
here is *unrelated* to the app on purpose.

### 1.1 Components are functions that return UI

```jsx
function Greeting({ name }) {          // props arrive as ONE object, destructured
  return <h1>Hello, {name}</h1>;       // {} = "run JavaScript here"
}
// used as: <Greeting name="Ana" />
```

Rules: component names are Capitalised; return **one** root element (or `<>...</>`);
`class` is `className`; inline style is an object `style={{ color: 'red' }}`.

### 1.2 Lists and `key`

```jsx
{fruits.map(f => <li key={f.id}>{f.name}</li>)}
```

`key` lets React match old and new items between renders. Use a stable id, not the
array index, if the list can reorder. (Think: what bug appears if you reorder rows
and keys are indexes? You'll hit it in the matrix.)

### 1.3 State = memory that triggers re-render

```jsx
const [count, setCount] = useState(0);
setCount(count + 1);          // schedules a re-render with the new value
setCount(c => c + 1);         // "updater" form, use when the new value depends on the old
```

Critical rules:
- **Never mutate state** (`arr.push(x)` is wrong). Make a *new* array/object:
  `setArr([...arr, x])`, `setObj({ ...obj, key: v })`.
- State updates are *scheduled*, not instant. Logging right after `setX` shows the old value.
- A component re-renders when its state or props change, **and so do its children**.

### 1.4 Lazy initial state

```jsx
useState(() => JSON.parse(localStorage.getItem('k') || '[]'))   // function runs ONCE
useState(JSON.parse(localStorage.getItem('k') || '[]'))         // runs EVERY render (wasteful)
```

### 1.5 `useEffect`: sync with the outside world

```jsx
useEffect(() => {
  document.title = `Count ${count}`;     // runs AFTER render
  return () => { /* cleanup, runs before next effect / unmount */ };
}, [count]);                             // dependency array
```

- `[]` = run once after first render. `[a, b]` = rerun when a or b change. Omitted = every render.
- Typical uses: save to localStorage, add/remove `window` event listeners, start/stop timers.
- If you add a listener, you **must** remove it in cleanup, or you leak listeners.

### 1.6 `useRef`: a box that survives renders *without* causing them

```jsx
const timer = useRef(null);
timer.current = setInterval(...);        // changing .current does NOT re-render
const el = useRef(null); <div ref={el} />   // also how you get a DOM node
```

Use refs for: DOM elements, timer ids, the AudioContext, "latest value" read inside
event handlers/loops, drag-in-progress info.

### 1.7 `useMemo` / `useCallback`

Caches a computed value / function between renders. **Don't use them by default.**
Add `useMemo` only when a calculation is genuinely expensive or its identity matters.

### 1.8 Lifting state up & prop drilling

If two siblings need the same data, move the state to their closest common parent
and pass it down as props (+ a setter or callback). This is why `App.jsx` here owns
`root`, `settings`, `songs`, and passes them into `PianoRoll`. When drilling gets
painful, the next tools are Context or splitting components.

### 1.9 Controlled inputs

```jsx
<input value={text} onChange={e => setText(e.target.value)} />
```

The input shows what's in state; typing updates state.

### 1.10 Events

`onClick`, `onChange`, `onMouseDown`, `onKeyDown`. Handlers receive a synthetic
event: `e.preventDefault()`, `e.stopPropagation()`, `e.clientX`.
Beware `onClick={fn()}` (calls immediately) vs `onClick={fn}` / `onClick={() => fn(x)}`.

### 1.11 Derived data: don't store what you can compute

If `litNotes` can be calculated from `scale` and `root`, **compute it during render**;
don't keep it in `useState`. Duplicated state goes out of sync.

### 1.12 StrictMode

`main.jsx` wraps the app in `<StrictMode>`. In dev it runs effects twice to expose
missing cleanups. If something "happens twice", that's why, not a bug in your logic.

### Refresher self-test (answer in NOTES.md before Stage 2)

1. Why is `items.push(x); setItems(items)` broken?
2. What's the difference between `useState` and `useRef` for a counter you display vs one you don't?
3. What goes in the dependency array and what happens if you lie about it?
4. When does an effect's cleanup run?
5. Why is `key={index}` risky?

---

## Part 2: JavaScript you'll lean on heavily

Revise these; the music logic is mostly array/modulo work.

| Tool | Where it appears |
|---|---|
| `%` with negatives | JS `-1 % 12` is `-1`, not `11`. Fix: `((n % 12) + 12) % 12`. |
| `map / filter / every / some / find` | everywhere |
| `Set` | fast "is this note in the scale?" checks (`set.has(pc)`) |
| spread `[...a]`, `{...o}` | immutable updates |
| `localStorage` + `JSON.parse/stringify` | persistence, always in `try/catch` |
| destructuring & defaults | props, `({ x = 4 })` |
| `Math.floor / round`, `2 ** (n/12)` | pixels to beats, MIDI to frequency |

Try in the console: `[...new Set([3,1,3,2])]`, `[5,1,4].sort()` (what's surprising
about default sort? how do you sort numbers?), `[1,2,3].every(n => n > 0)`.

---

## Part 3: The stages

Each stage: **Goal, Concepts, Exercises, Pointers (where to look), Checkpoint, Quiz.**

---

### Stage 0: Project setup

**Goal:** a blank Vite + React page running.

**Concepts:** Node/npm, what Vite is (dev server + bundler), the entry chain
`index.html -> main.jsx -> App.jsx`, ES modules (`import`/`export`).

**Exercises**
1. `npm create vite@latest rebuild -- --template react`, `cd rebuild`, `npm install`, `npm run dev`.
2. Delete everything inside `App.jsx` except a component that renders `<h1>48 Scales</h1>`.
3. Open `index.html`: find the `<div id="root">`. Open `main.jsx`: find where React attaches to it.
4. Run `npm run build` and look at what appears in `dist/`.

**Pointers:** compare your `main.jsx` with this repo's (10 lines).

**Checkpoint:** browser shows your heading; editing the file updates it without a refresh.

**Quiz**
- What does `createRoot(...).render(...)` do?
- Difference between `npm run dev` and `npm run build`?
- Named export vs default export: how does each get imported?

---

### Stage 1: Pure music logic (no React yet)

**Goal:** a `theory.js` file with plain functions you can test in the console.

**Concepts:** pitch classes, modulo arithmetic, intervals in semitones, rotation of an array.

**Exercises** (write these as plain functions, test with `node` or temporary `console.log`s)
1. `pcName(pc)` -> `'C'`, `'C♯'`... using a 12-item array. Bonus: accept `useFlats`.
2. `transpose(notes, root)` -> every note shifted by `root`, wrapped to 0-11.
3. `contains(scaleNotes, pc)` -> boolean. First with `.includes`, then rewrite with a `Set`. When would the Set matter?
4. `rotate(notes, k)` -> the same scale started from its k-th note, re-based so the new first note is 0. Example mental test: C major `[0,2,4,5,7,9,11]` rotated by 1 (starting on D) should give `[0,2,3,5,7,9,10]` (Dorian).
5. `intervals(notes)` -> the gaps between consecutive notes (including the wrap-around gap back to the octave).

**Pointers**
- Look at how `chordVocab.js` `resolveChordPair` builds `rotated` from `scaleNotes` and `intrinsicPc` (just that one `.map`). Understand it; then write your own `rotate`.
- `App.jsx` has `chordCyclicIntervals` and `isRotationOf`: later you'll see why intervals are the "fingerprint" of a scale shape.

**Checkpoint:** your functions pass tests you invent yourself, including negative-number edge cases.

**Quiz**
- What does `(-3 % 12)` give? Write the safe version.
- Why can the same scale shape appear at 12 different roots but "rotation" gives different *modes*?
- If scale A is a rotation of scale B, what do their `intervals()` arrays have in common?

---

### Stage 2: The static matrix

**Goal:** a column of rows, each showing a scale's 12 notes lit/unlit, plus a root selector.

**Concepts:** components, props, `.map` + `key`, `useState`, conditional classNames, derived data.

**Exercises**
1. Create `scales.js` with just 4 scales copied in shape from `src/scales.js` (`{ id, notes }`).
2. `<Row scale={...} root={root} />` renders 12 small cells; a cell is "on" if `(pc - root)` wrapped belongs to the scale (think carefully about direction: are you transposing the scale up, or asking if this absolute note is in the transposed scale?).
3. `App` holds `const [root, setRoot] = useState(0)` and a `<select>` of the 12 note names that calls `setRoot`.
4. Add a click handler on a row that stores `selectedId` in state and highlights it.
5. Add a hover state showing the row's note names in a floating label.

**Pointers:** look at the top of `App()` in this repo: the first few `useState`s (`root`, `selectedId`, `hoverRow`). Notice how little state the *core* needs.

**Checkpoint:** change the root -> all lit cells shift; click a row -> highlight.

**Quiz**
- Which component(s) re-render when `root` changes? Prove it with a `console.log` in `Row`.
- Why is `litNotes` computed in render rather than stored in state?
- What breaks if two scales share an `id`?

---

### Stage 3: Persistence and settings

**Goal:** root and a small settings object survive a page refresh. A user can add a "custom scale".

**Concepts:** lazy `useState` init, `useEffect` to write, defensive parsing, validation.

**Exercises**
1. Persist `root` using lazy init + an effect. Refresh to verify.
2. Make a `settings` object `{ useFlats: false, accent: '#7c5cff' }` persisted as one JSON blob. Apply `accent` via a CSS variable (`style={{ '--accent': accent }}`).
3. Manually corrupt the stored value in DevTools -> Application -> Local Storage. Does the app crash? Fix it so it doesn't.
4. Create `customScales.js` with `load / save / sanitize`. A custom scale = `{ id: 'custom-...', name, notes, kind: 'custom' }`.
5. A form (modal or inline) to create one by toggling 12 note buttons; validate: at least 2 notes, unique, sorted.

**Pointers:** read `src/customScales.js` end to end. It's 63 lines; look for *why* ids are strings and why `sanitize` exists. Then close it and write yours.

**Checkpoint:** create a custom scale, refresh, it's still there; corrupt storage doesn't crash the app.

**Quiz**
- Why `useState(load)` and not `useState(load())`?
- What can go wrong with `JSON.parse(localStorage.getItem(k))` if `k` doesn't exist? (Hint: what does `getItem` return, what does `JSON.parse(null)` do?)
- Why do the custom scales use a string id with a prefix?

---

### Stage 4: Chords

**Goal:** show a chord pair for each scale and highlight its notes when hovering.

**Concepts:** data-driven design, lookup tables, "resolve names to pitches" function,
search with early exit.

**Exercises**
1. Create `CHORD_INTERVALS = { 'Min 7': [0,3,7,10], 'Dominant': [0,4,7,10], ... }` (semitones from the chord root).
2. Create `INTERVAL_SEMITONES = { 'Half Step': 1, 'Maj 3rd': 4, ... }`.
3. Write `resolveChordPair(pair, scaleNotes, root)` that:
   - tries each scale note as the left chord root,
   - builds left and right chord note lists,
   - accepts the first candidate where **all** chord notes are inside the scale,
   - returns transposed pitches (or `null` if none fit).
4. Write 5 pairs by hand (`{scaleId, left, distance, right}`) and verify by ear/theory that they fit.
5. On hover, highlight `leftNotes` in one colour and `rightNotes` in another.
6. Read `chords.js` for a *second* way to describe chords: by scale **degree** (`rootDegree + offsets`). Write down when each representation is better.

**Pointers:** `chordVocab.js` (84 lines) shows the vocabulary tables and the function. Try your version *first*, then compare how it handles `rootStep` and why.

**Checkpoint:** hovering rows highlights two differently-coloured chords; scales with no valid fit don't crash (`null` handled).

**Quiz**
- Why is it a `for ... of` with `continue` and `return`, rather than `.map`?
- What's the difference between defining a chord by semitones and by scale degree? Give an example where only the degree version generalises.
- What does `rootStep` solve?

---

### Stage 5: Sound (Web Audio)

**Goal:** click a row (or press play) and hear the scale / a chord.

**Concepts:** `AudioContext`, oscillator -> gain -> destination graph, MIDI note numbers, the
autoplay policy, scheduling with `currentTime`.

**Maths:** `freq = 440 * 2 ** ((midi - 69) / 12)`. MIDI 60 = middle C. A pitch class + octave -> `midi = 12 * (octave + 1) + pc`.

**Exercises**
1. Write `midiToFreq`. Check: 69 -> 440, 81 -> 880.
2. Play one 0.5 s sine tone on button click:
   ```js
   // shape only, fill in the details yourself
   const ctx = new AudioContext();
   const osc = ctx.createOscillator();
   const gain = ctx.createGain();
   // osc.frequency.value = ?   osc.connect(?).connect(?)
   // osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
   ```
3. Remove the click at the end: ramp gain to ~0 before stop (`gain.gain.linearRampToValueAtTime`). Hear the difference.
4. Play the 8 scale notes one after another by scheduling each at `ctx.currentTime + i * 0.25`. *Do not* use `setTimeout` per note: note why it drifts.
5. Play a chord (several oscillators at the same time). Lower each gain so it doesn't clip.
6. Keep **one** shared AudioContext in a `useRef` (or module scope).

**Pointers:** `App.jsx` around the first `AudioContext` usage; `PianoRoll.jsx` has a note about a module-scope context shared between instances. Read the comment first.

**Checkpoint:** scale plays ascending, chord plays together, no clicks, no new context per note.

**Quiz**
- Why can't you create audio on page load without a click?
- Why schedule on the audio clock instead of `setTimeout`?
- What happens to loudness if you sum 4 oscillators at gain 1?

---

### Stage 6: SVG glyphs

**Goal:** draw one scale's glyph from data.

**Concepts:** SVG `viewBox`, `<path>`/`<line>`/`<circle>`, `transform`, rendering SVG in JSX, mapping arrays to elements.

**Exercises**
1. Hand-write an `<svg viewBox="0 0 100 100">` with a circle and a line. Resize it with CSS: it scales cleanly. Why?
2. Make a data array `[{ type:'line', x1, y1, x2, y2, color }]` and render it with `.map`.
3. Add `rot` and a `transform="rotate(deg cx cy)"`.
4. Make one stroke colour replaceable by a prop (`accent`), like the app's themed glyph colour.

**Pointers:** `GlyphRow` in `App.jsx` (lines ~117-160). Don't try to recreate the 2000-line stroke data; it was parsed from an SVG by `parse_svg.mjs` (read it when curious: it's how art became data).

**Checkpoint:** one themed glyph, recolourable.

**Quiz**
- What does `viewBox` do vs `width/height`?
- Why is the stroke data in a separate `.js` file and not inside the component?

---

### Stage 7: The piano roll (the big one, in 8 mini-stages)

Don't build it as one 7,800-line file. Build and **commit each slice**.

**7a: A static grid**
- Rows = pitches (here: scale degrees across octaves), columns = beats.
- Concepts: CSS grid or absolutely positioned divs; one `<div>` per cell is fine at first.
- Quiz: how many DOM nodes for 16 beats x 3 octaves x 8 degrees? Would that scale to 256 beats?

**7b: Notes as data**
- A note: `{ id, beat, degree, octave, length }` (see `templates.js` for real examples).
- State: `const [notes, setNotes] = useState([])`.
- Click an empty cell -> add a note (new array!). Click a note -> remove it.
- Concepts: immutable updates (`filter`, spread), unique ids.
- Pitch from note: `scale.notes[degree] + 12 * octave + root`. Why store *degree* and not MIDI?

**7c: Pixels <-> beats**
- `beat = Math.floor((e.clientX - rect.left) / cellWidth)`, using `getBoundingClientRect()`.
- Snap to a grid (¼ beat, ½ beat...). Write `snap(value, step)`.
- Concepts: refs for the grid element, `clientX` vs element-relative coordinates, scrolling offset.

**7d: Drag to move / resize**
- Pattern: `onMouseDown` on a note stores drag info in a **ref**; attach `mousemove`/`mouseup` to **window** in an effect (or inside the mousedown handler) and remove on mouseup.
- Concepts: refs vs state for drag, cleanup, `stopPropagation`.
- Quiz: why window listeners rather than on the note?

**7e: Playback**
- A play button, a playhead position, a loop length.
- Scheduling: compute each note's start time = `startTime + beat * (60 / bpm)`, schedule oscillators ahead using the audio clock. Drive the *visual* playhead with `requestAnimationFrame`, reading `ctx.currentTime`.
- Concepts: separating audio timing from visual timing; refs for "is playing"; cleanup on stop/unmount.
- Quiz: why would a `setInterval` of 100 ms sound sloppy?

**7f: Swing**
- A pure function mapping a straight beat to a swung beat (see `applySwingBeat` / `unswingTimeBeat` in `PianoRoll.jsx`, and note they are inverses, needed so mouse positions map back to grid positions).
- Concepts: pure functions, inverse functions. Write tests for `unswing(swing(x)) === x`.

**7g: Tracks, songs, undo/redo**
- State shape: `songs[] -> tracks[] -> notes[]`. Active song/track ids.
- Undo/redo: keep a `past` stack and `future` stack of snapshots. Every edit pushes the previous notes onto `past`. Because you never mutate, snapshots are free.
- Concepts: state shape design, reducers (`useReducer` is a good fit here: try it), immutability paying off.

**7h: Templates, fretboard, voicings, hotkeys**
- Templates: save the current selection as `{ name, notes }`; stamp it at the cursor. Persist.
- Fretboard: guitar tuning `[40,45,50,55,59,64]`; fret `f` on string `s` = `tuning[s] + f`. Draw dots where pitch classes match.
- Voicings (`voicings.js`): chords as close/drop voicings placed on string sets. Do this last, it's pure puzzle logic.
- Hotkeys (`hotkeys.js`): a module-level store with `subscribe`/`emit`, plus a `useHotkeys` hook. Study how a hook can subscribe to something that isn't React state.

**Pointers for Stage 7 (props overview):** open `PianoRoll.jsx` at `export default function PianoRoll({` (~line 731) and just read the *prop list*. That's the contract between `App` (owner of songs, templates, settings) and the editor.

**Checkpoint per slice:** the slice works, is committed, and you can explain its state shape out loud.

---

### Stage 8: Routing between screens & polish

- You don't need a router. `App` has `const [view, setView] = useState('matrix')`; render `matrix` or `<PianoRoll />` conditionally. Build the same.
- Collapse state, modals (conditional render + overlay), context menus (position from click coordinates, close on outside click via a window listener).
- Drag & drop of list items: `@dnd-kit` (read its quick start; use it only for tabs/lists reordering).
- Export: build a `Blob`, `URL.createObjectURL`, click a temporary `<a download>`. `zip.js` shows a hand-rolled ZIP writer (optional rabbit hole).

---

## Part 4: Architecture habits to practise

1. **Pure logic in plain `.js` files, UI in `.jsx`.** The theory files here have zero React. That's why they're testable.
2. **State shape first.** Before writing UI for a feature, write down the data (an example object).
3. **One source of truth.** If you can derive it, don't store it.
4. **Immutable updates always.** Spread, `map`, `filter`.
5. **Guard persistence.** Anything from `localStorage` is untrusted.
6. **Split a file when you can't find things, not before.** This repo's two giant files are a warning, not a goal.

## Part 5: Debugging toolkit

- React DevTools (browser extension): inspect props/state live; "highlight updates".
- `console.log` the *state shape*; `console.table(arrayOfObjects)` is great for notes.
- Browser DevTools -> Application -> Local Storage: edit/delete saved data.
- If edits don't show up in the browser, check you're hitting the right dev server port (an old zombie server can keep serving stale code).
- `npm run lint` catches missing effect dependencies.

## Part 6: Milestone interview (quiz bank)

Answer these without looking, mix and match as you go. I'll ask you from this list:

1. Explain what happens, step by step, from clicking a row to the piano roll opening with that scale.
2. Why is a pitch stored as `degree + octave` rather than a MIDI number? What does that buy you when the user changes the root or scale?
3. Describe how you'd add a "Lydian" built-in preset without touching any UI code.
4. A bug report: "after I drag a note and release outside the grid, it keeps moving". Where's the bug likely to be?
5. What would you change to support 1000 notes smoothly? (Think: rendering cost, re-renders on every mouse move.)
6. You added a `useEffect` that adds a keydown listener. List three things that can go wrong.
7. Why does `App` own `songs` instead of `PianoRoll`?
8. What are the trade-offs of `localStorage` for this data? What would break at scale?

---

## Suggested pacing

| Session | Content |
|---|---|
| 1 | Part 1 reading + Stages 0-1 |
| 2 | Stage 2-3 |
| 3 | Stage 4 |
| 4 | Stage 5 |
| 5 | Stage 6 + 7a-7c |
| 6-8 | 7d-7g |
| 9+ | 7h, 8, polish |

**Start here:** do the *Refresher self-test* in Part 1, then Stages 0-2. Send me
your answers and what you built, and I'll review and quiz you. Ask me for
pointers any time with: *"I want to do X, I tried Y, I'm stuck at Z"*.
