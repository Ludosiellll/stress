# Оценка результатов (0.3.0): план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оценка результата по трём шкалам (ступень тренажёра, ориентир по опубликованным нормам, история этого же блока): после каждого блока, в «Прогрессе» и в итогах диагностики, где добавляется сравнение с прошлой. В индексе готовности Π таблицы Горбова считается от собственной базы.

**Architecture:**
- Таблицы норм и ступеней — чистый код в `src/engine` (`norms.ts`, `levelSteps.ts`).
- История блоков и тексты оценки — чистый код в `src/session` (`blockHistory.ts`, `assessment.ts`, `diagnosticCompare.ts`): им нужны модули (`describeChanges`, `FAMILIES`, `MEMORY_TRIALS`), а `engine` модули не импортирует. Запись истории для текущего блока и для прошлых строится одной функцией из `BlockRow`. Поэтому показанное и сравниваемое всегда совпадают.
- Контроллер читает историю один раз при старте тренировки (`listBlocks` + `listSessions`), дописывает в неё каждый сохранённый блок и кладёт оценку в `BlockSummaryView`. Диагностика ничего нового не читает: прошлые диагностики она уже читает (по `at`, W2-R33).
- UI показывает готовые строки: раздел «Оценка» в `BlockSummary`, таблица «Оценка по модулям» в «Прогрессе», колонки сравнения в `Done`.

**Tech Stack:** без изменений относительно W1 и W2. Новых пакетов нет, Rust и миграции не меняются.

**Spec:** `docs/superpowers/specs/2026-10-15-assessment-design.md` (дальше «спека», ссылки вида §2.1). Основная спека: `docs/superpowers/specs/2026-10-14-trainer-design.md`. Источники норм и рейтинги надёжности: `stress-notes/20_Domain/Norms_Research.md`. Решения сборки W2: `.superpowers/sdd/2026-10-14-w2/progress.md` (W2-R26…W2-R40).

## Global Constraints

