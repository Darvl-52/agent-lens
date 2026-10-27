import type { EngineInterface } from 'claude-code'

import { joinPath } from '../review/diff'

// A file of the person's own Claude config folder, where Claude Code keeps it: CLAUDE_CONFIG_DIR
// where it is set, else ~/.claude.
export async function userFilePath($: EngineInterface, name: string) {
  const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (config) return joinPath(config, name)
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home ? joinPath(home, `.claude/${name}`) : undefined
}
