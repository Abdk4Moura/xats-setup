// Settings UserPromptSubmit hook for the acceptance rig. A blocked prompt makes
// the host resolve $.prompt.submit to { drop }, which is a real terminal
// refusal; a held prompt keeps the plugin mid-submit so its claim stays
// unacknowledged across a daemon restart. Both are controlled by files so the
// rig decides when each applies.
import fs from 'node:fs'
let raw = ''
process.stdin.on('data', (b) => { raw += b })
process.stdin.on('end', () => {
  let text = raw
  try {
    const d = JSON.parse(raw)
    text = String(d?.prompt ?? d?.message ?? d?.text ?? raw)
  } catch { /* keep raw */ }
  const K = process.env.RIGK || ''
  if (!K || !text.includes('<xats-inbox>')) { process.exit(0) }
  if (fs.existsSync(`${K}/block-on`)) {
    process.stderr.write('rig: host refused this notice\n')
    process.exit(2)
  }
  if (fs.existsSync(`${K}/hang-on`)) {
    const until = Date.now() + 45000
    const sab = new SharedArrayBuffer(4)
    while (Date.now() < until && !fs.existsSync(`${K}/hang-off`)) {
      try { Atomics.wait(new Int32Array(sab), 0, 0, 100) } catch { /* ignore */ }
    }
    fs.appendFileSync(`${K}/guard.log`, `${new Date().toISOString()} released\n`)
  }
  process.exit(0)
})
