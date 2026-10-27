import type { Hook, MatchedHook } from 'claude-code'

// The row above the prompt and a pane, as a part draws its own.
export type AbovePromptHook = MatchedHook<'ui.render', { component: 'AbovePrompt' }>
export type AbovePromptEvent = Parameters<AbovePromptHook>[1]
export type PaneHook = MatchedHook<'ui.render', { component: 'Pane'; requestId: string }>
// What a Stop hook's next is called as: the chain after it, or a part one hook runs inside another.
export type StopNext = (e: Parameters<Hook<'classic.Stop'>>[1]) => ReturnType<Parameters<Hook<'classic.Stop'>>[2]>
