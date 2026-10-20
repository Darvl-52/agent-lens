import type { Elements, EngineInterface } from 'claude-code'

import type { Decision, Lang, Setup, Skill, Stats, Tab } from '../../types/router'
import { NO_SETUP, shortOf } from './route'
import {
  MODES,
  TABS,
  changeSetup,
  flash,
  ownSetup,
  paneState,
  setFormHint,
  setFormSkill,
  setFormWords,
  setMode,
  setTab,
} from './state'
import { switchLang } from '../switch'
import { WORDS } from './words'
import type { Words } from './words'

type Els = Elements[keyof Elements]
// Where the pane draws and how much room it has; the mobile app draws no Input or Select yet.
export type View = { columns: number; rows: number; surface: string }

const timeOf = (at: number) => {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

const oneLine = (text: string, room: number) => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > room ? `${line.slice(0, Math.max(1, room - 1))}…` : line
}

// The plugin a skill comes from (`mattpocock-skills` of `mattpocock-skills:tdd`); none for the person's
// and the project's own.
const groupOf = (name: string) => (name.includes(':') ? name.slice(0, name.indexOf(':')) : '')

async function openTab($: EngineInterface, tab: Tab) {
  await setTab($, tab)
  await flash($, null)
}

async function addRule($: EngineInterface, skill: string, text: string, words: Words) {
  const when = text.split(',').map(w => w.trim()).filter(Boolean)
  if (when.length === 0) return
  await changeSetup($, own => ({ ...own, rules: [...own.rules, { skill, when }] }), words.added(shortOf(skill), when.join(', ')))
  await setFormWords($, '')
}

async function addHint($: EngineInterface, skill: string, text: string, words: Words) {
  const hint = text.trim()
  if (hint === '') return
  await changeSetup($, own => ({ ...own, hints: { ...own.hints, [skill]: hint } }), words.hinted(shortOf(skill)))
  await setFormHint($, '')
}

async function removeRule($: EngineInterface, index: number, words: Words) {
  await changeSetup($, own => ({ ...own, rules: own.rules.filter((_, i) => i !== index) }), words.removed(index + 1))
}

async function removeHint($: EngineInterface, skill: string, words: Words) {
  await changeSetup(
    $,
    own => ({ ...own, hints: Object.fromEntries(Object.entries(own.hints).filter(([name]) => name !== skill)) }),
    words.hintRemoved(shortOf(skill)),
  )
}

async function toggleSkill($: EngineInterface, skill: string, words: Words) {
  const isOut = (await ownSetup($)).ignored.includes(skill)
  await changeSetup(
    $,
    own => ({ ...own, ignored: isOut ? own.ignored.filter(s => s !== skill) : [...own.ignored, skill] }),
    isOut ? words.unignoredNow(shortOf(skill)) : words.ignoredNow(shortOf(skill)),
  )
}

// From a pick in the history to the rules tab, the skill set in the form: a pick the model got right
// becomes a rule that costs nothing.
async function ruleFrom($: EngineInterface, skill: string, words: Words) {
  await setFormSkill($, skill)
  await setTab($, 'rules')
  await flash($, words.ruleFor(shortOf(skill)))
}