- Все ограничения W1 и W2 действуют: русский интерфейс; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; `src/engine/**` не импортирует `react`, `@tauri-apps/*`, `runtime`, `ui`, `data`, `platform`, `modules`; `Math.random` запрещён в `engine` и `modules`; fast-check `numRuns: 1000`.
- Тексты проходят навык `humanizer`. Строки этого плана точные: правка `humanizer` меняется только решением контролёра, одновременно в «Справочнике» и в тестах.
- Покрытие `src/engine/**` и `src/modules/**` остаётся 100 % по всем четырём метрикам (сейчас 100 %, спека §6). Порог конфигурации 95 % не трогать.
- Миграций нет, схема не меняется, сохранённая история не переписывается. В `DiagnosticMetrics` (JSON) добавляются `pzmrMeanRt` и `szmrMeanRt`; в старых строках они читаются как `null`.
- Диагностика сравнима с 0.2.0: сегменты, уровни, объёмы и зёрна не меняются.
- `summaryJson` и `paramsJson` разбираются защитно: у строк до `46fca3b` нет `frameMs` и `conditions`, импортированные строки проверены только как строки. Нечитаемая строка просто не попадает в историю, экран от неё не падает.
- Одна дорога (как в W2): запись истории текущего и прошлых блоков строится одной функцией из `BlockRow`; разности показываются через `displayedCost`/`shownCost` (W2-R38); прошлые диагностики берутся в порядке `listDiagnostics` (по `at`, W2-R33); индексы считает только `readinessOfLatest`.
- Подпись нормы всегда говорит «ориентир» и называет источник и условие.
- После каждой задачи `npm run lint && npm run typecheck && npm run test:coverage && npm run e2e` зелёные, вывод без предупреждений. Задача, которая меняет то, что встречает e2e-бот, сама обновляет `tests/e2e`.
- Версия остаётся 0.2.0 (`package.json`, `Cargo.toml`, `tauri.conf.json` не трогать). В CHANGELOG — раздел «0.3.0 — не выпущена»; выпуск будет позже вместе с другой работой.
- Коммиты маленькие, по шагам задач. В конце каждого сообщения коммита:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DyMAoKiN9vQVwkteAH8CG1
  ```
- Ветка `claude/hopeful-ritchie-msamlm`, пуш после каждой задачи.

## Review Focus

1. **Первая диагностика 0.3.0 у пользователя после обновления.** В прошлой диагностике 0.2.0 нет `pzmrMeanRt`, в диагностике 0.1.0 нет показателей W2. Ожидание: в колонке «Прошлая» для них «нет данных», в «Изменении» «—», ориентир ПЗМР и СЗМР берётся по текущему среднему, ничего не падает. Тесты — Task 5 (`a previous value that is missing reads «нет данных» and has no change`, `old previous rows read their missing metrics as null`).
2. **Два блока одного варианта в одной сессии.** Ожидание: второй сравнивается с первым (история дописывается при записи блока); блок, от записи которого отказались («Пропустить»), в историю не попадает. Тесты — Task 4 (`the next block of the variant compares with the one before it`, `an abandoned block does not enter the history`).
3. **Таблица не закончена за лимит.** Ожидание: числа нет, в историю блок не идёт, отметки и строки нормы нет, ступень и цель есть; в «Прогрессе» лучший результат и «самая крупная пройденная сетка» считаются только по законченным. Тесты — Task 2 (`unfinished tables have no number`), Task 3 (`an unfinished table: step and history, no mark, no norm`), Task 6 (`Шульте: the largest finished grid`).
4. **История не читается при старте сессии** (база занята, сбой диска). Ожидание: сессия идёт, строки истории нет совсем (а не «Первый такой блок»), ошибка в журнале. Тест — Task 4 (`a history read failure is logged and the session runs without a history line`).
5. **Блок в других условиях.** Перегрузка и «замер ненадёжен» не входят в историю и не получают «новый лучший результат». СЗМР с 3 и более цветами (L ≥ 8) не получает норму выбора из двух. Тесты — Task 2 (`entersHistory`), Task 3 (`overload: played level, no goal, no mark`, `timing_unreliable gets no mark`, `СЗМР gets the 2-choice norm only below level 8`).

---

## Справочник (точные значения, на которые ссылаются задачи)

### Ступени (§2.1, `src/engine/levelSteps.ts`)

- Названия: 1 «начальная», 2 «на подходе к формату теста», 3 «формат теста», 4 «сверх нормы», 5 и выше «далеко сверх нормы».
- Модули с уровнем: `L < Lnorm/2` → 1; `L < Lnorm` → 2; иначе `3 + floor((L − Lnorm)/5)`. Нижняя граница следующей ступени `nextStepL`: после 1-й — `Lnorm/2`, после 2-й — `Lnorm`, после ступени `n ≥ 3` — `Lnorm + 5·(n − 2)`. `Lnorm ≤ 0`, `L < 0` или нечисло → `RangeError` (у рядов `L_NORM = 0`, у них ступени по рейтингу).
- Числовые ряды: `R_FORMAT = 1376`. `R < 1100` → 1; `R < 1376` → 2; иначе `3 + floor((R − 1376)/200)`. `nextStepR`: после 1-й — 1100, после ступени `n ≥ 2` — `1376 + 200·(n − 2)`. `R` — среднее рейтингов 8 семейств (`FAMILIES`), у семейства без рейтинга `R0 = 1000`.
- Сверка `R_FORMAT`: среднее `targetD` задач диагностики (`diagnosticSeriesSchedule`) = 1185, `expectedScore(1376, 1185) ≈ 0,75`.

### Нормы (§2.2, `src/engine/norms.ts`)

Четыре порога `cuts` идут от лучшей полосы к худшей: `cuts[0]` замыкает полосу 5, `cuts[1]` — 4, `cuts[2]` — 3, `cuts[3]` — 2, остальное — полоса 1. «Меньше — лучше»: значение проходит порог, если `v < at` (при `inclusive` — `v ≤ at`). «Больше — лучше»: `v > at` (`v ≥ at`). Полосы: 1 «низкий», 2 «ниже среднего», 3 «средний», 4 «выше среднего», 5 «высокий». Граница следующей лучшей полосы для полосы `b < 5` — `cuts[4 − b]`.

| id | Показатель | Лучше | Пороги | Ед. | `metric` | Рейтинг | Подпись (`note`) | Когда применять (`normSamples`) |
|---|---|---|---|---|---|---|---|---|
| `pzmrMean` | ПЗМР, среднее время | меньше | `<225`, `<234`, `≤267`, `≤277` | мс | среднее | A | Мальцев 2026, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру | всегда |
| `pzmrSd` | ПЗМР, SD | меньше | `<37`, `<45`, `≤68`, `≤87` | мс | разброс (SD) | A | Мальцев 2026, юноши 18–21, аппаратная кнопка | всегда |
| `szmrMean` | СЗМР, среднее время | меньше | `<326`, `<342`, `≤382`, `≤412` | мс | среднее | A | Мальцев 2026, выбор из 2, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру | `lBefore < 8` (2 цвета на 2 клавиши; в диагностике L = 0) |
| `gorbovSimple` | Горбов, время задания 1 или 2 | меньше | `≤29`, `≤37`, `≤50`, `≤60` | с | — | C/B | Бумажная методика, источник не указан | задание `black_up` или `red_down`, таблица закончена |
| `gorbovAlternate` | Горбов, чередование P = t3 | меньше | `≤130`, `≤170`, `≤260`, `≤320` | с | — | C/B | Бумажная методика, источник не указан | задание `alternate`, таблица закончена |
| `memorySpan` | Объём памяти на цифры | больше | `≥9`, `≥8`, `≥7`, `≥6` | — | объём | A | Woods 2011, молодые взрослые, слуховое предъявление | протокол `span`: `span`; тренировка: режим `digits`, ответов 6 (`MEMORY_TRIALS`), точных ≥ 4 → `length` |

- `KEYBOARD_OFFSET_MS = 30`. Пороги среднего времени — опубликованные P10/P25/P75/P90 плюс 30: ПЗМР `[195, 204, 237, 247]`, СЗМР `[296, 312, 352, 382]` (Norms_Research §1a, §2a). SD — без поправки.
- Значение для полосы округляется, как показывается: мс — до целых, с — до 0,1, объём — целое.
- `cutText`: «меньше — лучше» с `≤` → «до 37 с», с `<` → «меньше 234 мс»; «больше — лучше» с `≥` → «от 8», с `>` → «больше 8». Единица пишется через пробел, если она есть.
- Строка нормы: `Норма (ориентир)[, {metric}]: {значение} — {полоса}[; {следующая полоса} — {cutText}]. {note}`. Значение: мс — целые («262 мс»), с — с одной цифрой после запятой («44,0 с»), объём — целое («7»). У полосы 5 части про следующую полосу нет.
- Подсказки (одна строка, без полос; `NORM_HINTS`), когда применять — по варианту, в тренировке и в диагностике:

  | Вариант | Текст |
  |---|---|
  | `gonogo` | «Ориентир: ошибки на no-go у студентов 7–21 % при 30 % no-go, в зависимости от темпа (Hasegawa 2020).» |
  | `stroop` | «Ориентир: интерференция у молодых взрослых обычно 60–90 мс; меньше 40 — выше среднего, больше 150 — ниже среднего (Rouder 2023, клавиатура).» |
  | `taskswitch` | «Ориентир: цена переключения при короткой подсказке обычно около 60 ± 70 мс (Stasenko 2017).» |
  | `schulte:5` | «Ориентир: для Шульте 5×5 традиционная норма взрослых на бумаге 40–50 с, хороший результат 25–30 с.» |

- У РДО, «Помехоустойчивости» и числовых рядов ни нормы, ни подсказки нет.

### История блока (§2.3, `src/session/blockHistory.ts`)

Вариант (`variantOf`); нечитаемое значение → `null`, блок в историю не идёт:

| Модуль | Ключ варианта |
|---|---|
| `gorbov` | `gorbov:` + `task` из `summaryJson`, иначе из `paramsJson`; одно из `black_up`, `red_down`, `alternate` |
| `schulte` | `schulte:` + `paramsJson.size` (целое ≥ 1) |
| `memory` | `memory:` + `summaryJson.mode` (`digits`, `letters`, `positions`, `card`) |
| остальные | id модуля |

Ключевой показатель (`keyMetric`, `KEY_METRICS`). Значение хранится округлённым, как показывается: мс — до целых, с — до 0,1, % — до целых.

| Модуль | Значение из `summaryJson` | Ед. | Лучше | Со знаком |
|---|---|---|---|---|
| `pzmr`, `szmr`, `gonogo` | `meanRt` | мс | меньше | нет |
| `rdo` | `meanAbsErrorMs` | мс | меньше | нет |
| `gorbov`, `schulte` | `timeMs / 1000`; `timeMs` не число (не закончено) → числа нет | с | меньше | нет |
| `stroop` | `displayedCost(conditions.congruent.medianRt, conditions.incongruent.medianRt)` | мс | меньше | да |
| `taskswitch` | то же для `repeat` → `switch` | мс | меньше | да |
| `pomeh` | то же для `quiet` → `noisy` | мс | меньше | да |
| `memory` | `100 · exact / answers.length` | % | больше | нет |
| `numseries` | `100 · correct / total` | % | больше | нет |

- В историю идут блоки сессий `training` и `free` без флагов `overload` и `timing_unreliable` (`fatigued` и `calibration` идут), с известным вариантом и числом.
- Запись: `at` = `startedAt`, `value` = ключевой показатель, `L` = `lBefore` (сыгранный уровень), `length` = `summaryJson.length` у памяти (иначе `null`), `norms` = `normSamples(row)`.
- Порядок записей — порядок `listBlocks` (по `startedAt`), затем дописанные блоки; заново не сортируется.
- Статистика: «прошлый раз» — последняя запись; «лучший» — минимум или максимум по направлению; «в среднем за 7 дней» — среднее записей с `at` в `[now − 7 сут, now]`, `null`, если таких нет; «лучший за 30 дней» — то же окно на 30 суток. Запись с нечитаемым `at` в окна не входит.
- Отметка — только у блока, который сам идёт в историю: строго лучше «лучшего» → « — новый лучший результат»; иначе строго лучше «прошлого раза» → « — лучше прошлого раза». Сравниваются значения в округлении показа.
- Строка: `Раньше в этом блоке: прошлый раз {last}[ ({деталь})] · лучший {best}[ · в среднем за 7 дней {mean7d}][отметка]`. Деталь: «ур. {L}»; у памяти «ряд {length}, ур. {L}»; у рядов детали нет. Без записей: «Первый такой блок — будет с чем сравнивать». В диагностике и при нечитаемой истории строки нет.
- Значения (`formatMetric`, округляет сама; так же пишется среднее за 7 дней): мс — целые, у разностей со знаком через `signedMs` («+85 мс», «0 мс», «−12 мс»); с — «48,2 с»; % — «67 %».
- Основной вариант («Прогресс»): `gorbov:alternate`, `memory:digits`, у Шульте — наибольший `N` среди `schulte:N` с записями (нет записей → нет варианта), у остальных — id модуля.

### Оценка после блока (§3.1, `src/session/assessment.ts`)

Порядок строк: ступень, цель, нормы (0–2: ПЗМР даёт среднее и SD, остальные — одну строку нормы или подсказки), история. В диагностике — только нормы и подсказки.

- Число уровня: целое — «12», дробное — одна цифра после запятой («13,5»). Ступень считается по `lAfter`, у блока перегрузки — по `lBefore`.
- Ступень: `Ступень {n} из 5+ — {название} (уровень {L}; формат теста — {Lnorm})`. С 5-й ступени без «из 5+»: «Ступень 6 — далеко сверх нормы (уровень 30; формат теста — 14)». Перегрузка: «…; формат теста — 12; перегрузка)».
- Цель: `До ступени {n + 1} «{название}»: уровень {nextStepL} (+{nextStepL − L}). Там: {изменения}`. Изменения — `describeChanges(module, L, nextStepL, task)`, каждое через `changeText` с первой буквой в нижнем регистре, через «; ». Без изменений части «Там: …» нет. У блока перегрузки цели нет.
- Ряды: «Ступень 2 из 5+ — на подходе к формату теста (рейтинг 1180; формат теста — 1376)» (рейтинг округлён до целых); цель «До ступени 3 «формат теста»: рейтинг 1376 (+196)» (`ceil(nextStepR − R)`).
- Пример спеки §3.1 целиком, с посчитанными значениями, — первый тест Task 3.

### Итоги диагностики (§3.3, `src/session/diagnosticCompare.ts`, `Done.tsx`)

- Строки в порядке `Done`: `pzmr`, `szmr`, `gonogo`, `rdo`, `gorbovV`, `gorbovP`, `gorbovPi`, `numseries`, `pomeh`, `stroop`, `taskswitch`, `memory`. Строк по-прежнему 12; ПЗМР и СЗМР по-прежнему медиана.
- Значение строки, как она показана: медианы и ошибка РДО — целые мс; Go/No-Go — целые %; V, P, Π — с до 0,1; ряды и объём — целые; разности — `shownCost`.
- Направление: больше — лучше у `gonogo`, `numseries`, `memory`, у остальных меньше — лучше.
- «Без изменений», если `|Δ| < 0,02·|прошлое|` или, у строк в мс, `|Δ| < 5`.
- Текст изменения: `{Δ со знаком} {ед.}, лучше` / `…, хуже` или «без изменений». Ед.: «мс»; «%» у Go/No-Go; «с» с одной цифрой после запятой у Горбова («−3,7 с»); у рядов и объёма единицы нет («+2»). Минус — «−» (U+2212).
- Ориентир: ПЗМР — «по среднему {pzmrMeanRt} мс: {полоса}» (`pzmrMean`), СЗМР — то же с `szmrMeanRt` (`szmrMean`); `null` → «—». V → `gorbovSimple`, P → `gorbovAlternate`, объём → `memorySpan`. Остальные, включая Π, — «—».
- Колонки:
  - сравнения нет (`comparison` = `null`): «Показатель», «Результат», «Ориентир»;
  - первая диагностика (`previous` = `null`): те же три колонки и строка «Первая диагностика — сравнивать пока не с чем»;
  - есть прошлая: «Показатель», «Результат», «Прошлая (№{number}, {дд.мм.гггг})», «Изменение», «Ориентир». Нет значения → «нет данных», нет изменения → «—». Дата — `ruDate(at)`.
- Строка индекса под таблицей: «Индекс: {round(readiness)}», плюс « (прошлый — {round(readinessPrevious)})», если он есть. `readiness` = `null` → строки нет. При `comparison` = `null` строки нет.

### «Оценка по модулям» (§3.2)

- Раздел идёт сразу под индексом готовности, до «Контрольных диагностик». Заголовок h2 «Оценка по модулям», таблица `aria-labelledby` на него, строка на модуль в порядке `MODULE_IDS`.
- Колонки: «Модуль», «Ступень», «Последний / лучший за 30 дней», «Ориентир», «Цель».
- «Модуль»: `moduleTitles[m]`, у Горбова « — чередование», у памяти « — цифры», у Шульте с законченной сеткой « — {N}×{N}».
- «Ступень»: `{n} — {название} (ур. {L_saved}; формат теста — {Lnorm})`; у рядов `{n} — {название} (рейтинг {R}; формат теста — 1376)`.
- «Последний / лучший за 30 дней»: `{last} / {best30d}` (`formatMetric`); лучшего за 30 дней нет → `{last} / —`; записей основного варианта нет → «—».
- «Ориентир»: полоса `gradeByBands` по `last.norms[0]`, иначе «—».
- «Цель»: `ур. {nextStepL} (+{Δ})`; у рядов `рейтинг {nextStepR} (+{ceil Δ})`.
- `lifetimeBlocks = 0`: «—», «ещё не тренировался», «—», «—».
- Под таблицей: «Ступень — по сохранённому уровню. Ориентир — опубликованные нормы, ориентировочно; источники — в руководстве.»

### Индекс готовности: Π (§4)

- `GORBOV_PI_SCALE_S = 20`: Π хранится в секундах, это 20 000 мс спеки. «Переключение» = среднее из `diffScore(Π, Π₀, 20)` и `diffScore(switchCostMs, …, 60)`.
- `BAND_GORBOV_P` и `BAND_GORBOV_PI` удаляются (после замены не используются). `BAND_GORBOV_V` и `bandScore` остаются.
- `readinessOfLatest`: Π — ещё одна часть с базой. Она «посчитана», если `latest.gorbov ≠ null`, и «своя база», если в прошлых диагностиках `gorbov` не было. Правило W2-R31 не меняется. Если Π отложена, её база при подсчёте — `null`, а V по-прежнему оценивается по полосам.
- Числа: пара диагностик W1 из теста главной даёт «Реакция» 97, «Внимание» 89, «Переключение» 100 (было 98), «Логика» 100, общий индекс 97 (96,52; было 96). Случай «первая 0.2.0 после 0.1.0», посчитанный без отсрочки: 81 (81,43), как и раньше.
- Подпись под индексом: «Для большинства показателей 60 — уровень первой диагностики; время первых двух таблиц Горбова (V) оценивается по бумажной шкале, это ориентир.»

### Решения планировщика (конфликты и пробелы спеки)

- **О1. Границы полос.** Процентильные таблицы: средняя полоса включает обе границы, крайние полосы строгие. Бумажная шкала и объём памяти — целые границы включительно, как в таблице спеки. Полоса 1 — «низкий», 5 — «высокий». `toNext` — граница следующей лучшей полосы, а не расстояние до неё: «выше среднего — до 37 с».
- **О2. Отметки.** «новый лучший результат» — только если строго лучше всех прежних. Лучше прошлого, но не лучшего — «лучше прошлого раза». Сравнение в округлении показа.
- **О3. Незаконченная таблица** — числа нет: в историю не идёт, отметки и нормы нет.
- **О4. Перегрузка.** Ступень по сыгранному уровню с пометкой «перегрузка», цели нет. Строка истории есть, отметки нет. Блоки перегрузки и «замер ненадёжен» в историю не входят.
- **О5. Итог блока в диагностике** — только нормы и подсказки (уровни фиксированы, история — только тренировок). Сравнение с прошлой — на экране «Сессия завершена».
- **О6. ПЗМР показывает две строки нормы** (среднее и SD), поэтому в разделе от 3 до 5 строк.
- **О7. «Сессия завершена».** Строки ПЗМР и СЗМР остаются медианой: 12 строк, сравнимость со старыми диагностиками. Ориентир берётся по среднему и называет его. У Π нормы нет.
- **О8. «Без изменений»** — `|Δ| < 2 %` прошлого значения или, для мс, `< 5 мс` («меньше 2 % или 5 мс»).
- **О9. Шаг `done`** получает `comparison: { previous, readiness, readinessPrevious } | null`. `null` — тренировка или прошлые диагностики не прочитались; тогда о сравнении ничего не пишется. Отличие от формы в спеке §5 — только обёртка.
- **О10. Ошибка чтения истории** → история `null` → строки истории нет вовсе («Первый такой блок» был бы неправдой). Диагностика историю блоков не читает.
- **О11. Конфликт с R26.** Вся история блоков читается один раз при старте тренировки. При записи блоков — по-прежнему только `listBlockLevels`. Тест R26 меняется соответственно.
- **О12. «Прогресс».** Раздел сразу под индексом готовности. Ступень по `L_saved`. «Без истории» = `lifetimeBlocks = 0`.
- **О13. Память в тренировке.** Норма объёма — длина ряда режима «цифры», если даны все 6 ответов и точных ≥ 4. В e2e-масштабе (3 пробы) норма не появляется.
- **О14. Подпись ступени** «из 5+» — у ступеней 1–4; с 5-й — «Ступень 6 — далеко сверх нормы».
- **О15. Π.** Шкала в секундах, `GORBOV_PI_SCALE_S = 20`. `BAND_GORBOV_PI` удаляется вместе с `BAND_GORBOV_P`. Π, впервые измеренная в последней диагностике, ждёт следующей (W2-R31).
- **О16. Пример спеки §3.1** «лимит 44 → 29 с» при уровне 13,5 неточен: на уровне 13,5 лимит 39 с, 44 с — это уровень 12. Тесты берут посчитанные значения.
- **О17. `changeText`** переезжает из `BlockSummary.tsx` в `src/modules/describe.ts`: его используют итог блока и цель ступени.
- **О18. Окна** «в среднем за 7 дней» и «лучший за 30 дней» — `[now − N сут, now]`.

---

## Файловая структура (новое и изменяемое)

```
src/engine/    norms.ts levelSteps.ts (+ тесты); изм.: readiness.ts diagnostic.ts
src/modules/   изм.: describe.ts (changeText)
src/session/   blockHistory.ts assessment.ts diagnosticCompare.ts (+ тесты); изм.: steps.ts blocks.ts controller.ts
src/ui/        изм.: views/BlockSummary.tsx views/Done.tsx views/ReadinessBlock.tsx screens/Session.tsx
                     screens/Progress.tsx progressModel.ts theme.css (если нужно для таблиц)
