import type { Lang, LensResult } from '../../types'

// Russian plural: 1 находка, 2 находки, 5 находок.
const plural = (n: number, one: string, few: string, many: string) => {
  const ten = n % 10
  const hundred = n % 100
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many
}

// What the agent is told of the catalogs beside the mod's own: the project's, the person's.
export type Catalog = { name: string; text: string }
// What changed in one repository of the project: where it is, from which commit it is read, how many
// files the diff holds, and the files git does not know of yet, which no diff shows.
export type RepoChanges = { path: string; base: string; changed: number; untracked: string[] }

const EN = {
  // How to look, whatever the lens: what makes a look a check and not an opinion.
  howToLook: `- Compare with the neighbour. A problem found in one place is a kind, not a point: find every place of the same shape in the diff and around it (grep), and settle them alike.
- Numbers, not opinions. "All 3 callers pass the prop", "0 files outside the task by git diff --stat", not "seems unused". "Clean" without a number is no check.
- A fix is a diff too. Each change made to answer a review has its cost looked at: a new race, another behaviour of shared code for its other callers, a new file outside the task.
- The standard is the repository's. Conventions are checked against its CLAUDE.md, AGENTS.md and CODING_STANDARDS.md and the neighbouring file of the same kind, not against taste.`,
  // The mod's own lenses: the kinds of mistake reviews catch most, in any stack.
  lenses: `1. Code not in its layer or its folder. A check, a conversion or an error raised where another layer owns it (a mapper, a schema, the database); the details of a client (HTTP, statuses) leaking past its layer; state kept beside its store; types and helpers declared inside a service rather than where the project keeps them. Look at: each new condition, throw and conversion in a service; each new type or class in a file that is not about types.
2. A form not by the project's convention. Naming, comparison, function form, dates and logs done otherwise than the project does them; commits not by its rules. Look at: each new identifier and log line against the neighbouring file of the same kind.
3. A module's API wider or narrower than it needs. A method shaped for one call where the project has a general one; positional arguments where a type would do; fields in a spec, model or resource no consumer asks for; a parameter the function does not use; an optional field the code requires; casts and null defaults where the types already meet. Look at: each new signature, how many calls it has and what they pass; each new field, who reads it.
4. What does not belong in the diff. Changes of someone else's, or by chance: config, env, package manifests, a timezone, logic removed with no reason; a scope wider than the task. Look at: git diff --stat, each file explained by the task; each removed line, its reason.
5. An action not needed. A second request for what the first returned; a loop more; a check of what is required anyway; a default passed by hand; a catch that only rethrows. Look at: each call to a database or an API, whether its answer is in hand already; each catch, what it does beyond rethrowing.
6. The same not put together. A block twice, two requests of one moment in two places, related state split in pieces. Look at: lines alike in the diff, by grep on the key call.
7. Access, data, migrations. A rule of access that does not match the domain; a foreign key's delete chosen without asking what goes silently with it; secrets or production values as defaults. Look at: each check of a role or a scope, against the spec and the glossary; each foreign key, what is deleted after it.
8. The neighbouring flows. A fix in create and not in edit; the way of success without the way of failure; the state after the action; update-or-create for an expired record. Look at: for each scenario fixed, its pairs (create and edit, success and error, first time and again).
9. Asynchrony. A flag reset outside finally; a delay where a throttle is meant; a rejection not handled; a value set after its owner is gone; timers and subscriptions not cleaned up. Look at: each await, and each write of state after it.
10. Tests check what is claimed. A tautology, a vacuous case, a production singleton in a test, no case of failure, fixtures twice. Look at: each expectation, whether it would fail without the change.
11. What is said matches the code. A description, comment, doc or spec this same diff made untrue. Look at: each claim, whether the diff holds it.
12. Edge cases and states. Empty, long, first and last, quick repeats; a cold cache, an error, an empty answer. Look at: each list and request, its four states.
13. Shared code. A change to a shared component, hook or helper: every consumer by grep, the default behaviour changed only by a new option.`,
  prompt: (root: string, repos: RepoChanges[], catalogs: Catalog[]): string =>
    `Review the changes of the project at ${root} through each lens below. You made none of them: read them as a reviewer who was not there.

The changes, by repository, each what is committed since its base and what is not:
${repos.map(r => `- \`git -C ${r.path} diff ${r.base}\`: ${r.changed} ${r.changed === 1 ? 'file' : 'files'}${r.untracked.length > 0 ? `, and these files git does not know of yet, which the diff does not show: ${r.untracked.join(', ')}` : ''}`).join('\n')}
A finding names its file by its path from ${root}. Read the code around the changes as much as you need.

