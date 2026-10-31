// What can be told of new text with no model: secrets by their known shapes, and the calls where a
// hole usually opens. A secret is refused before it lands. A risky call may be safe where its input
// is, so it is only a note: the agent reads the code around it after the turn.

export type SecretHit = { kind: string; masked: string; key: string }
export type SinkHit = { kind: string; text: string; advice: string }

// Shapes a real credential has by its provider's own format: few false alarms, so they may refuse.
const SECRETS: readonly { kind: string; re: RegExp }[] = [
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{20,}\b/g },
  { kind: 'Stripe key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { kind: 'OpenAI key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}\b/g },
  { kind: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // With its body: code that only looks for the header holds no key.
  { kind: 'private key', re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/g },
  { kind: 'password in a URL', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/'"`]+:([^\s:@/'"`$<{]{3,})@[^\s'"`]+/g },
]

// A value that says it is not real: docs, fixtures and templates are full of them.
const PLACEHOLDER = /example|sample|dummy|placeholder|changeme|change_me|your[-_]|<[^>]*>|\$\{|\{\{|x{6,}|0{6,}|1234567|fake|test[-_]?(?:key|token|secret|password)/i

// What a local database is set up with: in a compose file or a README, no leak. Local: a machine named
// with no dots, as a compose service is, or this one.
const DEFAULT_PASSWORD = /^(?:password|passwd|pass|postgres|mysql|root|admin|secret|guest|redis)$/i
const LOCAL_HOST = /@(?:[^.:/\s'"`]+|127\.0\.0\.1)(?::\d+)?(?:[/?]|$)/

const mask = (value: string) => (value.length <= 10 ? '***' : `${value.slice(0, 6)}…${value.slice(-2)}`)

// A small hash, so what was refused and allowed can be kept without keeping the secret.
const keyOf = (value: string) => {
  let h = 5381
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0
  return `${value.length}:${h >>> 0}`
}

// By value, which stays in this file: what goes out of it says only the kind and the mask.
function scanSecrets(text: string, before = '') {
  const found = new Map<string, SecretHit>()
  for (const { kind, re } of SECRETS)
    for (const match of text.matchAll(re)) {
      const value = match[0]
      // A capture is the part that is the secret: a URL's host says nothing of its password. The
      // first shape to know a value names it: an Anthropic key fits OpenAI's too.
      if (PLACEHOLDER.test(match[1] ?? value) || (DEFAULT_PASSWORD.test(match[1] ?? '') && LOCAL_HOST.test(value)) || before.includes(value) || found.has(value)) continue
      found.set(value, { kind, masked: match[1] ? value.replace(/:\/\/.*@/, '://***@') : mask(value), key: keyOf(value) })
    }
  return found
}

// The secrets in `text` that `before` did not hold already: a secret an edit only kept is not new.
export const findSecrets = (text: string, before = ''): SecretHit[] => [...scanSecrets(text, before).values()]

// Where a web framework hands over what the request said.
const INPUT = String.raw`\b(?:req|request)\.(?:query|params|body|args|form|GET|POST|files|headers|cookies)\b`

// `text` with every secret of a known shape hidden: what a model or a line quotes may hold one.
export const redact = (text: string) => [...scanSecrets(text)].reduce((out, [value, hit]) => out.split(value).join(hit.masked), text)