tests/e2e/     изм.: fixtures.ts (shot) flows.spec.ts screens.spec.ts
docs/          изм.: USER_GUIDE.md CHANGELOG.md superpowers/specs/2026-10-14-trainer-design.md (§7.5)
```

Тесты `src/engine`, `src/modules`, `src/session` идут в проекте `node`, тесты `src/ui` — в `jsdom` (как сейчас, `vitest.config.ts` не меняется).

---

### Task 1: Нормы и ступени в движке

**Files:**
- Create: `src/engine/norms.ts`, `src/engine/norms.test.ts`, `src/engine/levelSteps.ts`, `src/engine/levelSteps.test.ts`

**Interfaces:**
- Consumes: `L_NORM` (`engine/planner.ts`), `expectedScore`, `targetDifficulty` (`engine/elo.ts`), `diagnosticSeriesSchedule` (`engine/diagnostic.ts`) — только в тестах.
- Produces:
  ```ts
  // src/engine/norms.ts
  export const KEYBOARD_OFFSET_MS = 30;
  export type NormId = 'pzmrMean' | 'pzmrSd' | 'szmrMean' | 'gorbovSimple' | 'gorbovAlternate' | 'memorySpan';
  export interface NormCut { at: number; inclusive: boolean }
  export interface NormTable {
    better: 'lower' | 'higher';
    /** Bands 5, 4, 3, 2 end at these cuts; the rest is band 1 (Справочник «Нормы»). */
    cuts: readonly [NormCut, NormCut, NormCut, NormCut];
    unit: 'мс' | 'с' | '';
    /** «среднее», «разброс (SD)», «объём»; null: the value speaks for itself. */
    metric: string | null;
    rating: 'A' | 'C/B';
    note: string;
  }
  export const NORMS: Readonly<Record<NormId, NormTable>>;
  export const BAND_LABELS: readonly ['низкий', 'ниже среднего', 'средний', 'выше среднего', 'высокий'];
  export type Band = 1 | 2 | 3 | 4 | 5;
  export interface Grade { band: Band; label: string; nextLabel: string | null; toNext: NormCut | null }
  export function gradeByBands(value: number, table: NormTable): Grade;   // RangeError unless finite
  export function cutText(cut: NormCut, table: NormTable): string;
  export const NORM_HINTS: Readonly<{ gonogo: string; stroop: string; taskswitch: string; schulte5: string }>;
  // src/engine/levelSteps.ts
  export const R_FORMAT = 1376;
  export function stepName(step: number): string;
  export interface LevelStep { step: number; name: string; nextStepL: number }
  export function levelStep(L: number, Lnorm: number): LevelStep;
  export interface RatingStep { step: number; name: string; nextStepR: number }
  export function ratingStep(R: number): RatingStep;
  ```

- [ ] **Step 1: Написать падающие тесты** `norms.test.ts` (значения — «Справочник», раздел «Нормы»):
  ```ts
  const bands = (id: NormId, vs: number[]) => vs.map((v) => gradeByBands(v, NORMS[id]).band);
  it('percentile tables: the middle band is closed, the outer ones strict', () => {
    expect(bands('pzmrMean', [224.9, 225, 233.9, 234, 267, 267.1, 277, 277.1])).toEqual([5, 4, 4, 3, 3, 2, 2, 1]);
    expect(bands('pzmrSd', [36.9, 37, 45, 68, 68.5, 87, 87.5])).toEqual([5, 4, 3, 3, 2, 2, 1]);
    expect(bands('szmrMean', [325.9, 326, 342, 382, 382.1, 412, 412.1])).toEqual([5, 4, 3, 3, 2, 2, 1]);
  });
  it('the paper Gorbov scale and the span: whole bounds inclusive', () => {
    expect(bands('gorbovSimple', [29, 29.1, 37, 37.1, 50, 50.1, 60, 60.1, 61])).toEqual([5, 4, 4, 3, 3, 2, 2, 1, 1]);
    expect(bands('gorbovAlternate', [130, 130.5, 170, 171, 260, 261, 320, 321])).toEqual([5, 4, 4, 3, 3, 2, 2, 1]);
    expect(bands('memorySpan', [12, 9, 8, 7, 6, 5, 0])).toEqual([5, 5, 4, 3, 2, 1, 1]);
  });
  it('label, next band and its bound', () => {
    expect(BAND_LABELS).toEqual(['низкий', 'ниже среднего', 'средний', 'выше среднего', 'высокий']);
    expect(gradeByBands(44, NORMS.gorbovSimple)).toEqual({ band: 3, label: 'средний', nextLabel: 'выше среднего', toNext: { at: 37, inclusive: true } });
    expect(gradeByBands(300, NORMS.pzmrMean)).toMatchObject({ band: 1, nextLabel: 'ниже среднего', toNext: { at: 277, inclusive: true } });
    expect(gradeByBands(220, NORMS.pzmrMean)).toEqual({ band: 5, label: 'высокий', nextLabel: null, toNext: null });
    expect(cutText(NORMS.gorbovSimple.cuts[1], NORMS.gorbovSimple)).toBe('до 37 с');
    expect(cutText(NORMS.pzmrMean.cuts[1], NORMS.pzmrMean)).toBe('меньше 234 мс');
    expect(cutText(NORMS.memorySpan.cuts[1], NORMS.memorySpan)).toBe('от 8');
    const strict = { ...NORMS.memorySpan, cuts: [{ at: 8, inclusive: false }, ...NORMS.memorySpan.cuts.slice(1)] } as NormTable;
    expect(cutText(strict.cuts[0], strict)).toBe('больше 8');
    expect(gradeByBands(8, strict).band).toBe(4);
  });
  it('RT tables are the published percentiles + 30 ms on a keyboard; SD has no offset', () => {
    expect(KEYBOARD_OFFSET_MS).toBe(30);
    expect(NORMS.pzmrMean.cuts.map((c) => c.at - KEYBOARD_OFFSET_MS)).toEqual([195, 204, 237, 247]);
    expect(NORMS.szmrMean.cuts.map((c) => c.at - KEYBOARD_OFFSET_MS)).toEqual([296, 312, 352, 382]);
    expect(NORMS.pzmrSd.cuts.map((c) => c.at)).toEqual([37, 45, 68, 87]);
  });
  ```
  Ещё тесты:
  - `every table names its source and condition`: `metric`, `rating`, `note`, `unit` каждой таблицы — литералы из «Справочника»;
  - `NORM_HINTS are the exact texts` — четыре строки подсказок;
  - `rejects a value that is not a finite number`: `NaN`, `Infinity` → `RangeError`;
  - свойство: для каждой таблицы и `a ≤ b` в `[0, 1000]` полоса `a` не хуже полосы `b`, если меньше — лучше, и не лучше, если больше — лучше.
- [ ] **Step 2: Написать падающие тесты** `levelSteps.test.ts`:
  ```ts
  it('half the format level, the format level, then every 5 levels with no ceiling', () => {
    expect(levelStep(0, 12)).toEqual({ step: 1, name: 'начальная', nextStepL: 6 });
    expect(levelStep(5.5, 12).step).toBe(1);
    expect(levelStep(6, 12)).toEqual({ step: 2, name: 'на подходе к формату теста', nextStepL: 12 });
    expect(levelStep(11.5, 12).step).toBe(2);
    expect(levelStep(12, 12)).toEqual({ step: 3, name: 'формат теста', nextStepL: 17 });
    expect(levelStep(13.5, 12)).toEqual({ step: 3, name: 'формат теста', nextStepL: 17 });
    expect(levelStep(17, 12)).toEqual({ step: 4, name: 'сверх нормы', nextStepL: 22 });
    expect(levelStep(22, 12)).toEqual({ step: 5, name: 'далеко сверх нормы', nextStepL: 27 });
    expect(levelStep(100, 12)).toEqual({ step: 20, name: 'далеко сверх нормы', nextStepL: 102 });
    expect(levelStep(4, 9).nextStepL).toBe(4.5);
    expect(levelStep(4.5, 9)).toEqual({ step: 2, name: 'на подходе к формату теста', nextStepL: 9 });
  });
  it('number series have no level: L_norm 0 is refused, so are a negative or non-finite L', () => {
    expect(L_NORM.numseries).toBe(0);
    expect(() => levelStep(0, L_NORM.numseries)).toThrow(RangeError);
    expect(() => levelStep(-0.5, 12)).toThrow(RangeError);
    expect(() => levelStep(Number.NaN, 12)).toThrow(RangeError);
  });
  it('rating steps around R_format', () => {
    expect(ratingStep(1000)).toEqual({ step: 1, name: 'начальная', nextStepR: 1100 });
    expect(ratingStep(1099.9).step).toBe(1);
    expect(ratingStep(1100)).toEqual({ step: 2, name: 'на подходе к формату теста', nextStepR: 1376 });
    expect(ratingStep(1375.9).step).toBe(2);
    expect(ratingStep(1376)).toEqual({ step: 3, name: 'формат теста', nextStepR: 1576 });
    expect(ratingStep(1576)).toEqual({ step: 4, name: 'сверх нормы', nextStepR: 1776 });
    expect(ratingStep(2176)).toEqual({ step: 7, name: 'далеко сверх нормы', nextStepR: 2376 });
    expect(() => ratingStep(Number.NaN)).toThrow(RangeError);
  });
  it('R_format: diagnostic-format items (mean D 1185) are solved with p ≈ 0.75', () => {
    const ds = diagnosticSeriesSchedule().map((e) => e.targetD);
    expect(ds.reduce((a, b) => a + b, 0) / ds.length).toBe(1185);
    expect(expectedScore(R_FORMAT, 1185)).toBeCloseTo(0.75, 3);
    expect(Math.round(targetDifficulty(R_FORMAT))).toBe(1185);
  });
  ```
  Свойство (L с шагом 0,5 в `[0, 200]`, `Lnorm ∈ {6, 9, 10, 12, 14}`): `L < nextStepL`; `levelStep(nextStepL, Lnorm).step === step + 1`; ступень не убывает с ростом `L`. `stepName(1…6)` — названия из «Справочника».
- [ ] **Step 3:** Запустить `npx vitest run src/engine/norms.test.ts src/engine/levelSteps.test.ts`. Ожидается FAIL (файлов нет).
- [ ] **Step 4:** Реализовать `norms.ts` и `levelSteps.ts` по «Справочнику». Таблицы заморожены (`Object.freeze`). Подсказки и подписи лежат только здесь.
- [ ] **Step 5:** Запустить те же тесты. Ожидается PASS. Затем гейт: `npm run lint && npm run typecheck && npm run test:coverage && npm run e2e` — PASS, покрытие `src/engine` и `src/modules` 100 %.
- [ ] **Step 6:** Коммит `feat(engine): norm bands and level steps for the result assessment`, пуш.

---

### Task 2: История блоков по вариантам

**Files:**
- Create: `src/session/blockHistory.ts`, `src/session/blockHistory.test.ts`

**Interfaces:**
- Consumes: `NormId` (Task 1); `displayedCost` (`session/steps.ts`); `isCountedSession` (`engine/derive.ts`); `MEMORY_TRIALS` (`modules/memory/params.ts`); `BlockRow` (`data/rows.ts`); `block`, `session` из `data/repository.contract.ts` в тестах.
- Produces:
  ```ts
  export type VariantKey = string;          // 'pzmr', 'gorbov:alternate', 'schulte:6', 'memory:digits'
  export interface KeyMetric { unit: 'мс' | 'с' | '%'; better: 'lower' | 'higher'; signed: boolean }
  export const KEY_METRICS: Readonly<Record<ModuleId, KeyMetric>>;
  export interface NormSample { id: NormId; value: number }
  export interface HistoryEntry { at: string; value: number; L: number; length: number | null; norms: NormSample[] }
  export type BlockHistory = Map<VariantKey, HistoryEntry[]>;
  export type HistoryRow = Pick<BlockRow, 'sessionId' | 'module' | 'lBefore' | 'flags' | 'startedAt' | 'paramsJson' | 'summaryJson'>;
  export function variantOf(row: Pick<BlockRow, 'module' | 'paramsJson' | 'summaryJson'>): VariantKey | null;
  /** Rounded as shown (Справочник «История»); null: no number. */
  export function keyMetric(row: Pick<BlockRow, 'module' | 'summaryJson'>): number | null;
  /** The norms that apply to the block, key metric first (Справочник «Нормы», «Когда применять»). */
  export function normSamples(row: Pick<BlockRow, 'module' | 'lBefore' | 'paramsJson' | 'summaryJson'>): NormSample[];
  export function entersHistory(flags: readonly BlockFlag[], kind: SessionKind): boolean;
  /** null: no variant or no number. */
  export function historyEntry(row: HistoryRow): HistoryEntry | null;
  export function appendBlock(history: BlockHistory, row: HistoryRow, kind: SessionKind): void;
  export function buildBlockHistory(blocks: readonly HistoryRow[], sessions: readonly { id: string; kind: SessionKind }[]): BlockHistory;
  export interface HistoryStats { last: HistoryEntry; best: number; mean7d: number | null; best30d: number | null }
  export function historyStats(entries: readonly HistoryEntry[], now: Date, better: 'lower' | 'higher'): HistoryStats | null;
  export function mainVariant(module: ModuleId, history: BlockHistory): VariantKey | null;
  ```

- [ ] **Step 1: Написать падающие тесты** `blockHistory.test.ts`. Общие помощники: `NOW = new Date('2026-10-15T12:00:00.000Z')`, `ago(d)` — ISO-строка на `d` суток раньше; `table(task, timeMs, over)` — блок Горбова через `block(...)` с `paramsJson` `{ task, timeLimitMs, reshuffleEvery, size: 7 }` и `summaryJson` `{ score, timeMs, errors, correct, completed, task }`.
  - `variantOf`: `pzmr` → `'pzmr'`; Горбов с `summaryJson.task = 'alternate'` → `'gorbov:alternate'`; без `task` в итогах, но с `paramsJson.task = 'red_down'` → `'gorbov:red_down'`; ни там, ни там → `null`; Шульте `paramsJson.size = 6` → `'schulte:6'`, `size: 'x'` → `null`; память `mode: 'digits'` → `'memory:digits'`, `mode: 'xx'` → `null`; `summaryJson: 'not json'` у памяти → `null`.
  - `keyMetric`:
    ```ts
    expect(keyMetric({ module: 'pzmr', summaryJson: '{"meanRt":287.6}' })).toBe(288);
    expect(keyMetric({ module: 'rdo', summaryJson: '{"meanAbsErrorMs":18.4}' })).toBe(18);
    expect(keyMetric({ module: 'gorbov', summaryJson: '{"timeMs":48240}' })).toBe(48.2);
    expect(keyMetric({ module: 'gorbov', summaryJson: '{"timeMs":null}' })).toBeNull();
    const cond = (fast: string, slow: string, f: number, s: number) => JSON.stringify({ conditions: { [fast]: { medianRt: f }, [slow]: { medianRt: s } } });
    expect(keyMetric({ module: 'stroop', summaryJson: cond('congruent', 'incongruent', 520.5, 610) })).toBe(89);
    expect(keyMetric({ module: 'taskswitch', summaryJson: cond('repeat', 'switch', 600, 588) })).toBe(-12);
    expect(keyMetric({ module: 'pomeh', summaryJson: cond('quiet', 'noisy', 300, 335.2) })).toBe(35);
    expect(keyMetric({ module: 'stroop', summaryJson: '{"meanRt":500}' })).toBeNull();          // written before 46fca3b
    expect(keyMetric({ module: 'memory', summaryJson: JSON.stringify({ mode: 'digits', length: 7, exact: 4, answers: [1, 2, 3, 4, 5, 6] }) })).toBe(67);
    expect(keyMetric({ module: 'numseries', summaryJson: '{"correct":7,"total":10}' })).toBe(70);
    for (const bad of ['', 'null', '[]', '{"meanRt":"300"}']) expect(keyMetric({ module: 'pzmr', summaryJson: bad })).toBeNull();
    ```
  - `normSamples`:
    - ПЗМР `{ meanRt: 262.4, sdRt: 50.2 }` → `[{ id: 'pzmrMean', value: 262 }, { id: 'pzmrSd', value: 50 }]`;
    - СЗМР `lBefore 7.5`, `meanRt 401.6` → `[{ id: 'szmrMean', value: 402 }]`; `lBefore 8` → `[]`;
    - Горбов `black_up` 44 000 мс → `[{ id: 'gorbovSimple', value: 44 }]`; `alternate` 150 240 → `[{ id: 'gorbovAlternate', value: 150.2 }]`; незаконченный → `[]`;
    - память `digits`, `length 7`, 6 ответов, `exact 4` → `[{ id: 'memorySpan', value: 7 }]`; `exact 3` → `[]`; режим `letters` → `[]`; 3 ответа и `exact 3` → `[]`;
    - протокол объёма `{ protocol: 'span', mode: 'digits', span: 8, … }` → `[{ id: 'memorySpan', value: 8 }]`;
    - РДО и Струп → `[]`.
  - `entersHistory`: `([], 'training')`, `([], 'free')`, `(['fatigued'], 'training')`, `(['calibration'], 'free')` → true; `([], 'diagnostic')`, `(['overload'], 'training')`, `(['timing_unreliable'], 'free')` → false.
  - `buildBlockHistory groups training and free blocks by variant, in order`. Сессии `t` (training), `f` (free), `d` (diagnostic). Блоки:
    1. `table('alternate', 150_000, { lBefore: 11, startedAt: ago(9) })`;
    2. `table('black_up', 44_000, { startedAt: ago(9) })`;
    3. `table('alternate', 140_520, { sessionId: 'f', lBefore: 12, startedAt: ago(2), flags: ['fatigued'] })`;
    4. `alternate` в сессии `d`; 5. с `['overload']`; 6. с `['timing_unreliable']`; 7. `alternate` с `timeMs: null`; 8. `alternate` в неизвестной сессии.

    Ожидание:
    ```ts
    expect(h.get('gorbov:alternate')).toEqual([
      { at: ago(9), value: 150, L: 11, length: null, norms: [{ id: 'gorbovAlternate', value: 150 }] },
      { at: ago(2), value: 140.5, L: 12, length: null, norms: [{ id: 'gorbovAlternate', value: 140.5 }] },
    ]);
    expect(h.get('gorbov:black_up')?.map((e) => e.value)).toEqual([44]);
    expect([...h.keys()].sort()).toEqual(['gorbov:alternate', 'gorbov:black_up']);
    ```
  - `damaged and old rows are skipped, never thrown on`: ПЗМР с `'not json'` и с `'{"meanRt":"300"}'`, Струп без `conditions`, память с `mode 'xx'`, Горбов без `task` → `buildBlockHistory(...).size === 0`.
  - `unfinished tables have no number`: `historyEntry(table('alternate', null))` → `null`.
  - `memory entries keep the row length`: память `digits`, `length 7`, `exact 4` из 6 → запись `{ value: 67, length: 7, norms: [{ id: 'memorySpan', value: 7 }] }`.
  - `appendBlock adds a block exactly as buildBlockHistory does`: история двух первых блоков + `appendBlock(h, третий, 'free')` равна `buildBlockHistory` всех трёх; `appendBlock(h, блок, 'diagnostic')` историю не меняет.
  - `historyStats`:
    ```ts
    const e = (d: number, value: number, L = 10): HistoryEntry => ({ at: ago(d), value, L, length: null, norms: [] });
    const entries = [e(20, 41.0, 10), e(6, 42.4, 11), e(1, 48.2, 11)];
    const s = historyStats(entries, NOW, 'lower');
    expect(s).toMatchObject({ last: entries[2], best: 41, best30d: 41 });
    expect(s?.mean7d).toBeCloseTo(45.3, 9);
    expect(historyStats([e(3, 60), e(2, 70), e(1, 50)], NOW, 'higher')?.best).toBe(70);
    expect(historyStats([e(40, 30), e(10, 45)], NOW, 'lower')).toMatchObject({ best: 30, best30d: 45, mean7d: null });
    expect(historyStats([{ ...e(1, 10), at: 'garbage' }], NOW, 'lower')).toMatchObject({ best: 10, mean7d: null, best30d: null });
    expect(historyStats([], NOW, 'lower')).toBeNull();
    ```
  - `mainVariant`: `gorbov` → `'gorbov:alternate'`; `memory` → `'memory:digits'`; `pzmr` → `'pzmr'`; Шульте с записями `schulte:5` и `schulte:7` → `'schulte:7'`; Шульте без записей → `null`.
- [ ] **Step 2:** Запустить `npx vitest run src/session/blockHistory.test.ts`. Ожидается FAIL.
- [ ] **Step 3:** Реализовать по «Справочнику» («История», «Нормы»). Разбор JSON — в `try`, затем проверка: объект (не массив), поля — конечные числа или строки из списка. `appendBlock` — единственное место, где запись попадает в историю; `buildBlockHistory` вызывает его в цикле.
- [ ] **Step 4:** Запустить тест и гейт. Ожидается PASS.
- [ ] **Step 5:** Коммит `feat(session): block history by variant`, пуш.

---

### Task 3: Оценка блока — ступень, цель, норма, история

**Files:**
- Create: `src/session/assessment.ts`, `src/session/assessment.test.ts`
- Modify: `src/modules/describe.ts` (сюда переезжает `changeText`), `src/modules/describe.test.ts`, `src/ui/views/BlockSummary.tsx` (импорт `changeText`), `src/ui/views/BlockSummary.test.tsx` (тест `changeText` уходит в `describe.test.ts`)

**Interfaces:**
- Consumes: Task 1 (`NORMS`, `gradeByBands`, `cutText`, `NORM_HINTS`, `levelStep`, `ratingStep`, `stepName`, `R_FORMAT`); Task 2 (`BlockHistory`, `HistoryEntry`, `NormSample`, `KEY_METRICS`, `variantOf`, `keyMetric`, `normSamples`, `entersHistory`, `historyStats`); `describeChanges`; `L_NORM`; `signedMs` (`session/steps.ts`); `FAMILIES`; `R0`, `Rating`.
- Produces:
  ```ts
  // src/modules/describe.ts (moved from BlockSummary.tsx, unchanged body)
  export function changeText(c: ParamChange): string;
  // src/session/assessment.ts
  export interface BlockAssessment { step: string | null; goal: string | null; norms: string[]; history: string | null }
  export interface AssessContext {
    kind: SessionKind;
    /** Before this block; null: it could not be read (no history line, О10). */
    history: BlockHistory | null;
    now: Date;
    /** Number series in training and free sessions: meanFamilyRating after the block; null otherwise. */
    meanRating: number | null;
  }
  export function assessBlock(row: BlockRow, ctx: AssessContext): BlockAssessment;
  export function meanFamilyRating(ratings: ReadonlyMap<FamilyId, Rating>): number;
  export function normLine(sample: NormSample): string;
  export function formatMetric(module: ModuleId, value: number): string;
  ```
  Задача Горбова для `describeChanges` берётся из варианта строки (`gorbov:{task}`).

- [ ] **Step 1: Перенести `changeText`.** Тест `changeText` из `BlockSummary.test.tsx` переходит в `describe.test.ts` без изменений; `BlockSummary.tsx` импортирует функцию из `modules/describe`. Запустить `npx vitest run src/modules/describe.test.ts src/ui/views/BlockSummary.test.tsx` → PASS.
- [ ] **Step 2: Написать падающие тесты** `assessment.test.ts`. Помощники: `NOW`, `ago`, `e(...)` — как в Task 2; `gorbovRow(task, L0, L1, timeMs, over?)` — блок Горбова с `paramsJson` `{ task, ...gorbovParams(L0, task) }`; история `H = new Map([['gorbov:black_up', [e(20, 41.0, 10), e(6, 42.4, 11), e(1, 48.2, 11)]]])`; `ctx = { kind: 'training', history: H, now: NOW, meanRating: null }`.
  ```ts
  it('the spec example: Gorbov black_up at level 13,5', () => {
    expect(assessBlock(gorbovRow('black_up', 13, 13.5, 44_000), ctx)).toEqual({
      step: 'Ступень 3 из 5+ — формат теста (уровень 13,5; формат теста — 12)',
      goal: 'До ступени 4 «сверх нормы»: уровень 17 (+3,5). Там: лимит времени: 39 → 29 с; перемешивание: нет → каждые 9 верных',
      norms: ['Норма (ориентир): 44,0 с — средний; выше среднего — до 37 с. Бумажная методика, источник не указан'],
      history: 'Раньше в этом блоке: прошлый раз 48,2 с (ур. 11) · лучший 41,0 с · в среднем за 7 дней 45,3 с — лучше прошлого раза',
    });
  });
  it('a new best is marked; an equal result in shown rounding is not', () => {
    expect(assessBlock(gorbovRow('black_up', 13, 13.5, 40_000), ctx).history).toMatch(/ — новый лучший результат$/);
    expect(assessBlock(gorbovRow('black_up', 13, 13.5, 48_240), ctx).history).toBe(
      'Раньше в этом блоке: прошлый раз 48,2 с (ур. 11) · лучший 41,0 с · в среднем за 7 дней 45,3 с');
  });
  it('an unfinished table: step and history, no mark, no norm', () => {
    const a = assessBlock(gorbovRow('black_up', 13, 13, null), ctx);
    expect(a.norms).toEqual([]);
    expect(a.history).toBe('Раньше в этом блоке: прошлый раз 48,2 с (ур. 11) · лучший 41,0 с · в среднем за 7 дней 45,3 с');
    expect(a.step).toBe('Ступень 3 из 5+ — формат теста (уровень 13; формат теста — 12)');
  });
  it('the first block of a variant, and a history that could not be read', () => {
    expect(assessBlock(gorbovRow('red_down', 0, 2, 70_000), ctx).history).toBe('Первый такой блок — будет с чем сравнивать');
    expect(assessBlock(gorbovRow('black_up', 13, 13.5, 44_000), { ...ctx, history: null }).history).toBeNull();
  });
  ```
  Ещё тесты, у каждого — точные строки из «Справочника»:
  - `overload: played level, no goal, no mark`: `gorbovRow('alternate', 17, 17, 100_000, { flags: ['overload'] })`, история `gorbov:alternate` = `[e(1, 140.5, 12)]` →
    `step` «Ступень 4 из 5+ — сверх нормы (уровень 17; формат теста — 12; перегрузка)», `goal` `null`,
    `norms` `['Норма (ориентир): 100,0 с — высокий. Бумажная методика, источник не указан']`,
    `history` «Раньше в этом блоке: прошлый раз 140,5 с (ур. 12) · лучший 140,5 с · в среднем за 7 дней 140,5 с» (без отметки).
  - `timing_unreliable gets no mark`: ПЗМР `{ meanRt: 250, sdRt: 40 }`, флаг `timing_unreliable`, история `pzmr` = `[e(1, 300, 5)]` → строка истории заканчивается на «в среднем за 7 дней 300 мс».
  - `diagnostic: norms only`: ПЗМР `lBefore 0`, `lAfter 0`, `{ meanRt: 262.4, sdRt: 50.2 }`, `kind: 'diagnostic'` →
    ```ts
    { step: null, goal: null, history: null, norms: [
      'Норма (ориентир), среднее: 262 мс — средний; выше среднего — меньше 234 мс. Мальцев 2026, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
      'Норма (ориентир), разброс (SD): 50 мс — средний; выше среднего — меньше 45 мс. Мальцев 2026, юноши 18–21, аппаратная кнопка' ] }
    ```
  - `diagnostic Gorbov run 2`: `red_down`, 52 000 мс, `kind: 'diagnostic'` → `norms` `['Норма (ориентир): 52,0 с — ниже среднего; средний — до 50 с. Бумажная методика, источник не указан']`.
  - `СЗМР gets the 2-choice norm only below level 8`: `lBefore 7.5`, `meanRt 401.6` → «Норма (ориентир), среднее: 402 мс — ниже среднего; средний — до 382 мс. Мальцев 2026, выбор из 2, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру»; при `lBefore 8` → `norms` `[]`.
  - `memory: the span norm from 4 exact of 6; the history shows the row length`: `digits`, `lBefore 9`, `lAfter 9.5`, `length 7`, `exact 5`, 6 ответов; история `memory:digits` = `[{ at: ago(2), value: 67, L: 9, length: 7, norms: [] }]` → `toMatchObject`:
    `norms` `['Норма (ориентир), объём: 7 — средний; выше среднего — от 8. Woods 2011, молодые взрослые, слуховое предъявление']`,
    `history` «Раньше в этом блоке: прошлый раз 67 % (ряд 7, ур. 9) · лучший 67 % · в среднем за 7 дней 67 % — новый лучший результат».
  - `differences are signed`: Струп, `lBefore 6`, условия 500 и 570; история `stroop` = `[e(3, 40, 5), e(1, 85, 6)]` →
    `history` «Раньше в этом блоке: прошлый раз +85 мс (ур. 6) · лучший +40 мс · в среднем за 7 дней +63 мс — лучше прошлого раза»,
    `norms` `[NORM_HINTS.stroop]`.
  - `number series: steps by the mean family rating`: ряды `{ correct: 7, total: 10 }`, `kind: 'free'`, `meanRating: 1180.4`, история пустая →
    `{ step: 'Ступень 2 из 5+ — на подходе к формату теста (рейтинг 1180; формат теста — 1376)', goal: 'До ступени 3 «формат теста»: рейтинг 1376 (+196)', norms: [], history: 'Первый такой блок — будет с чем сравнивать' }`.
  - `no ceiling: step 6 of ПЗМР`: `lAfter 30` → `step` «Ступень 6 — далеко сверх нормы (уровень 30; формат теста — 14)», `goal` «До ступени 7 «далеко сверх нормы»: уровень 34 (+4). Там: окно ответа: 168 → 161 мс».
  - `hints`: Go/No-Go → `[NORM_HINTS.gonogo]`; переключение → `[NORM_HINTS.taskswitch]`; Шульте `size 5` → `[NORM_HINTS.schulte5]`, `size 6` → `[]`; РДО и помехоустойчивость → `[]`.
  - `meanFamilyRating`: пустая карта → 1000; `{ arith: { rating: 1400, n: 30 } }` → 1050.
  - `formatMetric`: `('gorbov', 44)` → «44,0 с»; `('stroop', 85)` → «+85 мс»; `('taskswitch', -12)` → «−12 мс»; `('pomeh', 0)` → «0 мс»; `('pzmr', 262)` → «262 мс»; `('memory', 67)` → «67 %».
- [ ] **Step 3:** Запустить `npx vitest run src/session/assessment.test.ts`. Ожидается FAIL.
- [ ] **Step 4:** Реализовать по «Справочнику» («Оценка после блока», «История»). Текущее значение и его нормы берутся теми же `keyMetric` и `normSamples`, что и записи истории. Подсказка — по варианту, если у блока нет ни одной полосной нормы.
- [ ] **Step 5:** Запустить тесты и гейт. Ожидается PASS.
- [ ] **Step 6:** Коммит `feat(session): block assessment (step, goal, norm, history)`, пуш.

---

### Task 4: Оценка на экране итога блока (контроллер и `BlockSummary`)

**Files:**
- Modify: `src/session/steps.ts`, `src/session/controller.ts`, `src/ui/views/BlockSummary.tsx`, `src/ui/theme.css` (класс `.assessment`, если нужен отступ)
- Test: `src/session/controller.test.ts`, `src/ui/views/BlockSummary.test.tsx`

**Interfaces:**
- Consumes: `assessBlock`, `meanFamilyRating`, `BlockAssessment` (Task 3); `buildBlockHistory`, `appendBlock`, `BlockHistory` (Task 2).
- Produces:
  ```ts
  // steps.ts
  BlockSummaryView.assessment?: BlockAssessment;
  // controller.ts (private)
  history: BlockHistory | null;                     // null: a diagnostic, or the read failed (О10)
  FinishedBlock.meanRating?: number;                // number series in training and free sessions
  ```
  - Журнал при ошибке чтения: `errorLogRow(at, 'session: block history could not be read', { error })`. Если журнал тоже не пишется, ошибка проглатывается (как у `earlierDiagnostics`).
  - Разметка: после списка «Показатели» — `<section className="assessment">` с `<h3>Оценка</h3>` и `<ul aria-label="Оценка">`. Строки в порядке «Справочника»; `null` пропускается; раздела нет, если `assessment` нет или все строки пусты.

- [ ] **Step 1: Написать падающие тесты контроллера** (`controller.test.ts`):
  - `summary view of a perfect first block` — ожидаемый `view` дополняется:
    ```ts
    assessment: {
      step: 'Ступень 1 из 5+ — начальная (уровень 2; формат теста — 14)',
      goal: 'До ступени 2 «на подходе к формату теста»: уровень 7 (+5). Там: окно ответа: 808 → 497 мс',
      norms: [
        'Норма (ориентир), среднее: 300 мс — низкий; ниже среднего — до 277 мс. Мальцев 2026, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
        'Норма (ориентир), разброс (SD): 0 мс — высокий. Мальцев 2026, юноши 18–21, аппаратная кнопка',
      ],
      history: 'Первый такой блок — будет с чем сравнивать',
    },
    ```
  - `the next block of the variant compares with the one before it`: `planFree('rdo', 1)`, два блока (`playReaction`, `continueAfterSummary`). У первого `history` — «Первый такой блок — будет с чем сравнивать», у второго совпадает с `/^Раньше в этом блоке: прошлый раз \d+ мс \(ур\. 0\) · лучший \d+ мс · в среднем за 7 дней \d+ мс/`.
  - `history from earlier sessions is read at session start`: в репозитории free-сессия вчера и блок РДО (`lBefore 3`, `summaryJson` `{"meanAbsErrorMs":25}`) → у первого блока новой free-сессии РДО `history` начинается с «Раньше в этом блоке: прошлый раз 25 мс (ур. 3) · лучший 25 мс».
  - `a history read failure is logged and the session runs without a history line`: `vi.spyOn(repo, 'listBlocks').mockRejectedValueOnce(new Error('disk I/O error'))` → первый шаг `instruction`; в журнале запись `error` с «block history could not be read» и «disk I/O error» в `detail`; у первого итога `assessment.history === null`, а `assessment.step` не `null`.
  - `an abandoned block does not enter the history` — дополнить тест `abandonPending drops an unsaved block…`: у третьего блока (L 2) `view.assessment?.history === 'Раньше в этом блоке: прошлый раз 300 мс (ур. 0) · лучший 300 мс · в среднем за 7 дней 300 мс'`. Будь сброшенный блок 2 в истории, было бы «(ур. 2)».
  - `a diagnostic reads no block history; its summaries carry norms only`: `SpyRepo` из теста R26 вынести на уровень файла; после всей диагностики `planDiagnostic(1)` (масштаб 0.02) `listBlocksCalls === 0`. У первого итога (ПЗМР) `step`, `goal`, `history` — `null`, в `norms` две строки, начинающиеся с «Норма (ориентир), среднее:» и «Норма (ориентир), разброс (SD):».
  - `number series in free training show the step by rating`: `planFree('numseries', 1)` с `perfectSeriesAnswers` → `assessment.step` совпадает с `/^Ступень \d( из 5\+)? — .+ \(рейтинг \d+; формат теста — 1376\)$/`.
  - Тест R26 переименовать в `state writes never read the whole block history (R26); it is read once at session start (О11)`. Число `listBlocksCalls` сразу после `begin` равно числу после `drive` той же сессии; после двух дней — 2.
- [ ] **Step 2: Написать падающие тесты** `BlockSummary.test.tsx`:
  - `shows the assessment in order under the metrics`: `assessment` `{ step: 'S', goal: 'G', norms: ['N1', 'N2'], history: 'H' }` → заголовок «Оценка»; элементы списка «Оценка» — `['S', 'G', 'N1', 'N2', 'H']`; список «Оценка» стоит после списка «Показатели» (`compareDocumentPosition`).
  - `leaves out empty lines; no section without an assessment`: `{ step: null, goal: null, norms: ['N1'], history: null }` → один элемент; без `assessment` и при всех пустых строках нет ни списка «Оценка», ни заголовка.
- [ ] **Step 3:** Запустить `npx vitest run src/session/controller.test.ts src/ui/views/BlockSummary.test.tsx`. Ожидается FAIL.
- [ ] **Step 4: Реализовать.**
  - `start()`: для тренировки и свободной тренировки, вместе с остальными чтениями, — `listBlocks()` и `listSessions()`, затем `buildBlockHistory`. Ошибка → журнал, `history = null`. Диагностика историю не читает.
  - `submitNumSeries`: при `counted` передаёт `meanRating: meanFamilyRating(ratings)`.
  - `completeBlock`: `assessment = assessBlock(row, { kind: this.plan.kind, history: this.history, now: this.now(), meanRating: b.meanRating ?? null })` до записей. Шаг `commit` после `record` вызывает `appendBlock(this.history, row, this.plan.kind)`, если история есть.
- [ ] **Step 5:** Запустить тесты и гейт. Ожидается PASS; e2e не меняются (раздел появляется внутри `.summary`, бот его не трогает).
- [ ] **Step 6:** `humanizer` по строкам «Справочника» (без правок без решения контролёра). Коммит `feat(session): assessment in the block summary`, пуш.

---

### Task 5: Средние ПЗМР и СЗМР в диагностике, сравнение на экране «Сессия завершена»

**Files:**
- Create: `src/session/diagnosticCompare.ts`, `src/session/diagnosticCompare.test.ts`
- Modify: `src/engine/diagnostic.ts`, `src/engine/readiness.ts` (`mergedBaseline`), `src/session/blocks.ts` (`diagnosticResults`), `src/session/steps.ts`, `src/session/controller.ts`, `src/ui/views/Done.tsx`, `src/ui/screens/Session.tsx`
- Test: `src/engine/diagnostic.test.ts`, `src/engine/readiness.test.ts`, `src/session/blocks.test.ts`, `src/session/controller.test.ts`, `src/ui/views/Done.test.tsx`, `src/ui/screens/Session.test.tsx`; литералы `DiagnosticMetrics`/`DiagnosticResults`, которые `tsc` покажет (property-тест `readiness`, `Done.test`, `Session.test`, ожидание диагностики в `controller.test` и `blocks.test`), получают два новых поля.

**Interfaces:**
- Consumes: `NORMS`, `gradeByBands` (Task 1); `shownCost`, `signedMs`; `readinessOfLatest`; `parseResults`; `ruDate` (`ui/progressModel.ts`).
- Produces:
  ```ts
  // engine/diagnostic.ts — DiagnosticMetrics and EMPTY_METRICS gain (null in rows stored before 0.3.0):
  pzmrMeanRt: number | null;
  szmrMeanRt: number | null;
  // session/diagnosticCompare.ts
  export type DiagnosticRowId = 'pzmr' | 'szmr' | 'gonogo' | 'rdo' | 'gorbovV' | 'gorbovP' | 'gorbovPi' | 'numseries' | 'pomeh' | 'stroop' | 'taskswitch' | 'memory';
  export const DIAGNOSTIC_ROW_IDS: readonly DiagnosticRowId[];          // Done's order
  export function diagnosticValue(d: DiagnosticMetrics, id: DiagnosticRowId): number | null;
  export function diagnosticChange(id: DiagnosticRowId, now: number, before: number): string;
  export function diagnosticNorm(d: DiagnosticMetrics, id: DiagnosticRowId): string | null;
  // session/steps.ts
  export interface DiagnosticComparison {
    /** The diagnostic before this one in listDiagnostics order (by `at`, W2-R33); null: this is the first. */
    previous: { number: number; at: string; metrics: DiagnosticResults } | null;
    readiness: number | null;            // readinessOfLatest(earlier, this).overall
    readinessPrevious: number | null;    // readinessOfLatest(earlier without the last, the last).overall
  }
  done: { …; comparison: DiagnosticComparison | null }   // null: training, free, or earlier diagnostics unreadable (О9)
  // ui/views/Done.tsx
  DoneProps.comparison?: DiagnosticComparison | null;
  ```
  - `earlierDiagnostics` в контроллере хранит `{ number, at, metrics }` (строки, которые `parseResults` прочитал), а не только показатели. `indexDeferred` считается как раньше.
  - `Done` строит строки по `DIAGNOSTIC_ROW_IDS`; подписи и форматы значений прежние; «Прошлая» — те же форматы для `previous.metrics` (с пометкой «замер ненадёжен» по её `unreliable`; «из N» у рядов — по `seriesTotal` текущей).

- [ ] **Step 1: Падающие тесты показателей:**
  - `blocks.test.ts`: `diagnosticResults keeps the mean RTs of ПЗМР and СЗМР` — части с `summary.meanRt` 312,5 и 410 → `pzmrMeanRt 312.5`, `szmrMeanRt 410`; медианы как раньше.
  - `diagnostic.test.ts`: `old previous rows read their missing metrics as null` — строка 0.2.0 без новых ключей → `pzmrMeanRt` и `szmrMeanRt` равны `null`.
  - `readiness.test.ts`: `mergedBaseline takes the mean RTs from the first diagnostic that has them`. Мета-тест `BASELINE_METRICS are exactly…` не меняется: новые поля индекс не считает.
- [ ] **Step 2: Падающие тесты** `diagnosticCompare.test.ts`:
  ```ts
  const D = { ...EMPTY_METRICS, pzmrMedianRt: 251.4, pzmrMeanRt: 262.4, szmrMedianRt: 402, szmrMeanRt: 401.6, gonogoScore: 93.3,
    rdoMeanAbsErrorMs: 18.6, gorbov: { V: 41.25, P: 70.5, Pi: -12 }, numseriesCorrect: 14, pomehQuietRt: 300, pomehNoisyRt: 335.2,
    pomehDeltaMs: 35.2, stroopCongruentRt: 520.5, stroopIncongruentRt: 610, stroopInterferenceMs: 89.5, memorySpan: 7 };
  it('values as Done shows them', () => {
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticValue(D, id))).toEqual([251, 402, 93, 19, 41.3, 70.5, -12, 14, 35, 89, null, 7]);
    expect(diagnosticValue({ ...D, gorbov: null }, 'gorbovV')).toBeNull();
  });
  it('changes: 2 % or 5 ms is no change; the direction decides better or worse', () => {
    expect(diagnosticChange('pzmr', 251, 264)).toBe('−13 мс, лучше');
    expect(diagnosticChange('pzmr', 245, 250)).toBe('−5 мс, лучше');
    expect(diagnosticChange('pzmr', 246, 250)).toBe('без изменений');
    expect(diagnosticChange('szmr', 402, 398)).toBe('без изменений');
    expect(diagnosticChange('gonogo', 93, 90)).toBe('+3 %, лучше');
    expect(diagnosticChange('rdo', 19, 25)).toBe('−6 мс, лучше');
    expect(diagnosticChange('gorbovV', 41.3, 45)).toBe('−3,7 с, лучше');
    expect(diagnosticChange('gorbovP', 102, 100)).toBe('+2,0 с, хуже');
    expect(diagnosticChange('gorbovP', 101.9, 100)).toBe('без изменений');
    expect(diagnosticChange('gorbovPi', -12, -10)).toBe('−2,0 с, лучше');
    expect(diagnosticChange('numseries', 13, 12)).toBe('+1, лучше');
    expect(diagnosticChange('memory', 6, 7)).toBe('−1, хуже');
    expect(diagnosticChange('stroop', 90, 100)).toBe('−10 мс, лучше');
    expect(diagnosticChange('stroop', 3, 0)).toBe('без изменений');
  });
  it('the reference band: by the mean for ПЗМР and СЗМР, none for Π', () => {
    expect(DIAGNOSTIC_ROW_IDS.map((id) => diagnosticNorm(D, id))).toEqual([
      'по среднему 262 мс: средний', 'по среднему 402 мс: ниже среднего', null, null, 'средний', 'высокий', null, null, null, null, null, 'средний']);
    expect(diagnosticNorm({ ...D, pzmrMeanRt: null }, 'pzmr')).toBeNull();
  });
  ```
- [ ] **Step 3: Падающие тесты контроллера:**
  - `the done step compares with the previous diagnostic by date (W2-R33); both indexes come from readinessOfLatest`. В репозитории диагностика №2 с `at` 2026-10-01 и №1 с `at` 2026-10-05, вставлены в этом порядке; играется `planDiagnostic(3)`. Ожидание: `comparison.previous` = `{ number: 1, at: '2026-10-05T10:30:00.000Z', metrics: parseResults(row1) }`; `readiness` = `readinessOfLatest([m2, m1], done.diagnostic).overall`; `readinessPrevious` = `readinessOfLatest([m2], m1).overall`.
  - `the very first diagnostic`: `comparison` = `{ previous: null, readiness: readinessOfLatest([], d).overall, readinessPrevious: null }`.
  - Тест B9 (прошлые диагностики не читаются): дополнительно `done.comparison === null`.
  - `free session ends with done…` (строка 229): ожидаемый шаг получает `comparison: null`.
- [ ] **Step 4: Падающие тесты** `Done.test.tsx`. `RESULTS` получает `pzmrMeanRt: 262.4`, `szmrMeanRt: 401.6`. `PREVIOUS = { ...RESULTS, pzmrMedianRt: 263.6, pzmrMeanRt: null, szmrMedianRt: 398, szmrMeanRt: null, gonogoScore: 90, rdoMeanAbsErrorMs: 25, gorbov: { V: 45, P: 70, Pi: -10 }, numseriesCorrect: 12, stroopCongruentRt: 500, stroopIncongruentRt: 600, stroopInterferenceMs: 100, switchRepeatRt: null, switchSwitchRt: null, switchCostMs: null }`, `at '2026-10-12T09:00:00'`, `number 3`.
  - `with a previous diagnostic: Прошлая, Изменение, Ориентир`. `comparison` `{ previous: PREVIOUS, readiness: 72.4, readinessPrevious: 65.2 }`. Заголовки: `['Показатель', 'Результат', 'Прошлая (№3, 12.10.2026)', 'Изменение', 'Ориентир']`. Ячейки:
    ```ts
    [['ПЗМР — медиана времени реакции', '251 мс', '264 мс', '−13 мс, лучше', 'по среднему 262 мс: средний'],
     ['Сложная реакция (СЗМР) — медиана времени реакции', '402 мс', '398 мс', 'без изменений', 'по среднему 402 мс: ниже среднего'],
     ['Go/No-Go — верные ответы', '93 %', '90 %', '+3 %, лучше', '—'],
     ['Реакция на движущийся объект — средняя ошибка', '19 мс', '25 мс', '−6 мс, лучше', '—'],
     ['Горбов — V, среднее время 1-й и 2-й таблиц', '41,3 с', '45,0 с', '−3,7 с, лучше', 'средний'],
     ['Горбов — P, время 3-й таблицы', '70,5 с', '70,0 с', 'без изменений', 'высокий'],
     ['Горбов — Π, переключение внимания', '−12,0 с', '−10,0 с', '−2,0 с, лучше', '—'],
     ['Числовые ряды — решено верно', '14 из 20', '12 из 20', '+2, лучше', '—'],
     ['Помехоустойчивость — разница с помехами и без', '+35 мс', '+35 мс', 'без изменений', '—'],
     ['Струп — интерференция', '+90 мс', '+100 мс', '−10 мс, лучше', '—'],
     ['Переключение правил — цена переключения', '−12 мс', 'нет данных', '—', '—'],
     ['Память — объём', '7', '7', 'без изменений', 'средний']]
    ```
    Под таблицей текст «Индекс: 72 (прошлый — 65)».
  - `the first diagnostic says there is nothing to compare with`: `comparison` `{ previous: null, readiness: 60, readinessPrevious: null }` → «Первая диагностика — сравнивать пока не с чем», «Индекс: 60»; заголовки `['Показатель', 'Результат', 'Ориентир']`; первая строка `['ПЗМР — медиана времени реакции', '251 мс', 'по среднему 262 мс: средний']`.
  - `a previous value that is missing reads «нет данных» and has no change` — строка «Переключение правил» выше. Отдельно: при `RESULTS.pzmrMeanRt = null` у ПЗМР ориентир «—».
  - `without a comparison: result and reference only, no index line` (тренировка или прошлые не прочитались): заголовки `['Показатель', 'Результат', 'Ориентир']`, нет «Индекс:» и «Первая диагностика». Существующий тест «lists the twelve diagnostic results» получает третью ячейку.
  - `Session.test.tsx`: шаги `done` в тестах получают `comparison: null`. Шаг диагностики с `comparison` передаёт его в `Done` (видна строка «Индекс: …»).
- [ ] **Step 5:** Запустить `npx vitest run src/engine src/session src/ui/views/Done.test.tsx src/ui/screens/Session.test.tsx`. Ожидается FAIL.
- [ ] **Step 6:** Реализовать по «Справочнику» («Итоги диагностики»). `diagnosticResults`: `pzmrMeanRt = summary.meanRt` у ПЗМР, `szmrMeanRt` у СЗМР. `mergedBaseline` перечисляет оба поля. `done()` собирает `comparison`, только если `earlierDiagnostics` прочитаны.
- [ ] **Step 7:** Запустить тесты и гейт. `runDiagnostic` в e2e ждёт 12 строк и ни одного «нет данных»: у первой диагностики колонки «Прошлая» нет, ориентир «—» — не «нет данных». Ожидается PASS.
- [ ] **Step 8:** `humanizer`. Коммит `feat(diagnostic): mean RTs and the comparison with the previous diagnostic`, пуш.

---

### Task 6: «Оценка по модулям» в «Прогрессе»

**Files:**
- Modify: `src/session/assessment.ts`, `src/ui/progressModel.ts`, `src/ui/screens/Progress.tsx`
- Test: `src/session/assessment.test.ts`, `src/ui/progressModel.test.ts`, `src/ui/screens/Progress.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 (`levelStep`, `ratingStep`, `R_FORMAT`, `gradeByBands`, `NORMS`, `buildBlockHistory`, `historyStats`, `mainVariant`, `KEY_METRICS`, `formatMetric`, `meanFamilyRating`); `ModuleState`; `L_NORM`; `moduleTitles`; `rebuildCaches` (тесты).
- Produces:
  ```ts
  // session/assessment.ts
  export interface ModuleAssessment { module: ModuleId; title: string; step: string; lastBest: string; norm: string; goal: string }
  export function assessModules(o: {
    states: Readonly<Record<ModuleId, ModuleState>>;
    meanRating: number;
    history: BlockHistory;
    now: Date;
  }): ModuleAssessment[];                                  // MODULE_IDS order
  // ui/progressModel.ts
  ProgressModel.assessment: ModuleAssessment[];
  export async function loadProgressModel(repo: Repository, now?: Date): Promise<ProgressModel>;   // now defaults to new Date()
  ```
  `loadProgressModel` читает `listBlocks()` и `getRatings()` вместе с прежними чтениями. Число блоков по сессиям («История сессий») считается по `listBlocks()`, отдельные `listBlockLevels` здесь больше не нужны.

