// Whether a shell command clearly writes no file: each command of it one that only reads, with no
// redirect into a file, no command run in its words, nothing a prefix may start. What is not plainly
// so is taken as writing, as it was: the shell's files are looked at around it.

// The commands that read and never write, whatever their words: what each may write is checked below.
const READERS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'wc', 'pwd', 'echo', 'printf', 'which', 'type', 'file', 'stat', 'du', 'df', 'tree', 'cut', 'diff', 'cd', 'true', 'basename', 'dirname', 'realpath', 'readlink', 'whoami', 'date', 'uname', 'env', 'printenv'])
// git's own that read alone; one with an option that writes (`--output`) is not.
const GIT_READERS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'shortlog', 'describe', 'cat-file', 'ls-tree', 'rev-list', 'merge-base', 'reflog'])
// The words that make a reader write or run something: `find -delete`, `rg --pre`, `git diff --output`,
// `git grep -O` (an editor); `-o` too, as some readers write to the file it names.
const WRITES = /^(?:-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$|--(?:pre|output|open-files-in-pager|ext-diff|textconv)(?:=|$)|-[oO]$|-O\S)/
// What sends output nowhere: no file written.
const NOWHERE = /(?:\d|&)?>>?\s*\/dev\/null|\d>&\d/g

export function isReadOnly(command: string) {
  const text = command.replace(NOWHERE, ' ')
  // A redirect, a command in a command, a heredoc, a background job, a line break of more: not plain.
  if (/[<>`]|\$\(|&(?!&)/.test(text.replace(/&&/g, ''))) return false
  const parts = text.split(/&&|\|\||[;|\n]/)
  return parts.every(part => {
    const words = part.trim().split(/\s+/).filter(Boolean)
    const [tool, ...rest] = words
    if (tool === undefined) return true
    // A quote may hold a separator, and what follows it be read as a command: not plain.
    if (/['"\\]/.test(tool)) return false
    if (rest.some(w => WRITES.test(w))) return false
    if (tool === 'git') return GIT_READERS.has(rest[0] ?? '')
    // `env` alone lists the variables; with words it runs a command.
    if (tool === 'env' || tool === 'printenv') return rest.length === 0 || tool === 'printenv'
    return READERS.has(tool)
  })
}