export async function drawPane($: EngineInterface, els: Els, view: View) {
  const { Box, Button, Text } = els
  const held = await paneState($)
  const { tab, mode, said } = held
  const lang = held.lang
  const words = WORDS[lang]
  const data: Data = {
    words,
    own: held.own ?? NO_SETUP,
    project: held.project ?? NO_SETUP,
    catalog: held.catalog,
    decisions: held.decisions,
    stats: held.stats,
    loaded: held.loaded,
    columns: Math.max(30, view.columns - 2),
    canType: view.surface !== 'mobile',
    form: { skill: held.formSkill, words: held.formWords, hint: held.formHint },
  }
  const body =
    tab === 'rules'
      ? rulesTab($, els, data)
      : tab === 'skills'
        ? skillsTab($, els, data)
        : tab === 'history'
          ? historyTab($, els, data)
          : overviewTab(els, data)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={3} flexWrap="wrap">
        {TABS.map((t, i) => (
          <Button
            key={`tab-${t}`}
            plain
            hotkey={String(i + 1)}
            label={t === tab ? `[${words.tabs[t]}]` : words.tabs[t]}
            dimColor={t !== tab}
            onPress={() => openTab($, t)}
          />
        ))}
      </Box>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text dimColor>{words.mode}:</Text>
        {MODES.map(m => (
          <Button
            key={`mode-${m}`}
            plain
            hotkey={m.charAt(0)}
            label={m === (mode ?? 'auto') ? `● ${m}` : m}
            dimColor={m !== (mode ?? 'auto')}
            onPress={() => setMode($, m)}
          />
        ))}
        <Button key="lang" plain hotkey="l" label={words.langButton(lang)} dimColor onPress={() => switchLang($, lang === 'ru' ? 'en' : 'ru')} />
      </Box>
      <Text dimColor>{'─'.repeat(Math.min(data.columns, 72))}</Text>
      {body}
      <Text dimColor>{'─'.repeat(Math.min(data.columns, 72))}</Text>
      {said !== null && (
        <Text color="success" wrap="truncate-end">
          ✓ {said}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {words.keysHelp}
      </Text>
    </Box>
  )
}

type Data = {
  words: Words
  own: Setup
  project: Setup
  catalog: Skill[]
  decisions: Decision[]
  stats: Stats
  loaded: string[]
  columns: number
  canType: boolean
  form: { skill: string | null; words: string; hint: string }
}

// The last prompt and what it got, then the session at a glance.
function overviewTab(els: Els, d: Data) {
  const { Box, Text } = els
  const { words } = d
  const last = d.decisions[0]
  const top = Object.entries(d.stats.bySkill).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const out = new Set([...d.own.ignored, ...d.project.ignored]).size

  if (last === undefined) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{words.emptyOverview}</Text>
        <Text dimColor>{words.counts(d.catalog.length, out, d.own.rules.length + d.project.rules.length)}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text weight="semibold">{words.lastPrompt}</Text>
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Text wrap="truncate-end">«{oneLine(last.prompt, d.columns - 8)}»</Text>
        {last.picks.length > 0 ? (
          last.picks.map(p => (
            <Box key={`last-${p.skill}`} flexDirection="column">
              <Text wrap="truncate-end">
                → <Text color="claude">{shortOf(p.skill)}</Text>
                <Text dimColor>
                  {' '}
                  · {p.by === 'rule' ? words.byRule : words.byModel} · {Math.round(last.ms / 100) / 10}s
                </Text>
              </Text>
              {p.why !== '' && (
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {p.why}
                </Text>
              )}
            </Box>
          ))
        ) : (
          <Text dimColor>→ {words.noteText(last.note)}</Text>
        )}
      </Box>
      <Text wrap="truncate-end">
        {words.sessionStats(d.stats.prompts, d.stats.withSkill, d.stats.byRule, d.stats.byModel)}
      </Text>
      {top.length > 0 && (
        <Text wrap="truncate-end">
          {words.top}: {top.map(([skill, n]) => `${shortOf(skill)} ×${n}`).join(', ')}
        </Text>
      )}
      {d.loaded.length > 0 && (
        <Text dimColor wrap="truncate-end">
          {words.loadedNow}: {d.loaded.map(shortOf).join(', ')}
        </Text>
      )}
      <Text dimColor>{words.counts(d.catalog.length, out, d.own.rules.length + d.project.rules.length)}</Text>
    </Box>
  )
}

// The person's rules and hints, each with ✕, the project's as they are, and a form for a new one.
function rulesTab($: EngineInterface, els: Els, d: Data) {
  const { Box, Button, Text } = els
  const { words } = d
  const hints = Object.entries(d.own.hints)
  const skill = d.form.skill !== null && d.catalog.some(s => s.name === d.form.skill) ? d.form.skill : d.catalog[0]?.name

  return (
    <Box flexDirection="column">
      <Text weight="semibold">{words.rules}</Text>
      {d.own.rules.length === 0 && <Text dimColor>{words.noRules}</Text>}
      {d.own.rules.map((r, i) => (
        <Box key={`rule-${i}`} flexDirection="row" columnGap={1}>
          <Button key={`rm-${i}`} plain label="✕" dimColor onPress={() => removeRule($, i, words)} />
          <Text wrap="truncate-end">
            <Text color="claude">{shortOf(r.skill)}</Text> ← {r.when.join(', ')}
          </Text>
        </Box>
      ))}
      {hints.length > 0 && <Text weight="semibold">{words.hints}</Text>}
      {hints.map(([name, hint]) => (
        <Box key={`hint-${name}`} flexDirection="row" columnGap={1}>
          <Button key={`unhint-${name}`} plain label="✕" dimColor onPress={() => removeHint($, name, words)} />
          <Text wrap="truncate-end">
            <Text color="claude">{shortOf(name)}</Text>: {hint}
          </Text>
        </Box>
      ))}
      {d.project.rules.length > 0 && <Text weight="semibold">{words.projectRules}</Text>}
      {d.project.rules.map((r, i) => (
        <Text key={`project-${i}`} dimColor wrap="truncate-end">
          {'  '}
          {shortOf(r.skill)} ← {r.when.join(', ')}
        </Text>
      ))}

      <Text weight="semibold">{words.newRule}</Text>
      {!d.canType || !('Input' in els) || !('Select' in els) || skill === undefined ? (
        <Text dimColor>{words.noForm}</Text>
      ) : (
        <Box flexDirection="column">
          <els.Select
            key="form-skill"
            label={`${words.skillLabel}: `}
            options={d.catalog.map(s => ({ value: s.name, label: shortOf(s.name) === s.name ? s.name : `${shortOf(s.name)} (${groupOf(s.name)})` }))}
            value={skill}
            onSelect={value => setFormSkill($, value)}
          />
          <els.Input
            key="form-words"
            label={`${words.wordsLabel}: `}
            placeholder={words.wordsPlaceholder}
            value={d.form.words}
            submitLabel={words.addLabel}
            onInput={value => setFormWords($, value)}
            onSubmit={value => addRule($, skill, value, words)}
          />
          <els.Input
            key="form-hint"
            label={`${words.hintLabel}: `}
            placeholder={words.hintPlaceholder}
            value={d.form.hint}
            submitLabel={words.saveLabel}
            onInput={value => setFormHint($, value)}
            onSubmit={value => addHint($, skill, value, words)}
          />
        </Box>
      )}
    </Box>
  )
}