- [ ] **Step 1: Падающие тесты** `assessment.test.ts` (`describe('assessModules')`). История — из строк через `buildBlockHistory` (сессия `t`, training), состояния — `defaultModuleState` с переопределениями.
  - `untrained modules: a dash and «ещё не тренировался»`: все состояния по умолчанию → 11 строк в порядке `MODULE_IDS`; строка ПЗМР: `{ module: 'pzmr', title: 'ПЗМР', step: '—', lastBest: 'ещё не тренировался', norm: '—', goal: '—' }`.
  - `Gorbov: alternation is the main variant; best of 30 days`: состояние `{ lSaved: 13.5, lifetimeBlocks: 9 }`; блоки `alternate` 120 000 мс 40 суток назад, 150 240 мс 10 суток назад, 140 520 мс сутки назад →
    `{ module: 'gorbov', title: 'Красно-чёрные таблицы Горбова — чередование', step: '3 — формат теста (ур. 13,5; формат теста — 12)', lastBest: '140,5 с / 140,5 с', norm: 'выше среднего', goal: 'ур. 17 (+3,5)' }`.
  - `number series by the mean rating`: `meanRating 1180.4`, `lifetimeBlocks 3`, блок рядов `{ correct: 7, total: 10 }` →
    `{ title: 'Числовые ряды', step: '2 — на подходе к формату теста (рейтинг 1180; формат теста — 1376)', lastBest: '70 % / 70 %', norm: '—', goal: 'рейтинг 1376 (+196)' }`.
  - `Шульте: the largest finished grid`: блоки `size 5` (31 000 мс), `size 6` (58 000 мс), незаконченный `size 7`; `{ lSaved: 8, lifetimeBlocks: 4 }` →
    `{ title: 'Таблицы Шульте — 6×6', step: '3 — формат теста (ур. 8; формат теста — 6)', lastBest: '58,0 с / 58,0 с', goal: 'ур. 11 (+3)' }`.
  - `trained, but no finished block of the main variant`: Горбов `{ lifetimeBlocks: 2 }`, только `black_up` →
    `{ step: '1 — начальная (ур. 0; формат теста — 12)', lastBest: '—', norm: '—', goal: 'ур. 6 (+6)' }`.
  - `the last result outside 30 days`: ПЗМР `{ lifetimeBlocks: 1 }`, единственный блок 40 суток назад, `meanRt 262.4` → `lastBest: '262 мс / —'`, `norm: 'средний'`.
