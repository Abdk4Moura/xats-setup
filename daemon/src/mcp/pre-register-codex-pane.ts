import { z } from 'zod'
import type { CodexPanePreRegRepo } from './codex-pane-pre-register-repo.js'

export const preRegisterCodexPaneInputSchema = z
  .object({
    pane_id: z
      .string()
      .min(1)
      .refine(v => v.startsWith('%'), {
        message: 'pane_id must be a tmux pane id starting with "%"',
      }),
    xats_agent_id: z.string().min(1),
    ttl_seconds: z.number().int().positive().optional(),
  })
  .strict()

export type PreRegisterCodexPaneInput = z.infer<typeof preRegisterCodexPaneInputSchema>

export type PreRegisterCodexPaneResult =
  | { ok: true; expires_at: string }
  | { error: 'invalid_arguments'; detail: string }

const DEFAULT_TTL_SECONDS = 120
const MIN_TTL_SECONDS = 1
const MAX_TTL_SECONDS = 600

function clampTtl(ttl: number | undefined): number {
  const raw = ttl ?? DEFAULT_TTL_SECONDS
  if (raw < MIN_TTL_SECONDS) return MIN_TTL_SECONDS
  if (raw > MAX_TTL_SECONDS) return MAX_TTL_SECONDS
  return raw
}

export class PreRegisterCodexPaneService {
  constructor(
    private readonly repo: CodexPanePreRegRepo,
    private readonly now: () => Date = () => new Date()
  ) {}

  register(args: unknown): PreRegisterCodexPaneResult {
    const parsed = preRegisterCodexPaneInputSchema.safeParse(args)
    if (!parsed.success) {
      return {
        error: 'invalid_arguments',
        detail: parsed.error.issues
          .map(issue => {
            const path = issue.path.join('.')
            return path ? `${path}: ${issue.message}` : issue.message
          })
          .join('; '),
      }
    }

    const now = this.now()
    const ttl = clampTtl(parsed.data.ttl_seconds)
    const expires_at = new Date(now.getTime() + ttl * 1000).toISOString()
    this.repo.deleteExpired(now.toISOString())
    this.repo.upsert({
      pane_id: parsed.data.pane_id,
      xats_agent_id: parsed.data.xats_agent_id,
      expires_at,
    })
    return { ok: true, expires_at }
  }
}
