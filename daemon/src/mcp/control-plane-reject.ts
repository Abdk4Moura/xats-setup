import type { FastifyReply } from 'fastify'

/**
 * Emit a transport-level control-plane rejection with an EMPTY body.
 *
 * Strict MCP clients (e.g. codex's `rmcp`) deserialize ANY `/mcp` response body
 * as an untagged JSON-RPC message. A bare `{ "error": <string> }` object matches
 * no JSON-RPC 2.0 variant and poisons the client transport worker. An empty body
 * is the guaranteed-safe form: there is nothing to mis-parse. The HTTP status
 * (404/401/409/403) is the sole source of truth for the failure kind.
 *
 * The reason travels in the `x-xats-reject` header instead. Headers are not
 * parsed as JSON-RPC, so this stays safe for strict clients while giving an
 * operator or a debugging client something to report: "404 with body length 0"
 * was previously indistinguishable from any other transport failure.
 */
export const XATS_REJECT_HEADER = 'x-xats-reject'

export type RejectReason =
  | 'unknown_session'
  | 'capability_not_bound'
  | 'peer_not_authorized'
  | 'control_plane_conflict'

export function sendControlPlaneReject(
  reply: FastifyReply,
  status: number,
  reason: RejectReason = 'unknown_session',
): FastifyReply {
  // Set before send so the header accompanies the empty body.
  reply.header(XATS_REJECT_HEADER, reason)
  return reply.code(status).send()
}