- [ ] **Step 2: Падающие тесты UI:**
  - `progressModel.test.ts`: `loadProgressModel builds the assessment from blocks, sessions, states and ratings`. MemoryRepository: free-сессия, блок ПЗМР (`summaryJson` `{ meanRt: 262.4, sdRt: 50 }`), `rebuildCaches(repo)`, фиксированный `now` → `model.assessment` равен `assessModules(...)` из тех же данных; строка ПЗМР: `lastBest '262 мс / 262 мс'`, `norm 'средний'`.
  - `Progress.test.tsx`: `«Оценка по модулям» comes right under the readiness index`. Порядок заголовков: «Индекс готовности» < «Оценка по модулям» < «Контрольные диагностики». В таблице «Оценка по модулям» 11 строк тела и заголовки `['Модуль', 'Ступень', 'Последний / лучший за 30 дней', 'Ориентир', 'Цель']`. У модуля без истории ячейка «ещё не тренировался». Под таблицей текст подписи из «Справочника».
- [ ] **Step 3:** Запустить `npx vitest run src/session/assessment.test.ts src/ui/progressModel.test.ts src/ui/screens/Progress.test.tsx`. Ожидается FAIL.
- [ ] **Step 4:** Реализовать по «Справочнику» («Оценка по модулям»). `Progress.tsx`: новая секция между `ReadinessBlock` и `Diagnostics`, таблица с классом `results`.
- [ ] **Step 5:** Запустить тесты и гейт. Ожидается PASS.
- [ ] **Step 6:** `humanizer`. Коммит `feat(progress): assessment by module`, пуш.

