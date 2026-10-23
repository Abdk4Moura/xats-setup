import type Database from 'better-sqlite3'
import {
  bindRuntimeIdentity,
  type BindRuntimeIdentityInput,
  type BindRuntimeIdentityResult,
} from '../daemon/runtime-identity.js'
import { AgentsRepo } from '../storage/agents-repo.js'

export interface BindRuntimeIdentityServiceInput extends BindRuntimeIdentityInput {
  callerAgentId: string
}

export type BindRuntimeIdentityServiceResult =
  | ({ ok: true } & Omit<Extract<BindRuntimeIdentityResult, { ok: true }>, 'ok'>)
  | Extract<BindRuntimeIdentityResult, { error: string }>
  | { error: 'unknown_agent' }

export class BindRuntimeIdentityService {
  private readonly repo: AgentsRepo

  constructor(db: Database.Database) {
    this.repo = new AgentsRepo(db)
  }

  async bind(
    input: BindRuntimeIdentityServiceInput
  ): Promise<BindRuntimeIdentityServiceResult> {
    const caller = this.repo.getById(input.callerAgentId)
    if (!caller) return { error: 'unknown_agent' }

    const result = await bindRuntimeIdentity(input)
    if (!('ok' in result) || !result.ok) return result

    this.repo.setRuntimeBinding(input.callerAgentId, {
      tmux_pane_id: result.tmux_pane_id,
      runtime_ui_pid: result.ui_pid ?? null,
      runtime_tty: result.tty,
      runtime_verification_mode: result.verification_mode,
    })

    return result
  }
}