How to look:
${EN.howToLook}

The lenses, the mod's own:
${EN.lenses}
${catalogs.map(c => `\nThe lenses of ${c.name}, beside them. Where one names a kind the list above names too, it is one lens with the examples of both; a lesson under a lens adds to it; what the file says to push back on is no finding:\n<<<\n${c.text}\n>>>`).join('\n')}

Do not edit a file, run git that changes anything, build, run tests or a linter that fixes. Where a run would settle a question, name the command.

Report every lens, in the order above and then those of the other catalogs, none left out: its findings, each a file and line, what is wrong and what it risks; or clean, with what you checked and the numbers; or not applicable, and why, in a phrase. Then what the changes get wrong outside the lenses, and, apart, bugs in code the changes do not touch. Quote no code beyond three lines where a finding cannot be read without it.

End your answer with JSON alone: {"lenses": [{"lens": "1. the lens's name", "status": "findings" or "clean" or "na", "checked": "what you checked, with numbers, or why it does not apply", "findings": [{"file": "path from the root", "line": 12, "problem": "what is wrong, a sentence", "risk": "what it risks, a phrase"}]}], "outside": ["what the changes get wrong outside the lenses, with its file and line"], "untouched": ["a bug in code the changes do not touch, with its file and line"]}`,
  // The command and the pane.
  task: 'The branch through lenses',
  title: 'Lenses',
  started: (n: number, base: string) => `The review by lenses reads ${n} ${n === 1 ? 'file' : 'files'} against ${base}; its findings show on the pane.`,
  running: 'The review by lenses is still reading the branch.',
  nothing: (base: string) => `Nothing changed against ${base}: nothing to review.`,
  noRepo: 'The project is not a git repository: the review by lenses reads a diff.',
  more: (n: number) => `and ${n} more, the list cut here`,
  offer: (change: string) => `"${change}" has every task ticked: read the branch through lenses before the archive?`,
  // A push held for the lenses, in `auto`: said to the agent, which waits for the next prompt.
  pushHeld:
    'agent-lens reads the work through the lenses before it leaves the machine (Lenses: auto), and it has not been read since the last push. The review has started: end your turn now, without pushing. What it finds comes as the next prompt, and the push goes once that is settled.',
  pushRunning: 'The review by lenses is still reading the work: end your turn now, without pushing. What it finds comes as the next prompt, and the push goes once that is settled.',
  pushAfter: '\n\nThen push, as you meant to.',
  pushClean: 'The review of the work by lenses found nothing. Push now, as you meant to.',
  pushFree: 'The review by lenses could not read the work, so nothing holds the push. Push now, as you meant to.',
  pushFailed: 'The review by lenses gave no list, so nothing holds the push. Push now, as you meant to.',
  noBase: (given: string) =>
    given === '' ? 'Where the branch forks from is not found: no origin/HEAD, main, master, develop or trunk. Name the base: /changes lenses <base>.' : `"${given}" is no commit or branch of any repository of the project.`,
  unread: (folders: string[]) => `Left unread, no fork point found: ${folders.join(', ')}.`,
  ownRepo: 'the project’s own repository',
  failedSpawn: 'The agent of the review by lenses did not start.',
  reading: (base: string) => `◌ Reading the branch against ${base} through each lens…`,
  failed: 'The review by lenses gave no list.',
  clean: (n: number) => `✓ ${n} lenses, nothing found.`,
  summary: (found: number, lenses: number, base: string) => `${found} ${found === 1 ? 'finding' : 'findings'} in ${lenses} ${lenses === 1 ? 'lens' : 'lenses'}, against ${base}`,
  status: { findings: '✗', clean: '✓', na: '–' } as Record<LensResult['status'], string>,
  outside: 'Outside the lenses',
  untouched: 'In code the branch does not touch: not sent to Claude',
  send: (n: number) => `send to Claude (${n})`,
  again: 'review again',
  sent: 'sent to Claude',
  band: (n: number) => `lenses: ${n} ${n === 1 ? 'finding' : 'findings'}`,
  // Only what the branch got wrong: a bug in code it does not touch is the person's to take up.
  sendText: (results: LensResult[], outside: string[]): string =>
    `The review of the branch by lenses found these. Check each against the code: fix what holds, and say in a line why one does not; a fix is a diff too, so look at what it costs. Change nothing else.\n${[
      ...results.flatMap(r => r.findings.map(f => `- ${r.lens}: ${f.file}${f.line ? `:${f.line}` : ''} — ${f.problem}${f.risk ? ` (${f.risk})` : ''}`)),
      ...outside.map(o => `- outside the lenses: ${o}`),
    ].join('\n')}`,
}

const RU: typeof EN = {
  howToLook: `- Сравнение с соседом. Нашёл проблему в одном месте — найди grep'ом все места той же формы в диффе и рядом с ним и реши их одинаково. Одна находка — это класс, а не точка.
