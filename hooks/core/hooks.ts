import type { MatchedHook } from 'claude-code'

// The row above the prompt and a pane, as a part draws its own.
export type AbovePromptHook = MatchedHook<'ui.render', { component: 'AbovePrompt' }>
export type AbovePromptEvent = Parameters<AbovePromptHook>[1]
export type PaneHook = MatchedHook<'ui.render', { component: 'Pane'; requestId: string }>
