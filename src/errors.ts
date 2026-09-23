// A rejected promise must carry an Error, and `catch` binds `unknown`. What
// Style Dictionary throws is already one; anything else is wrapped rather than
// handed on raw.
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error))
}

// `catch` binds `unknown`, and a thrown non-Error — a string, a rejected
// value out of a config module — carries no `.message`. The `as Error` casts
// this replaces claimed otherwise and printed `undefined` for exactly those
// cases, which is the least useful thing a failure log can say.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
