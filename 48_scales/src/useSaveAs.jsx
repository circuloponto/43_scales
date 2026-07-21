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

// Hook: `requestSave(content, defaultName, type?)` opens the NATIVE OS save
// dialog, so the destination folder is the user's choice. Falls back to a plain
// download where showSaveFilePicker isn't available (e.g. Firefox/Safari).
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
  return { requestSave, saveAsModal: null }
}
