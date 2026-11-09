import { expect, test } from 'claude-code/testing'

import { aliasesOf, pushedRefs, sendsOut } from '../hooks/lenses/report'

test('a push is read by git’s name alone, however a path or Windows names it', () => {
  for (const c of ['git.exe push', '/usr/bin/git push', 'C:\\Git\\cmd\\git.exe push', 'cd x && D:\\tools\\git.exe -C y push', 'gh.exe pr create --fill', 'C:\\bin\\glab.exe mr create'])
    expect([c, sendsOut(c)]).toEqual([c, true])
  for (const c of ['git.exe push --dry-run', 'C:\\Git\\cmd\\git.exe log', 'gitx.exe push', 'git.exe.bak push', 'mygit.exe push'])
    expect([c, sendsOut(c)]).toEqual([c, false])
  expect(pushedRefs('C:\\Git\\cmd\\git.exe push origin feature/x')).toEqual(['feature/x'])
  expect(sendsOut('git.exe pu', aliasesOf('alias.pu push -u origin\n'))).toBe(true)
})
