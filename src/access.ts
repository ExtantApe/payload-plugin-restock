import type { Where } from 'payload'
import { validOperatorSet } from 'payload/shared'

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0

/**
 * A well-formed, non-empty Payload query: every key is `and`/`or` with a list of queries, or a field with an object
 * of known operators. Payload quietly skips a malformed constraint (`{ site: false }`), which would match every
 * row, so anything else is not a query.
 */
export function isWhere(w: unknown): w is Where {
  if (!plain(w)) return false
  return Object.entries(w).every(([key, value]) =>
    key === 'and' || key === 'or'
      ? Array.isArray(value) && value.length > 0 && value.every(isWhere)
      : plain(value) && Object.entries(value).every(([op, v]) => validOperatorSet.has(op as never) && !matchesAll(op, v)),
  )
}

/** Operators whose value would match every row: an undefined value (Payload drops it), `not_in: []`, or an empty pattern. */
const matchesAll = (op: string, v: unknown) => v === undefined || (op === 'not_in' && Array.isArray(v) && v.length === 0) || ((op === 'like' || op === 'contains') && v === '')

/**
 * An access answer read strictly: exactly `true`, a well-formed query (the caller's reads must then apply it, with
 * `overrideAccess: false`), or `false` for everything else, a thrown error included.
 */
export async function trueOrWhere(check: () => unknown): Promise<true | Where | false> {
  try {
    const answer = await check()
    if (answer === true) return true
    if (isWhere(answer)) return answer
    return false
  } catch {
    return false
  }
}

/**
 * Collection access read strictly, for Payload itself: the host's answer goes through `trueOrWhere`, so a truthy
 * non-`true` value, a malformed query or a throw is a no. The host's function is looked up on each call.
 */
export const strict =
  (get: () => (args: never) => unknown) =>
  (args: unknown): Promise<true | Where | false> =>
    trueOrWhere(() => get()(args as never))

/** For an admin view whose reads all apply the person's access: `true` or a query lets them in, anything else doesn't. */
export const mayUse = async (check: () => unknown): Promise<boolean> => (await trueOrWhere(check)) !== false