- Числа вместо мнений. «Все 3 потребителя передают проп», «0 файлов вне задачи по git diff --stat», а не «вроде не используется». «Чисто» без числа — не проверка.
- Свой фикс — тоже дифф. У каждой правки по ревью проверить цену: новая гонка, другое поведение общего кода у остальных потребителей, новый файл вне задачи.
- Стандарт — из репозитория. Конвенции сверяются с его CLAUDE.md, AGENTS.md и CODING_STANDARDS.md и с соседним файлом того же типа, а не со вкусом.`,
  lenses: `1. Код не на своём слое и не в своём каталоге. Проверка, приведение или ошибка там, где ими владеет другой слой (маппер, схема, база); детали клиента (HTTP, статусы) просачиваются за его слой; состояние мимо своего стора; типы и вспомогательное объявлены внутри сервиса, а не там, где проект их держит. Смотреть: каждое новое условие, throw и приведение в сервисе; каждый новый тип или класс в файле, который не про типы.
2. Форма не по конвенции проекта. Именование, сравнение, вид функций, даты и логи сделаны не так, как в проекте; коммиты не по его правилам. Смотреть: каждый новый идентификатор и лог против соседнего файла того же типа.
3. API модуля шире или уже, чем нужно. Метод под один вызов там, где у проекта есть общий; позиционные аргументы там, где нужен тип; поля в спеке, модели или ресурсе, которых не просит потребитель; параметр, который функция не использует; необязательное поле, которое код требует; приведения и null по умолчанию там, где типы и так сходятся. Смотреть: каждую новую сигнатуру — сколько вызовов и что передают; каждое новое поле — кто его читает.
4. Лишнее в диффе. Чужие или случайные правки: конфиг, env, манифесты пакетов, таймзона, логика удалена без причины; объём шире задачи. Смотреть: git diff --stat — каждый файл объясняется задачей; каждая удалённая строка — есть причина.
5. Лишнее действие. Повторный запрос того, что вернул первый; лишняя итерация; проверка того, что и так обязательно; дефолт, переданный руками; catch, который только пробрасывает. Смотреть: каждый вызов базы или API — нет ли ответа уже на руках; каждый catch — что он делает, кроме проброса.
6. Одинаковое не склеено. Дубль блока, два запроса одного момента в разных местах, связанное состояние разбито на части. Смотреть: похожие строки в диффе — grep по ключевому вызову.
7. Права, данные, миграции. Правило доступа не сходится с предметной областью; удаление по внешнему ключу выбрано без ответа «что молча пропадёт следом»; секреты или боевые значения в умолчаниях. Смотреть: каждую проверку роли или области — против спеки и глоссария; каждый внешний ключ — что удаляется следом.
8. Соседние флоу. Фикс в создании, а в редактировании нет; путь успеха без пути ошибки; состояние после действия; «обновить или создать» для просроченной записи. Смотреть: у каждого исправленного сценария — его пары (создание и правка, успех и ошибка, первый раз и повтор).
9. Асинхронность. Флаг сбрасывается не в finally; задержка там, где нужен throttle; reject не обработан; значение пишется, когда его владельца уже нет; таймеры и подписки без очистки. Смотреть: каждый await и каждую запись состояния после него.
10. Тесты проверяют заявленное. Тавтология, вакуумный кейс, прод-синглтон в тесте, нет кейса ошибки, дубли фикстур. Смотреть: каждый expect — упал бы он без правки.
11. Заявленное совпадает с кодом. Описание, комментарий, дока или спека, которые этот же дифф сделал неверными. Смотреть: каждое утверждение — есть ли оно в диффе.
12. Граничные случаи и состояния. Пустое, длинное, первый и последний элемент, быстрые повторы; холодный кэш, ошибка, пустой ответ. Смотреть: каждый список и запрос — четыре состояния.
13. Общий код. Правка общего компонента, хука или утилиты — все потребители по grep, поведение по умолчанию меняется только новой опцией.`,
  prompt: (root, repos, catalogs) =>
    `Проверь изменения проекта в ${root} через каждую линзу ниже. Ты их не делал: читай как ревьюер, которого при этом не было.