// A line that names a credential, its values hidden whatever their shape.
export const hideValues = (line: string) => redact(line).replace(/(['"])[^'"]{4,}\1/g, '$1***$1').replace(/=[^\s'"]{4,}/g, '=***')

// The programs that only read local files, and what git may do of the same kind. A list of what is
// allowed, as no list of what reaches a network can be whole: `node -e`, `gh api`, /dev/tcp.
const READERS = new Set(['cat', 'ls', 'wc', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'sort', 'uniq', 'cut', 'tr', 'nl', 'tree', 'file', 'stat', 'du', 'pwd', 'cd', 'echo', 'basename', 'dirname', 'true'])
const GIT_READS = new Set(['log', 'diff', 'show', 'ls-files', 'ls-tree', 'status', 'rev-parse', 'blame', 'grep', 'merge-base', 'cat-file', 'rev-list', 'shortlog', 'describe'])
// The options that make one of those write a file or run a program. A long one may be cut short.
const RUNS_MORE: Record<string, { short?: RegExp; long?: readonly string[] }> = {
  find: { short: /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/ },
  sort: { short: /^-[a-zA-Z]*o/, long: ['--output', '--compress-program'] },
  tree: { short: /^-[a-zA-Z]*o/ },
  file: { short: /^-[a-zA-Z]*C/, long: ['--compile'] },
  rg: { long: ['--pre', '--hostname-bin'] },
  git: { short: /^-[a-zA-Z]*O/, long: ['--output', '--ext-diff', '--textconv', '--open-files-in-pager', '--filters'] },
}
// The one redirection that only reads less.
const QUIET = '2>/dev/null'

// A shell line as the shell would split it: commands, each its words with the quotes gone. Null where
// it does more than run words one after another: a substitution, a redirection, a background job, a
// brace or an escape outside quotes, a quote left open.
function commandsIn(line: string): string[][] | null {
  const commands: string[][] = [[]]
  let word: string | null = null
  const endWord = () => {
    if (word !== null) commands.at(-1)!.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    commands.push([])
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (word === null && line.startsWith(QUIET, i) && /^(?:[\s;|&]|$)/.test(line.slice(i + QUIET.length))) {
      i += QUIET.length - 1
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) return null
      word = (word ?? '') + line.slice(i + 1, close)
      i = close
    } else if (c === '"') {
      word ??= ''
      for (i++; line[i] !== '"'; i++) {
        if (i >= line.length || line[i] === '$' || line[i] === '`') return null
        if (line[i] === '\\') i++
        word += line[i] ?? ''
      }
    } else if (c === '\n' || c === ';') {
      endCommand()
    } else if (/\s/.test(c)) {
      endWord()
    } else if (c === '|') {
      endCommand()
      if (line[i + 1] === '|') i++
    } else if (c === '&') {
      if (line[i + 1] !== '&') return null
      endCommand()
      i++
    } else if (/[\\$`<>(){}]/.test(c)) {
      return null
    } else {
      word = (word ?? '') + c
    }
  }
  endWord()
  return commands.filter(words => words.length > 0)
}

const isCutFrom = (word: string, names: readonly string[]) => {
  const name = word.split('=')[0]!
  return name.length > 2 && name.startsWith('--') && names.some(full => full.startsWith(name))
}

// Whether a shell command only reads: every part of it one of those, with nothing that runs more.
// Quoted text is text: `grep 'a|b' src`, and `grep curl src`, only search. It is no sandbox: git
// reads its config, so a repository planted in the code read could still name a program of its own.
export function isReadOnlyCommand(command: string) {
  const commands = commandsIn(command)
  if (!commands) return false
  return commands.every(words => {
    const [program, ...args] = words as [string, ...string[]]
    if (program === 'git') {
      // git -C <folder> <verb>; no other option before the verb: -c can name a program to run.
      const verb = args[0] === '-C' ? args[2] : args[0]
      if (verb === undefined || !GIT_READS.has(verb)) return false
    } else if (!READERS.has(program)) return false
    // `uniq in out` writes its second file.
    if (program === 'uniq' && args.filter(arg => arg === '-' || !arg.startsWith('-')).length > 1) return false
    const rule = RUNS_MORE[program]
    return !rule || !args.some(arg => rule.short?.test(arg) || (rule.long && isCutFrom(arg, rule.long)))
  })
}

// The calls where holes open. Each is looked for line by line in what the edit added.
const SINKS: readonly { kind: string; re: RegExp; advice: string }[] = [
  { kind: 'XSS', re: new RegExp(String.raw`\bres(?:ponse)?\.(?:send|write|end)\s*\([^\n]*${INPUT}`), advice: 'request data in an HTML answer: escape it, or render through a template that does' },
  { kind: 'open redirect', re: new RegExp(String.raw`\bredirect\s*\([^\n]*${INPUT}`), advice: 'a redirect the request chooses: allow only local paths or a list of hosts' },
  { kind: 'path traversal', re: new RegExp(String.raw`\b(?:readFile|readFileSync|createReadStream|sendFile|writeFile|writeFileSync|open)\s*\([^\n]*${INPUT}`), advice: 'a path the request chooses: resolve it and check it stays in the allowed folder' },
  { kind: 'SSRF', re: new RegExp(String.raw`\b(?:fetch|axios(?:\.\w+)?|got|requests\.\w+|urlopen)\s*\([^\n]*${INPUT}`), advice: 'a server-side request to a URL the request chooses: check the host against a list' },
  { kind: 'XSS', re: /dangerouslySetInnerHTML|\bv-html\b|\[innerHTML\]|\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(|\|\s*safe\b|\bmark_safe\s*\(/, advice: 'HTML from a string: render as text, or sanitize with an allow-list (DOMPurify) where the input is not a constant' },
  { kind: 'SQL injection', re: /(?:\b(?:SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\b[\s\S]*\bSET|DELETE\s+FROM)\b[^\n]*(?:\$\{|['"`]\s*\+\s*\w|['"]\s*%\s*\w|\{\w+\}))|\b(?:SELECT\b[^\n]*\bFROM|INSERT\s+INTO|UPDATE\b[^\n]*\bSET|DELETE\s+FROM)\b[^\n]*['"]\s*\.format\s*\(|\b(?:execute|query|raw)\s*\(\s*(?:f["']|`[^`]*\$\{)|\$queryRawUnsafe|\$executeRawUnsafe/i, advice: 'SQL built from a string: bind the value as a parameter' },
  { kind: 'command injection', re: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[^,)]*\+)|['"](?:sh|bash|zsh|dash)['"]\s*,\s*\[?\s*['"]-c['"]|\bshell\s*[:=]\s*(?:true|True)\b|\bos\.system\s*\(|\bos\.popen\s*\(/, advice: 'a shell given a string: pass the program and its arguments as a list, with no shell' },
  { kind: 'code execution', re: /(?<![.\w])eval\s*\(|\bnew\s+Function\s*\(|\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Safe)|\bunserialize\s*\(/, advice: 'code or objects made from data: parse a plain format such as JSON instead' },
  { kind: 'TLS check off', re: /\bverify\s*=\s*False\b|\brejectUnauthorized\s*:\s*false\b|NODE_TLS_REJECT_UNAUTHORIZED|\bInsecureSkipVerify\s*:\s*true\b/, advice: 'the certificate is not checked: keep verification on and trust the right CA' },
  { kind: 'open CORS', re: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*|\borigin\s*:\s*(?:['"]\*['"]|true)\b[^\n]*\bcredentials\s*:\s*true|\bcredentials\s*:\s*true\b[^\n]*\borigin\s*:\s*(?:['"]\*['"]|true)\b/, advice: 'any site may read the answer: list the origins allowed' },
  { kind: 'weak randomness', re: /\b(?:token|secret|session|password|nonce|otp|salt)\w*\s*[:=][^\n]*\bMath\.random\s*\(/i, advice: 'Math.random can be predicted: use crypto.randomBytes or crypto.randomUUID' },
  { kind: 'weak hash', re: /\b(?:password|passwd|pwd)\w*\b[^\n]*\b(?:md5|sha1)\b|\b(?:md5|sha1)\b[^\n]*\b(?:password|passwd|pwd)\w*\b/i, advice: 'a fast hash for a password: use argon2, scrypt or bcrypt' },
  { kind: 'secret in the client', re: /\b(?:NEXT_PUBLIC|VITE|REACT_APP)_\w*(?:SECRET|PASSWORD|PRIVATE|TOKEN|API_?KEY)\w*/i, advice: 'a variable with this prefix ships in the browser bundle: read it on the server' },
  { kind: 'secret in the code', re: /\b(?:api[-_]?key|secret|password|passwd|auth[-_]?token|access[-_]?token)\b['"]?\s*[:=]\s*['"][^'"\s$<{]{8,}['"]|^\s*(?:export\s+)?\w*(?:PASSWORD|SECRET|API_KEY|TOKEN)\w*=(?![/.])[^\s$'"<{]{8,}\s*$|\bjwt\.(?:sign|verify)\s*\([^,\n]+,\s*['"][^'"]+['"]/i, advice: 'a credential in the source: read it from the environment or a secret store' },
  { kind: 'secret in a log', re: /\b(?:console\.(?:log|info|warn|error|debug)|print|logger?\.\w+)\s*\([^\n]*\b(?:password|passwd|secret|api[-_]?key|auth[-_]?token|access[-_]?token|credit[-_]?card)\b/i, advice: 'a credential in a log: leave it out or mask it' },
]

const LINE_LIMIT = 120
// A longer line is a bundle, not code being written: the patterns would take seconds on it.
const SCAN_LIMIT = 2000

// Files where these calls are examples, not holes. Named from the project's root: a project under
// ~/tests is not a test.
const NOT_CODE = /\.(?:md|mdx|rst|txt|lock|svg|png|jpe?g|gif|webp|ico|pdf|csv)$|(?:^|[\\/])(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|LICENSE|NOTICE|CHANGELOG|\.gitignore|\.gitattributes|\.editorconfig|\.env(?:\.\w+)?)$/i
const IS_TEST = /(?:^|[\\/])(?:tests?|__tests__|fixtures?|__mocks__)[\\/]|\.(?:test|spec)\.\w+$|(?:^|[\\/])test_\w+\.py$/i

export const isCode = (path: string) => !NOT_CODE.test(path)
export const isTest = (path: string) => IS_TEST.test(path)

// The risky calls on the lines `after` adds to `before`; none in a file that is no code, or a test.
export function findSinks(path: string, after: string, before = ''): SinkHit[] {
  if (!isCode(path) || isTest(path)) return []
  const was = new Set(before.split('\n').map(line => line.trim()))
  const found: SinkHit[] = []
  after.split('\n').forEach(whole => {
    if (was.has(whole.trim())) return
    const text = whole.slice(0, SCAN_LIMIT)
    for (const { kind, re, advice } of SINKS) {
      if (!re.test(text)) continue
      // What names a credential is not repeated: only that it is there, and the line with its values hidden.
      const isSecret = kind.startsWith('secret')
      if (isSecret && PLACEHOLDER.test(text)) continue
      found.push({ kind, advice, text: isSecret ? hideValues(text.trim()).slice(0, LINE_LIMIT) : redact(text.trim()).slice(0, LINE_LIMIT) })
    }
  })
  return found
}
