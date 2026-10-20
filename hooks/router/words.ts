import type { Lang, Mode, Tab } from '../../types/router'

export type Words = {
  title: string
  summary: string
  mode: string
  modes: Record<Mode, string>
  recent: string
  noDecisions: string
  none: string
  byRule: string
  byModel: string
  rules: string
  noRules: string
  hints: string
  ignored: string
  skills: (n: number) => string
  projectFile: string
  status: (skills: string) => string
  usage: string
  modeSet: (mode: string) => string
  unknownSkill: (name: string) => string
  added: (skill: string, when: string) => string
  hinted: (skill: string) => string
  ignoredNow: (skill: string) => string
  unignoredNow: (skill: string) => string
  removed: (n: number) => string
  noSuchRule: (n: string) => string
  list: (lines: string[]) => string
  failed: string
  opened: string
  langSet: string
  tabs: Record<Tab, string>
  langButton: (lang: Lang) => string
  keysHelp: string
  lastPrompt: string
  emptyOverview: string
  noteText: (note: string | undefined) => string
  sessionStats: (n: number, withSkill: number, byRule: number, byModel: number) => string
  top: string
  loadedNow: string
  counts: (skills: number, out: number, rules: number) => string
  projectRules: string
  newRule: string
  skillLabel: string
  wordsLabel: string
  wordsPlaceholder: string
  hintLabel: string
  hintPlaceholder: string
  addLabel: string
  saveLabel: string
  pickSkillFirst: string
  noForm: string
  skillsHelp: string
  ownGroup: string
  byProject: string
  makeRule: string
  ruleFor: (skill: string) => string
  hintRemoved: (skill: string) => string
  leftOutByProject: string
  ignoredByProject: (skill: string) => string
  fromSpec: string
}

