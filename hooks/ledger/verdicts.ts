// The lines Claude ends with: `#3 fixed`, `#4 rejected: why`, in either language, bold or listed.
export function verdictsIn(answer: string) {
  const found = new Map<number, { isFixed: boolean; reason: string }>()
  // The Russian in each form Claude writes it: исправлено, исправлен, исправил; отклонено, отклонён.
  for (const m of answer.matchAll(/^[ \t>*\-`|]*#(\d+)[*`]*[ \t|]*[:.\-—–→]?[ \t|]*[*`]*(fixed|rejected|исправлен[оаы]?|исправил[аи]?|отклон[её]н[оаы]?|отклонил[аи]?)(?![a-zа-яё])[*`]*[ \t|]*[:.\-—–→]?[ \t|]*(.*)$/gim))
    found.set(Number(m[1]), { isFixed: /^(fixed|исправ)/i.test(m[2]!), reason: m[3]!.replace(/[`*|\s]+$/g, '').trim() })
  return found
}
