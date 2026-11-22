import type Database from 'better-sqlite3'

// A process-local wake hint, never the mailbox authority. Each database handle
// shares a hub so MCP sends, REST sends, and adapter waits see the same commits.
class LocalArrivalHub {
  private revision = 0
  private waiters = new Set<() => void>()
  private stopped = false

  version(): number { return this.revision }

  publish(): void {
    this.revision += 1
    for (const wake of [...this.waiters]) wake()
  }

  close(): void {
    this.stopped = true
    this.publish()
  }

  wait(version: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.stopped || version !== this.revision || signal?.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
      // Subscribe before the second check to close the check/wait race.
      if (this.stopped || version !== this.revision || signal?.aborted) done()
    })
  }
}

const hubs = new WeakMap<Database.Database, LocalArrivalHub>()
export function localArrivalHub(db: Database.Database): LocalArrivalHub {
  let hub = hubs.get(db)
  if (!hub) { hub = new LocalArrivalHub(); hubs.set(db, hub) }
  return hub
}
