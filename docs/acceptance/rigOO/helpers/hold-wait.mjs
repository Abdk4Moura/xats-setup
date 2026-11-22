// Holds the single per-(agent,generation) delivery wait slot so the plugin's own
// wait gets 409, and can ack a claimed attempt on request. Records the PID so the
// rig can stop it deterministically, and logs slot acquisition so the rig only
// sends once it actually owns the slot.
import fs from 'node:fs'
const [base, token, outFile, stopFile, ackFile, pidFile] = process.argv.slice(2)
if (pidFile) fs.writeFileSync(pidFile, String(process.pid))
const log = (o) => fs.appendFileSync(outFile, JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let transportErrors = 0
while (!fs.existsSync(stopFile)) {
  if (fs.existsSync(ackFile)) {
    let req = null
    try { req = JSON.parse(fs.readFileSync(ackFile, 'utf8')); fs.unlinkSync(ackFile) } catch { /* retry */ }
    if (req?.attempt_id) {
      try {
        const r = await fetch(`${base}/api/local-delivery/ack`, {
          method: 'POST',
          headers: { 'X-Xats-Delivery-Token': token, 'content-type': 'application/json' },
          body: JSON.stringify(req),
        })
        log({ ack: req, status: r.status, body: (await r.text()).slice(0, 200) })
      } catch (e) { log({ ackError: String(e?.message || e) }) }
      continue
    }
  }
  try {
    const r = await fetch(`${base}/api/local-delivery/wait?timeout_ms=2000`, {
      headers: { 'X-Xats-Delivery-Token': token },
    })
    if (r.status === 200) {
      transportErrors = 0
      const d = await r.json()
      if (Array.isArray(d.hints) && d.hints.length) log({ generation: d.generation, hints: d.hints })
      else log({ acquired: true })
    } else if (r.status === 409) {
      log({ busy: true })
      await sleep(40) // the plugin owns the slot; retry tightly for the gap
    } else {
      log({ waitStatus: r.status })
      await sleep(200)
    }
  } catch (e) {
    transportErrors += 1
    log({ waitError: String(e?.message || e) })
    if (transportErrors >= 3) break
    await sleep(100)
  }
}
