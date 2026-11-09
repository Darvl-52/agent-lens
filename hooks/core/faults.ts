// What failed in a part and was let go, so the other parts' work ran on: how many times this session,
// and the last error, for /agent-lens to show. A part that fails at each event is seen, not silent.

export type Fault = { count: number; last: string }

const faults = new Map<string, Fault>()
// The longest error kept: its first line, cut here.
const LAST_LENGTH = 200

const textOf = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).split('\n')[0]!.slice(0, LAST_LENGTH)

// A handler for `.catch`: the error is `part`'s, and `value` goes on in place of what failed.
export const failed =
  <T = undefined>(part: string, value?: T) =>
  (err: unknown): T => {
    const was = faults.get(part)
    faults.set(part, { count: (was?.count ?? 0) + 1, last: textOf(err) })
    return value as T
  }

// Each part that failed, the most failures first.
export const faultsNow = () => [...faults.entries()].sort((a, b) => b[1].count - a[1].count)

// A /clear or /resume: a new count.
export function clearFaults() {
  faults.clear()
}