---

### Task 7: Индекс готовности — Π от собственной базы

**Files:**
- Modify: `src/engine/readiness.ts`, `src/ui/views/ReadinessBlock.tsx`, `docs/superpowers/specs/2026-10-14-trainer-design.md` (§7.5)
- Test: `src/engine/readiness.test.ts`, `src/ui/screens/Home.test.tsx`

**Interfaces:**
- Consumes: `diffScore`, `mergedBaseline`, `readinessOfLatest` (как есть).
- Produces:
  ```ts
  /** Π = t3 − (t1 + t2) is stored in seconds: 40 points per 20 s (20 000 ms, spec 2026-10-15 §4). */
  export const GORBOV_PI_SCALE_S = 20;
  // removed: BAND_GORBOV_P, BAND_GORBOV_PI
  ```
  Сигнатуры `readiness`, `readinessOfLatest`, `Readiness` не меняются.

- [ ] **Step 1: Переписать тесты** `readiness.test.ts` (числа — «Справочник», «Индекс готовности: Π»):
  - удалить проверки `BAND_GORBOV_P`/`BAND_GORBOV_PI` из `exports P and Pi bands…` (тест убрать) и их импорт;
  - `Π against its own baseline: 20 s faster gives 100, the same Π 60, 10 s slower 40`:
    ```ts
    const g = (Pi: number) => full({ gorbov: { V: 33, P: 70, Pi } });
    expect(readiness(g(4), g(24)).abilities.switching).toBe(100);
    expect(readiness(g(24), g(24)).abilities.switching).toBe(60);
    expect(readiness(g(34), g(24)).abilities.switching).toBe(40);
    expect(GORBOV_PI_SCALE_S).toBe(20);
    ```
  - `with baseline = latest…`: `switching` → 60; с показателями W2 — `(60 + 60) / 2` = 60;
  - `0.1.0 results…` переименовать в `0.1.0 results: W1 abilities, switching by the Π difference (§4)`: `switching` 100, `Math.round(overall)` 97; реакция 97, внимание 89, логика 100 — без изменений;
  - `scores Gorbov from bands even when…` → `V is scored from its band without a baseline; Π needs one`: `readiness(full(), full({ gorbov: null }))` → `switching` `null`, `attention` `(bandScore(33, BAND_GORBOV_V) + 60) / 2`;
  - `readinessOfLatest`: в тесте «first 0.2.0 diagnostic after 0.1.0 ones» `Math.round(r.overall)` → 97, а значение 81 для подсчёта без отсрочки остаётся;
  - новый `Π measured for the first time waits like any new part (W2-R31)`: `readinessOfLatest([full({ gorbov: null })], full())` → `deferred` true, `switching` `null`, в `attention` входит полоса V; `readinessOfLatest([], full()).abilities.switching` → 60.
