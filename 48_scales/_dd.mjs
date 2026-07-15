import { chromium } from 'playwright-core'
const b = await chromium.launch(); const p = await b.newPage()
await p.setViewportSize({ width: 1300, height: 900 })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto('http://localhost:5199/', { waitUntil: 'networkidle' }); await p.waitForTimeout(400)
const c = await p.$('[data-scale-id]'); if (c) { await c.click(); await p.waitForTimeout(250) }
const o = await p.$('.open-roll'); if (o && !(await o.isDisabled())) { await o.click(); await p.waitForTimeout(600) }

// make a folder
const plus = await p.$('.template-new-wrap button')
await plus.click(); await p.waitForTimeout(150)
await (await p.$$('.template-new-menu .tab-context-menu-item'))[1].click(); await p.waitForTimeout(200)
await p.keyboard.press('Enter'); await p.waitForTimeout(200)

// report the nesting structure: for each folder, its nested template names
async function structure() {
  return await p.evaluate(() => {
    const out = []
    document.querySelectorAll('.templates-list.root > .template-tree-item').forEach(li => {
      const folder = li.querySelector(':scope > .folder-row .folder-name')
      const tmpl = li.querySelector(':scope > .template-row .template-name')
      if (folder) {
        const kids = [...li.querySelectorAll(':scope > .templates-list.nested > .template-tree-item > .template-row .template-name')].map(n => n.textContent)
        out.push(`FOLDER ${folder.textContent} -> [${kids.join(', ')}]`)
      } else if (tmpl) out.push(`TEMPLATE ${tmpl.textContent}`)
    })
    return out
  })
}
console.log('before drag:')
;(await structure()).forEach(s => console.log('  ' + s))

// drag "Scale Up" INTO "New folder" (center = inside)
const src = p.locator('.template-row', { hasText: 'Scale Up' })
const folder = p.locator('.folder-row', { hasText: 'New folder' })
await src.dragTo(folder, { targetPosition: { x: 90, y: 14 } })
await p.waitForTimeout(400)
console.log('after drag Scale Up -> New folder:')
;(await structure()).forEach(s => console.log('  ' + s))

console.log('errors:', errs.length ? errs : '(none)')
await b.close()