// Every skill, by the plugin it comes from: Enter routes it or leaves it out.
function skillsTab($: EngineInterface, els: Els, d: Data) {
  const { Box, Button, Text } = els
  const { words } = d
  const groups = new Map<string, Skill[]>()
  for (const s of d.catalog) groups.set(groupOf(s.name), [...(groups.get(groupOf(s.name)) ?? []), s])
  const picked = new Map<string, number>()
  for (const p of d.decisions.flatMap(x => x.picks)) picked.set(p.skill, (picked.get(p.skill) ?? 0) + 1)

  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {words.skillsHelp}
      </Text>
      {[...groups].map(([group, skills]) => (
        <Box key={`group-${group || 'own'}`} flexDirection="column">
          <Text weight="semibold">{group || words.ownGroup}</Text>
          {skills.map(s => {
            const byProject = d.project.ignored.includes(s.name)
            const isOut = byProject || d.own.ignored.includes(s.name)
            const short = shortOf(s.name)
            const count = picked.get(s.name)
            const room = d.columns - short.length - 8 - (count ? 4 : 0)

            return (
              <Button
                key={`skill-${s.name}`}
                plain
                dimColor={isOut}
                onPress={() => (byProject ? flash($, words.byProject) : toggleSkill($, s.name, words))}
              >
                {isOut ? '○' : '●'} {short}
                {count ? <Text color="claude"> ×{count}</Text> : ''}
                <Text dimColor> {byProject ? `(${words.byProject})` : oneLine(s.description, Math.max(10, room))}</Text>
              </Button>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

// Every decision of the session, newest first, each pick with a way to make it a rule.
function historyTab($: EngineInterface, els: Els, d: Data) {
  const { Box, Button, Text } = els
  const { words } = d
  if (d.decisions.length === 0) return <Text dimColor>{words.noDecisions}</Text>

  return (
    <Box flexDirection="column">
      {d.decisions.map(x => (
        <Box key={`d-${x.at}`} flexDirection="column">
          <Text wrap="truncate-end">
            <Text dimColor>{timeOf(x.at)}</Text> «{oneLine(x.prompt, d.columns - 10)}»
          </Text>
          {x.picks.length === 0 ? (
            <Text dimColor>{'  '}→ {words.noteText(x.note)}</Text>
          ) : (
            x.picks.map(p => (
              <Box key={`p-${x.at}-${p.skill}`} flexDirection="row" columnGap={1}>
                <Text wrap="truncate-end">
                  {'  '}→ <Text color="claude">{shortOf(p.skill)}</Text>
                  <Text dimColor>
                    {' '}
                    · {p.by === 'rule' ? words.byRule : words.byModel}
                    {p.why && p.by === 'model' ? ` · ${oneLine(p.why, Math.max(10, d.columns - 40))}` : ''}
                  </Text>
                </Text>
                {p.by === 'model' && (
                  <Button key={`rule-from-${x.at}-${p.skill}`} plain dimColor label={words.makeRule} onPress={() => ruleFrom($, p.skill, words)} />
                )}
              </Box>
            ))
          )}
        </Box>
      ))}
    </Box>
  )
}
