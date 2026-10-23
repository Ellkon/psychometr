# content/rules/

Правила движка (FR-4, FR-5): JSON decision tables GoRules ZEN. Загрузчик и движок:
`apps/api/src/domain/rules.ts`. Контракт и схема: `packages/shared/src/rules.ts`.

**Статус (этап 4):** `routing.json` — заглушка без правил. Пороги маршрутизации не
согласованы клинически (ТЗ FR-5.2, раздел 12), поэтому статус маршрутизации —
`pending_clinical_agreement`. Клинических правил в продукте пока нет.

## Формат правила

Каждое правило обязано иметь:

- `id` — строка `^[a-z][a-z0-9_]{2,63}$`, уникальна во всех файлах;
- `version` — семвер `X.Y.Z`;
- `status` — `draft` (не вычисляется) или `active`;
- `severity` — `info`, `warning` или `critical`;
- `source_id` — id из `content/sources.json` (без источника правило не принимается,
  AGENTS.md); `source_location` — тезис, таблица или фрагмент, которым обоснован порог;
- `message` и `suggested_action` — текст дословно из источника или согласованный текст;
- `reviewed_at` — дата клинического согласования (`YYYY-MM-DD`). Для `active` обязательна;
- `decision` — JDM-граф ZEN с выходным полем `triggered` (логическое).

Схема строгая: лишние ключи отклоняются.

## Факты и `unknown`

Факты: `phq9_total`, `phq9_band`, `phq9_item9_positive`, `gad7_total`, `gad7_band`,
`pregnancy`, `renal_function`, `hepatic_function`, `concomitant_medications`.
Отсутствующее значение — строка `unknown`. Правило обязано учитывать её явно: сравнение
со строкой может давать `false`, а отрицание — `true`. Для отсутствующих сведений
(беременность, почки, печень, сопутствующие препараты) пока всегда `unknown`.

## Проверки

- `pnpm check:content` валидирует все файлы в `content/rules/` и ссылки на источники.
  Файл, не зарегистрированный в `VALIDATORS`, — ошибка.
- Для каждого файла правил должны быть тестовые случаи в `content/rules/__cases__/`
  (AGENTS.md). Пока файлов с правилами нет, каталог не создан.