- [ ] **Step 2:** `Home.test.tsx`: в обоих тестах с парой W1 «Переключение» `'100'` (было `'98'`), «Общий индекс: 97» (было 96); подпись — новая из «Справочника».
- [ ] **Step 3:** Запустить `npx vitest run src/engine/readiness.test.ts src/ui/screens/Home.test.tsx`. Ожидается FAIL.
- [ ] **Step 4:** Реализовать: `switching` по «Справочнику»; удалить две полосы; в `readinessOfLatest` — Π как часть с базой (свой код рядом с `BASELINE_METRICS`, мета-тест `BASELINE_METRICS` не меняется). Подпись в `ReadinessBlock.tsx`.
- [ ] **Step 5:** В основной спеке после отклонения W2-R31 в §7.5 добавить:
  > **Отклонение 2026-10-15 (оценка результатов, `docs/superpowers/specs/2026-10-15-assessment-design.md` §4):** Π таблицы Горбова в способности «Переключение» считается от собственной базы, как разности: `diffScore(Π, Π₀, 20 с)`; первая диагностика даёт 60, а впервые измеренная Π ждёт следующей диагностики (W2-R31). Полосы P и Π удалены: их нет ни в одном источнике. V остаётся на бумажной шкале как ориентир. Старые диагностики пересчитываются по новому правилу, индекс может сдвинуться: это исправление, а не регресс.