Изменения по репозиториям, в каждом — то, что закоммичено после его базы, и то, что нет:
${repos.map(r => `- \`git -C ${r.path} diff ${r.base}\`: ${r.changed} ${plural(r.changed, 'файл', 'файла', 'файлов')}${r.untracked.length > 0 ? `, и эти файлы, которых git ещё не знает и которых дифф не покажет: ${r.untracked.join(', ')}` : ''}`).join('\n')}
Файл в находке называй путём от ${root}. Код вокруг изменений читай сколько нужно.

Как смотреть:
${RU.howToLook}

Линзы мода:
${RU.lenses}
${catalogs.map(c => `\nЛинзы ${c.name}, вдобавок к ним. Где линза называет тот же класс, что и список выше, это одна линза с примерами обеих; урок под линзой дополняет её; то, на что файл велит возражать, — не находка:\n<<<\n${c.text}\n>>>`).join('\n')}

Нельзя: править файлы, запускать git, который что-то меняет, сборку, тесты, линтер с автоисправлением. Где вопрос решил бы прогон, назови команду. Отвечай по-русски.

Отчитайся по каждой линзе — в порядке списка выше, потом линзы других каталогов, ни одной не пропуская: её находки, у каждой файл и строка, что не так и чем грозит; или «чисто» — что проверил, с числами; или «неприменимо» — почему, одной фразой. Потом — что изменения делают не так вне линз и, отдельно, баги в коде, который изменения не трогают. Код не цитируй, кроме трёх строк там, где без них находку не понять.

