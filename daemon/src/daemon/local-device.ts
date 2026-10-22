import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

export function resolveLocalDeviceLabel(explicit?: string): string {
  const raw = explicit ?? hostname()
  // An explicit label is a contract; a hostname is whatever the box is called.
  // CI runners and managed Macs routinely exceed 64 chars, and refusing to start
  // over that is a first-run failure no user can diagnose.
  const derived = explicit === undefined
  if (raw.includes(':') && !derived) {
    throw new Error('invalid_device_label')
  }

  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')

  if (normalized.length === 0) {
    // Empty result only auto-falls back when the user did not supply --device.
    // Explicit empty/whitespace/all-replaced labels are a misconfiguration —
    // surface it instead of silently aliasing distinct hosts to "local".
    if (!derived) {
      throw new Error('invalid_device_label')
    }
    return 'local'
  }
  if (normalized.length > 64) {
    if (!derived) {
      throw new Error('invalid_device_label')
    }
    // 55 + '-' + 8 hex = 64: deterministic across restarts, hash-suffixed so long
    // hostnames sharing a prefix stay distinct.
    const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
    return `${normalized.slice(0, 55).replace(/-+$/, '')}-${digest}`
  }
  return normalized
}
