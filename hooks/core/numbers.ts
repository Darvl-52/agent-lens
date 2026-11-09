// A whole number above zero from a setting as given (a number, or a string a command passed), or
// `or` for anything else.
export const positive = (value: unknown, or = 0) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  const whole = Number.isFinite(n) ? Math.round(n) : 0
  return whole > 0 ? whole : or
}