Закончи ответ одним JSON: {"lenses": [{"lens": "1. имя линзы", "status": "findings" или "clean" или "na", "checked": "что проверил, с числами, или почему неприменимо", "findings": [{"file": "путь от корня", "line": 12, "problem": "что не так, одной фразой", "risk": "чем грозит, коротко"}]}], "outside": ["что изменения делают не так вне линз, с файлом и строкой"], "untouched": ["баг в коде, который изменения не трогают, с файлом и строкой"]}`,
  task: 'Ветка через линзы',
  title: 'Линзы',
  started: (n, base) => `Ревью по линзам читает ${n} ${plural(n, 'файл', 'файла', 'файлов')} относительно ${base}; находки появятся в панели.`,
  running: 'Ревью по линзам ещё читает ветку.',
  nothing: base => `Относительно ${base} ничего не менялось: ревьюить нечего.`,
  noRepo: 'Проект не git-репозиторий: ревью по линзам читает дифф.',
  more: n => `и ещё ${n}, список здесь обрезан`,
  offer: change => `В «${change}» отмечены все задачи: прочитать ветку через линзы до архива?`,
  pushHeld:
    'agent-lens читает работу через линзы, прежде чем она уйдёт с машины (Lenses: auto), а с прошлого пуша её не читали. Ревью запущено: закончи ход сейчас и не пушь. Что оно найдёт, придёт следующим промптом, и пуш пойдёт, когда это решится. Отвечай по-русски.',
  pushRunning: 'Ревью по линзам ещё читает работу: закончи ход сейчас и не пушь. Что оно найдёт, придёт следующим промптом, и пуш пойдёт, когда это решится. Отвечай по-русски.',
  pushAfter: '\n\nПотом запушь, как собирался.',
  pushClean: 'Ревью работы по линзам ничего не нашло. Пушь, как собирался. Отвечай по-русски.',
  pushFree: 'Ревью по линзам не смогло прочитать работу, так что пуш ничто не держит. Пушь, как собирался. Отвечай по-русски.',
  pushFailed: 'Ревью по линзам не дало списка, так что пуш ничто не держит. Пушь, как собирался. Отвечай по-русски.',
  noBase: given =>
    given === '' ? 'Не нашлось, откуда ответвилась ветка: нет origin/HEAD, main, master, develop и trunk. Назови базу: /changes lenses <база>.' : `«${given}» — не коммит и не ветка ни одного репозитория проекта.`,
  unread: folders => `Не прочитано, точка ответвления не найдена: ${folders.join(', ')}.`,
  ownRepo: 'репозиторий самого проекта',
  failedSpawn: 'Агент ревью по линзам не запустился.',
  reading: base => `◌ Читаю ветку относительно ${base} через каждую линзу…`,
  failed: 'Ревью по линзам не дало списка.',
  clean: n => `✓ ${n} ${plural(n, 'линза', 'линзы', 'линз')}, ничего не найдено.`,
  summary: (found, lenses, base) => `${found} ${plural(found, 'находка', 'находки', 'находок')} в ${lenses} ${plural(lenses, 'линзе', 'линзах', 'линзах')}, относительно ${base}`,
  status: { findings: '✗', clean: '✓', na: '–' },
  outside: 'Вне линз',
  untouched: 'В коде, который ветка не трогает: Claude не отправляется',
  send: n => `отправить Claude (${n})`,
  again: 'проверить снова',
  sent: 'отправлено Claude',
  band: n => `линзы: ${n} ${plural(n, 'находка', 'находки', 'находок')}`,
  sendText: (results, outside) =>
    `Ревью ветки по линзам нашло это. Сверь каждое с кодом: исправь то, что подтверждается, и одной строкой скажи, почему не подтверждается остальное; свой фикс — тоже дифф, посмотри его цену. Больше ничего не меняй. Отвечай по-русски.\n${[
      ...results.flatMap(r => r.findings.map(f => `- ${r.lens}: ${f.file}${f.line ? `:${f.line}` : ''} — ${f.problem}${f.risk ? ` (${f.risk})` : ''}`)),
      ...outside.map(o => `- вне линз: ${o}`),
    ].join('\n')}`,
}

export type Words = typeof EN
export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
