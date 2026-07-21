// Fallback for browsers without the File System Access API: a plain download,
// which lands in the browser's download folder with no way to choose a location.
function triggerDownload(content, filename, type) {
  const blob = new Blob([content], { type: type || 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Derive a picker file-type entry from the extension so the native dialog shows
// a sensible filter and appends the extension when the user omits it.
function describeType(filename, type) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '')
  const ext = m ? `.${m[1].toLowerCase()}` : '.json'
  const mime = type || (ext === '.json' ? 'application/json' : 'text/plain')
  return {
    suggestedName: filename || `export${ext}`,
    types: [
      {
        description: ext === '.json' ? 'JSON file' : `${ext.slice(1).toUpperCase()} file`,
        accept: { [mime]: [ext] },
      },
    ],
  }
}

import { makeZip } from './zip'

// Filesystem-safe file/dir name (no path separators or reserved characters).
function safeName(name, fallback) {
  const s = (name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
  return s || fallback
}

// Write a flat node list as a real directory tree under `dirHandle`: folders
// become subdirectories, templates become individual .json files. Names are
// de-duplicated per directory so same-named siblings don't overwrite.
async function writeTree(dirHandle, nodes, parentId, serialize) {
  const taken = new Set()
  const unique = (base, ext) => {
    let n = safeName(base, 'untitled')
    if (taken.has((n + ext).toLowerCase())) {
      let i = 2
      while (taken.has(`${n} (${i})${ext}`.toLowerCase())) i++
      n = `${n} (${i})`
    }
    taken.add((n + ext).toLowerCase())
    return n + ext
  }
  let count = 0
  for (const node of nodes.filter((n) => (n.parentId ?? null) === parentId)) {
    if (node.type === 'folder') {
      const sub = await dirHandle.getDirectoryHandle(unique(node.name, ''), {
        create: true,
      })
      count += await writeTree(sub, nodes, node.id, serialize)
    } else {
      const fh = await dirHandle.getFileHandle(unique(node.name, '.json'), {
        create: true,
      })
      const w = await fh.createWritable()
      await w.write(new Blob([serialize(node)], { type: 'application/json' }))
      await w.close()
      count++
    }
  }
  return count
}

// Same walk as writeTree, but collecting "Folder/Name.json" paths for a ZIP.
function treeToEntries(nodes, parentId, serialize, prefix, out) {
  const enc = new TextEncoder()
  const taken = new Set()
  const unique = (base, ext) => {
    let n = safeName(base, 'untitled')
    if (taken.has((n + ext).toLowerCase())) {
      let i = 2
      while (taken.has(`${n} (${i})${ext}`.toLowerCase())) i++
      n = `${n} (${i})`
    }
    taken.add((n + ext).toLowerCase())
    return n + ext
  }
  for (const node of nodes.filter((n) => (n.parentId ?? null) === parentId)) {
    if (node.type === 'folder') {
      treeToEntries(
        nodes,
        node.id,
        serialize,
        `${prefix}${unique(node.name, '')}/`,
        out
      )
    } else {
      out.push({
        path: `${prefix}${unique(node.name, '.json')}`,
        data: enc.encode(serialize(node)),
      })
    }
  }
  return out
}

// Hook: `requestSave(content, defaultName, type?)` opens the NATIVE OS save
// dialog, so the destination folder is the user's choice. Falls back to a plain
// download where showSaveFilePicker isn't available (e.g. Firefox/Safari).
//
// `requestSaveTree(nodes, serialize, rootName?)` opens the native DIRECTORY
// picker and writes the nodes out as individual files — folders become real
// subdirectories. With `rootName` the tree is nested inside a new directory of
// that name; without it the nodes land directly in the chosen directory.
//
// `saveAsModal` is kept in the return shape (always null) so existing call sites
// that render it don't need to change.
export function useSaveAs() {
  const requestSave = async (content, defaultName, type) => {
    const name = defaultName || 'export.json'
    if (typeof window !== 'undefined' && window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker(describeType(name, type))
        const writable = await handle.createWritable()
        await writable.write(
          new Blob([content], { type: type || 'application/json' })
        )
        await writable.close()
        return true
      } catch (err) {
        // The user dismissing the picker is a normal outcome, not an error.
        if (err && err.name === 'AbortError') return false
        // Anything else (permission denied, sandboxed iframe): fall through to
        // the download path so the export still happens.
      }
    }
    triggerDownload(content, name, type)
    return true
  }

  const requestSaveTree = async (nodes, serialize, rootName) => {
    if (!nodes || !nodes.length) return { ok: false, count: 0 }

    // Re-root the nodes so the subtree's own top level reads as the root.
    const ids = new Set(nodes.map((n) => n.id))
    const rooted = nodes.map((n) =>
      n.parentId != null && ids.has(n.parentId) ? n : { ...n, parentId: null }
    )

    // Chromium: write the real directory tree wherever the user points us.
    if (typeof window !== 'undefined' && window.showDirectoryPicker) {
      let dir
      try {
        dir = await window.showDirectoryPicker({ mode: 'readwrite' })
      } catch (err) {
        // Dismissing the picker is a normal outcome; anything else falls
        // through to the ZIP path so the export still happens.
        if (err && err.name === 'AbortError') return { ok: false, count: 0 }
        dir = null
      }
      if (dir) {
        try {
          const target = rootName
            ? await dir.getDirectoryHandle(safeName(rootName, 'templates'), {
                create: true,
              })
            : dir
          const count = await writeTree(target, rooted, null, serialize)
          return { ok: true, count }
        } catch {
          return { ok: false, count: 0 }
        }
      }
    }

    // Firefox / Safari: no directory picker exists, so deliver the identical
    // tree as a single .zip that unpacks to the same folders and files.
    const prefix = rootName ? `${safeName(rootName, 'templates')}/` : ''
    const entries = treeToEntries(rooted, null, serialize, prefix, [])
    if (!entries.length) return { ok: false, count: 0 }
    triggerDownload(
      makeZip(entries),
      `${safeName(rootName, 'templates')}.zip`,
      'application/zip'
    )
    return { ok: true, count: entries.length, zipped: true }
  }

  return { requestSave, requestSaveTree, saveAsModal: null }
}
