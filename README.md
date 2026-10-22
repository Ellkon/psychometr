# Клинический компас

PWA-ассистент врача для сопровождения терапии тревожных и депрессивных
расстройств: шкалы PHQ-9/GAD-7, дневник доз, правила безопасности терапии,
маршрутизация к психиатру, алерты.

Кейс-чемпионат «Цифровой ассистент врача» («Авинейро» / ГК «ХимРар», НМИЦ ПН
им. В. П. Сербского, Сеченовский Университет).

- Техническое задание — [`docs/TZ.md`](docs/TZ.md) (источник истины по продукту)
- Правила для разработчиков и агентов — [`AGENTS.md`](AGENTS.md)
- Модель угроз — [`SECURITY.md`](SECURITY.md)

> Решение по диагностике и лечению принимает врач. Система не назначает
> терапию автоматически и не выдаёт off-label-рекомендаций.

## Структура

```
apps/api/          Fastify + TypeScript, REST + WebSocket
apps/web/          React 19 + Vite PWA
packages/shared/   zod-схемы и типы (общие для api и web)
content/           шкалы, препараты, правила, источники (JSON)
docs/              ТЗ, security-отчёты
infra/             docker compose, Caddy, скрипты бэкапа
e2e/               Playwright-сценарии
```

## Быстрый старт

```bash
corepack enable
pnpm install
pnpm dev              # api (localhost:3000) + web (localhost:5173)
```

Полный стек (PostgreSQL + api + web/Caddy, HTTPS на https://localhost:8443):

```bash
cp .env.example .env  # заполнить секреты; для демо работают dev-значения из compose
docker compose -f infra/docker-compose.yml up -d --build
```

## Команды

```bash
pnpm build            # сборка всех пакетов
pnpm test             # vitest во всех пакетах
pnpm test:e2e         # playwright (нужен запущенный стек, см. WEB_BASE_URL)
pnpm lint
pnpm typecheck
pnpm check:content    # валидация content/*.json против zod-схем
pnpm db:generate      # drizzle-kit generate
pnpm db:migrate
```

Перед тем как сообщить, что задача сделана: `pnpm lint && pnpm typecheck && pnpm test`.

## Статус

Идёт этап 1 (скелет monorepo, docker compose, CI с проверками безопасности).
План этапов — `docs/TZ.md` § 11.
