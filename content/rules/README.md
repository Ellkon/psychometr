# content/rules/

JSON decision tables движка правил (FR-4): `safety.json`, `routing.json`,
`adherence.json` и эталонные сценарии в `__cases__/`.

**Статус (этап 1):** структура создана, файлы правил появятся на этапе 4.
Каждое правило обязано иметь `id`, `version`, `source` (запись в
`content/sources.json`), `severity`, `message`, `suggested_action`.
Правило без источника не принимается (AGENTS.md).