- [ ] **Step 6:** Запустить тесты и гейт (e2e проверяют индекс регулярным выражением). Ожидается PASS.
- [ ] **Step 7:** Коммит `fix(readiness): Gorbov Π against its own baseline (spec deviation 2026-10-15)`, пуш.

---

### Task 8: E2E, снимки экранов и визуальная проверка

**Files:**
- Modify: `tests/e2e/fixtures.ts` (сюда переезжает `shot`), `tests/e2e/screens.spec.ts`, `tests/e2e/flows.spec.ts`
- Modify (если проверка найдёт дефект): только код, который его вызвал; каждое исправление — отдельный коммит с тестом.

**Interfaces:**
- Consumes: разметка задач 4–6 (`list` «Оценка», таблица «Результаты диагностики», таблица «Оценка по модулям»).
- Produces: `export async function shot(page: Page, name: string, fullPage?: boolean): Promise<void>` в `fixtures.ts`; `screens.spec.ts` импортирует его оттуда.

- [ ] **Step 1: Потоки** (`flows.spec.ts`):
  - `free training of rdo` → `free training of rdo shows the assessment and compares with the previous session`. Две свободные сессии РДО подряд. В `onScreen` на `summary` собрать `page.getByRole('list', { name: 'Оценка' }).getByRole('listitem').allInnerTexts()`. Первый итог первой сессии: первая строка совпадает с `/^Ступень 1 из 5\+ — начальная \(уровень [\d,]+; формат теста — 10\)$/`, последняя — «Первый такой блок — будет с чем сравнивать». Первый итог второй сессии: последняя строка совпадает с `/^Раньше в этом блоке: прошлый раз \d+ мс \(ур\. [\d,]+\) · лучший \d+ мс/`. Прежние проверки теста остаются.
  - `diagnostic run writes results and home shows readiness`:
    - после первой диагностики виден текст «Первая диагностика — сравнивать пока не с чем»;
    - после второй: заголовок колонки совпадает с `/^Прошлая \(№1, \d\d\.\d\d\.\d{4}\)$/`; у всех 12 строк ячейка «Изменение» совпадает с `/^(без изменений|[+−][\d,]+( мс| с| %)?, (лучше|хуже))$/`; виден текст по `/^Индекс: \d+ \(прошлый — \d+\)$/`; `shot(page, 'done-diagnostic-compare')`.
  - `progress shows charts after a diagnostic`: в таблице «Оценка по модулям» 11 строк, у каждой «ещё не тренировался» (была только диагностика).
- [ ] **Step 2: Снимки** (`screens.spec.ts`, тест «a training session with pause, wellbeing and done; schulte»). После свободной сессии Шульте — вторая свободная сессия Шульте до итога. В разделе «Оценка» есть строка с «Раньше в этом блоке: прошлый раз» и `NORM_HINTS.schulte5` → `shot(page, 'summary-assessment')`. Доиграть, «На главную» → «Прогресс». В таблице «Оценка по модулям» строка «Таблицы Шульте — 5×5» с ячейкой по `/^\d+,\d с \/ \d+,\d с$/` → `shot(page, 'progress-assessment', true)`. Снимок итога ПЗМР в диагностике (`summary`) уже показывает две строки нормы.
- [ ] **Step 3:** Запустить `npm run e2e`. Ожидается PASS. Снимки статичных экранов не требуют повторов (стимулов нет).
- [ ] **Step 4: Визуальная проверка** по `stress-notes/70_Resources/Procedure_Frontend_Visual_QA.md`. Открыть (Read) `summary`, `summary-assessment`, `done-diagnostic`, `done-diagnostic-compare`, `progress-assessment` и проверить:
  - раздел «Оценка» читается, длинные строки переносятся, кнопка «Дальше» и «Enter — дальше» видны или доступны прокруткой (экран сессии прокручивается);
  - таблица с пятью колонками в «Сессия завершена» помещается в ширину без горизонтальной прокрутки, заголовок «Прошлая (№1, …)» и подписи строк не обрезаны;
  - таблица «Оценка по модулям» читается при 1280×800, числа выровнены;
  - кириллица, «—» и «−» отображаются, текст нигде не обрезан.

  Найденное исправить (тест + отдельный коммит) и повторить.
- [ ] **Step 5:** Гейт целиком. Коммит `test(e2e): assessment flows and screenshots`, пуш.

---

### Task 9: Руководство, CHANGELOG 0.3.0 (не выпущена), заметки, итоговое ревью

**Files:**
- Modify: `docs/USER_GUIDE.md`, `docs/CHANGELOG.md`
- Modify (репозиторий `stress-notes`, та же ветка): `30_Tech/Codebase_Map.md`, `40_Decisions/Decision_Log.md`, `10_Project/Current_Focus.md`

- [ ] **Step 1: `USER_GUIDE.md`** через `humanizer`:
  - новый раздел «## Оценка результатов» после «## Итоги блока»: три шкалы; ступени (таблица из пяти строк, «без потолка», ступени рядов по рейтингу и `R_format` 1376); нормы — таблица показателей с источником, условием и рейтингом надёжности из «Справочника», подсказки, модули без нормы; поправка на клавиатуру: «норма для аппаратной кнопки + 30 мс на клавиатуру» и почему (USB-клавиатура добавляет 20–40 мс); история: что такое вариант, какие блоки считаются, что значат «новый лучший результат» и «лучше прошлого раза»; где оценка видна: после блока, «Оценка по модулям» в «Прогрессе», сравнение на экране «Сессия завершена» (колонки, «без изменений» при разнице меньше 2 % или 5 мс, строка индекса);
  - «## Итоги блока»: одно предложение о разделе «Оценка»;
  - «## Индекс готовности»: Π — от первой диагностики, 40 баллов за 20 с; V — по бумажной шкале, это ориентир; старые диагностики пересчитаны, индекс мог сдвинуться; самая первая диагностика даёт 60 по всем показателям, кроме V.
- [ ] **Step 2: `CHANGELOG.md`** — раздел над 0.2.0:
  ```
  ## 0.3.0 — не выпущена
  ```
  Подразделы: «Оценка результатов» (раздел «Оценка» после блока, «Оценка по модулям» в «Прогрессе», сравнение с прошлой диагностикой и строка индекса, средние ПЗМР и СЗМР в диагностике) и «Индекс готовности» (Π от собственной базы, полосы P и Π удалены, новая подпись, старые диагностики пересчитываются).
- [ ] **Step 3: Полная проверка:** `npm run lint && npm run typecheck && npm run test:coverage && npm run e2e` зелёные, покрытие `src/engine` и `src/modules` 100 %. Пуш; статус CI посмотреть через GitHub MCP `actions_list`/`actions_get`, но локальный гейт главнее (W2-R19).
- [ ] **Step 4: Заметки** (`stress-notes`):
  - Codebase Map: `engine/norms.ts`, `engine/levelSteps.ts`, `session/blockHistory.ts`, `session/assessment.ts`, `session/diagnosticCompare.ts`; особенность — история блоков читается один раз при старте тренировки (О11);
  - Decision Log: решения О1–О18 кратко, со ссылкой на план;
  - Current Focus: оценка результатов готова в ветке, 0.3.0 не выпущена; следующий шаг — аудит логики тренировок.

  Коммит и пуш в `stress-notes`.
- [ ] **Step 5:** Коммит `docs: user guide and changelog for the result assessment (0.3.0, unreleased)`, пуш.
- [ ] **Step 6:** Независимое ревью всей ветки от `fa6efcf` свежим агентом (`superpowers:requesting-code-review`). Исправить найденное, повторить Step 3.

---

## Самопроверка плана

1. **Покрытие спеки.**
   - §2.1 ступени и цель → Task 1, 3.
   - §2.2 нормы, подсказки, поправка на клавиатуру → Task 1, 3, 9.
   - §2.3 вариант, какие блоки, ключевой показатель, строка истории → Task 2, 3.
   - §3.1 → Task 3, 4. §3.2 → Task 6. §3.3, включая `pzmrMeanRt`/`szmrMeanRt` → Task 5.
   - §4 → Task 7. §5 устройство → Tasks 1–6.
   - §6: юнит-тесты на каждую функцию — Tasks 1–7; тесты UI — Task 4, 5, 6; e2e и снимки — Task 8; руководство — Task 9.
   - Пробелов не найдено; спорные места — решения О1–О18.
2. **Шаги.** В каждом тестовом шаге есть имена тестов и проверки со значениями «Справочника». Кодовые шаги называют сигнатуры, файлы и значения; тел функций в плане нет, кроме точных текстов и чисел.
3. **Согласованность типов.** `VariantKey`, `HistoryEntry`, `BlockHistory`, `NormSample`, `historyStats`, `appendBlock` (Task 2) используются в Task 3, 4, 6 под теми же именами. `BlockAssessment` и `assessBlock(row, ctx)` (Task 3) — в Task 4. `DiagnosticComparison` (Task 5) — в `steps.ts`, `Done.tsx`, `Session.tsx`. `formatMetric` и `meanFamilyRating` (Task 3) — в Task 6. `NormId` (Task 1) — в Task 2.
4. **Review Focus.** У каждой из пяти строк есть тест в задаче, которой принадлежит код (Task 2, 3, 4, 5, 6).
5. **Соразмерность.** Спека — 185 строк, план длиннее за счёт «Справочника» с точными текстами и числами, которые иначе пришлось бы угадывать. Кода в плане — только проверки тестов и точные строки.
