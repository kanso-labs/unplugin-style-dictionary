// Whether escapes may be written to this stream.
//
// **The three signals are ordered rather than combined into one conjunction**,
// and that ordering is the whole of it. `FORCE_COLOR=1` on a non-TTY — a CI job
// that wants colour in a log it will render itself — is the single job that
// variable has, and
// `!process.env.NO_COLOR && process.env.FORCE_COLOR !== '0' && stream.isTTY`
// never honours it: the TTY check has the last word and answers `false`.
//
// `NO_COLOR` wins over `FORCE_COLOR` because the convention says so: any
// non-empty value turns colour off, and nothing may turn it back on.
export function colourAllowed(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false

  const forced = process.env.FORCE_COLOR
  if (forced === '0') return false
  if (forced !== undefined && forced !== '') return true

  // A terminal that has told us it cannot render escapes. Not one of the three
  // the issue named, but it is what `TERM=dumb` means and it costs a line.
  if (process.env.TERM === 'dumb') return false

  return stream.isTTY === true
}

export function paint(code: string, value: string, allowed: boolean): string {
  return allowed ? `\u001B[${code}m${value}\u001B[0m` : value
}
