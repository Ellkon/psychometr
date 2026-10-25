# Резервное копирование и восстановление (S-10, NFR-4)

Инструмент — образ `psychometr-backup:local` (PostgreSQL 16 и `age`), сервис `backup` в профиле
`tools` файла `infra/docker-compose.yml`. Открытый дамп на диск не пишется: `pg_dump` идёт
потоком в `age`, при восстановлении `age -d` идёт потоком в `pg_restore`.

## Ключи

Создать пару ключей на машине, где хранится закрытый ключ (не на сервере с дампами):

```bash
docker run --rm -v "$PWD/keys:/k" --entrypoint age-keygen psychometr-backup:local -o /k/key.txt
```

В `.env` сервера указать только открытый ключ `AGE_RECIPIENT=age1…`. Закрытый ключ подключается
(`AGE_IDENTITY_PATH`) только на время восстановления.

## Команды

```bash
C="docker compose --env-file .env -f infra/docker-compose.yml --profile tools run --rm backup"
$C backup                                # /backups/compass-<UTC>.dump.age, права 0600
$C restore-verify compass-<UTC>.dump.age # восстановление во временную БД, сверка, RTO
$C restore compass-<UTC>.dump.age        # аварийное восстановление; API остановлен
```

Каталог дампов — `BACKUP_DIR` (по умолчанию `../backups`, в `.gitignore`). Каждая команда
печатает одну строку JSON без данных: файл, размер, SHA-256, длительность.

`restore-verify` создаёт БД со случайным именем, восстанавливает дамп, сравнивает число строк
в 13 основных таблицах с рабочей БД и удаляет временную БД при любом завершении или сигнале.

## Расписание и RPO

RPO равен интервалу между бэкапами. Для демонстрационного стенда — раз в час через cron хоста:

```cron
0 * * * * cd /srv/psychometr && docker compose --env-file .env -f infra/docker-compose.yml --profile tools run --rm backup backup >> /var/log/compass-backup.log 2>&1
```

Копии нужно выгружать в хранилище в РФ вне сервера (S-10). Это делается средствами хостинга
заказчика и в репозитории не настроено.

## Замеры (25.10.2026, docker compose на WSL2, синтетические данные)

| Операция                    | Объём                                                | Время             |
| --------------------------- | ---------------------------------------------------- | ----------------- |
| `backup`                    | 1,35 МБ (синтетические данные стенда после e2e и k6) | 0,47 с            |
| `restore-verify` (RTO)      | тот же дамп, сверка 13 таблиц                        | 1,75 с            |
| `backup` при недоступной БД | —                                                    | exit 1, файла нет |
| Расшифровка чужим ключом    | —                                                    | отказ `age`       |