export const WORDS: Record<Lang, Words> = {
  en: {
    title: 'Skill router',
    summary: 'Which skill each prompt gets: mode, recent picks, rules',
    mode: 'Mode',
    modes: { auto: 'auto: Claude loads the skill', suggest: 'suggest: Claude decides', off: 'off' },
    recent: 'Recent prompts',
    noDecisions: 'No prompts routed yet.',
    none: 'none',
    byRule: 'rule',
    byModel: 'model',
    rules: 'Your rules',
    noRules: 'No rules yet.',
    hints: 'When each fits',
    ignored: 'Left out',
    skills: n => `${n} skills to route among`,
    projectFile: 'Project rules: .claude/skill-router.json',
    status: skills => `skill: ${skills}`,
    usage: [
      '/router — the pane: mode, recent picks, rules, skills',
      '/router auto | suggest | off',
      '/router add <skill> <word, phrase, /regex/, …> — run the skill when a prompt says one',
      '/router when <skill> <when it fits> — tell the model when to pick it',
      '/router ignore <skill> · /router unignore <skill>',
      '/router rm <rule number> · /router list',
      '/router lang en | ru — the language of /router and the status line',
    ].join('\n'),
    modeSet: mode => `Skill router: ${mode}.`,
    unknownSkill: name => `No skill answers to "${name}". /router list shows them.`,
    added: (skill, when) => `Rule added: ${skill} ← ${when}`,
    hinted: skill => `Noted when ${skill} fits.`,
    ignoredNow: skill => `${skill} is left out of routing.`,
    unignoredNow: skill => `${skill} is routed again.`,
    removed: n => `Rule ${n} removed.`,
    noSuchRule: n => `No rule ${n}.`,
    list: lines => (lines.length > 0 ? lines.join('\n') : 'No skills found.'),
    failed: 'model failed',
    leftOutByProject: 'left out by the project',
    fromSpec: 'sent from /spec',
    ignoredByProject: skill => `${skill} is left out by the project's .claude/skill-router.json: change it there.`,
    opened: 'Skill router pane opened.',
    langSet: 'Skill router speaks English now.',
    tabs: { overview: 'Overview', rules: 'Rules', skills: 'Skills', history: 'History' },
    langButton: lang => `language: ${lang}`,
    keysHelp: 'Tab: move · Enter: press · 1-4: tabs · a/s/o: mode · Esc: close',
    lastPrompt: 'Last prompt',
    emptyOverview: 'Nothing routed yet. Write a prompt: what was picked and why shows here.',
    noteText: note =>
      note === 'named'
        ? 'the prompt names a skill'
        : note === 'failed'
          ? 'the model failed'
          : note === 'no skills'
            ? 'no skills installed'
            : note === 'loaded'
              ? 'the skill its rule names is loaded already'
              : 'nothing fit',
    sessionStats: (n, withSkill, byRule, byModel) =>
      `This session: ${n} prompts, ${withSkill} with a skill (${byRule} by rule, ${byModel} by model)`,
    top: 'Most picked',
    loadedNow: 'Loaded in this conversation',
    counts: (skills, out, rules) => `${skills} skills · ${out} left out · ${rules} rules`,
    projectRules: 'Project rules (.claude/skill-router.json)',
    newRule: 'New rule',
    skillLabel: 'Skill',
    wordsLabel: 'Words',
    wordsPlaceholder: 'test, тест, /red.?green/',
    hintLabel: 'When it fits',
    hintPlaceholder: 'for any new feature',
    addLabel: 'add',
    saveLabel: 'save',
    pickSkillFirst: 'Pick a skill first.',
    noForm: 'Add rules with /router add <skill> <words>',
    skillsHelp: 'Enter on a skill routes it or leaves it out · ● routed · ○ left out',
    ownGroup: 'Yours and the project’s',
    byProject: 'project',
    makeRule: '+ rule',
    ruleFor: skill => `Type the words for a rule that runs ${skill}.`,
    hintRemoved: skill => `No longer telling the model when ${skill} fits.`,
  },
  ru: {
    title: 'Роутер скиллов',
    summary: 'Какой скилл получает каждый промпт: режим, выборы, правила',
    mode: 'Режим',
    modes: { auto: 'auto: Claude загружает скилл', suggest: 'suggest: Claude решает сам', off: 'выкл' },
    recent: 'Последние промпты',
    noDecisions: 'Пока ничего не маршрутизировано.',
    none: 'ничего',
    byRule: 'правило',
    byModel: 'модель',
    rules: 'Твои правила',
    noRules: 'Правил пока нет.',
    hints: 'Когда что брать',
    ignored: 'Исключены',
    skills: n => `скиллов на выбор: ${n}`,
    projectFile: 'Правила проекта: .claude/skill-router.json',
    status: skills => `скилл: ${skills}`,
    usage: [
      '/router — панель: режим, выборы, правила, скиллы',
      '/router auto | suggest | off',
      '/router add <скилл> <слово, фраза, /regex/, …> — запускать скилл, когда промпт это содержит',
      '/router when <скилл> <когда подходит> — подсказать модели, когда его брать',
      '/router ignore <скилл> · /router unignore <скилл>',
      '/router rm <номер правила> · /router list',
      '/router lang en | ru — язык /router и строки статуса',
    ].join('\n'),
    modeSet: mode => `Роутер скиллов: ${mode}.`,
    unknownSkill: name => `Скилла «${name}» нет. Список: /router list.`,
    added: (skill, when) => `Правило добавлено: ${skill} ← ${when}`,
    hinted: skill => `Запомнил, когда брать ${skill}.`,
    ignoredNow: skill => `${skill} исключён из маршрутизации.`,
    unignoredNow: skill => `${skill} снова участвует.`,
    removed: n => `Правило ${n} удалено.`,
    noSuchRule: n => `Правила ${n} нет.`,
    list: lines => (lines.length > 0 ? lines.join('\n') : 'Скиллов не найдено.'),
    failed: 'ошибка модели',
    leftOutByProject: 'исключён проектом',
    fromSpec: 'отправлено из /spec',
    ignoredByProject: skill => `${skill} исключён проектом в .claude/skill-router.json: это меняется там.`,
    opened: 'Панель роутера открыта.',
    langSet: 'Роутер скиллов теперь на русском.',
    tabs: { overview: 'Обзор', rules: 'Правила', skills: 'Скиллы', history: 'История' },
    langButton: lang => `язык: ${lang}`,
    keysHelp: 'Tab — по кнопкам · Enter — нажать · 1–4 — вкладки · a/s/o — режим · Esc — закрыть',
    lastPrompt: 'Последний промпт',
    emptyOverview: 'Пока ничего. Напиши промпт — здесь появится, какой скилл выбран и почему.',
    noteText: note =>
      note === 'named'
        ? 'скилл назван в промпте'
        : note === 'failed'
          ? 'ошибка модели'
          : note === 'no skills'
            ? 'скиллов нет'
            : note === 'loaded'
              ? 'скилл из правила уже загружен'
              : 'ничего не подошло',
    sessionStats: (n, withSkill, byRule, byModel) =>
      `За сессию: промптов ${n}, со скиллом ${withSkill} (правилом ${byRule}, моделью ${byModel})`,
    top: 'Чаще всего',
    loadedNow: 'Загружены в разговоре',
    counts: (skills, out, rules) => `скиллов ${skills} · исключено ${out} · правил ${rules}`,
    projectRules: 'Правила проекта (.claude/skill-router.json)',
    newRule: 'Новое правило',
    skillLabel: 'Скилл',
    wordsLabel: 'Слова',
    wordsPlaceholder: 'тест, test, /red.?green/',
    hintLabel: 'Когда брать',
    hintPlaceholder: 'для любой новой фичи',
    addLabel: 'добавить',
    saveLabel: 'сохранить',
    pickSkillFirst: 'Сначала выбери скилл.',
    noForm: 'Правила: /router add <скилл> <слова>',
    skillsHelp: 'Enter на скилле — включить или исключить · ● участвует · ○ исключён',
    ownGroup: 'Твои и проектные',
    byProject: 'проект',
    makeRule: '+ правило',
    ruleFor: skill => `Введи слова для правила, которое запускает ${skill}.`,
    hintRemoved: skill => `Подсказка для ${skill} удалена.`,
  },
}
