# aerio-agent (aerio-node-agent)

Агент на каждой VPN-ноде: замеряет канал до Cloudflare и доступность сервисов через geocheck, отправляет результаты в консоль `console.aerio.my` исходящим хартбитом.

[![docker.yml](https://github.com/wakeupmetha/aerio-node-agent/actions/workflows/docker.yml/badge.svg?branch=main)](https://github.com/wakeupmetha/aerio-node-agent/actions/workflows/docker.yml)

![aerio--agent](https://img.shields.io/badge/aerio--agent-0.2.1-555555)
![Node.js](https://img.shields.io/badge/Node.js-20-5FA04E?logo=nodedotjs&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-node:20--alpine-2496ED?logo=docker&logoColor=white)
![Platforms](https://img.shields.io/badge/platforms-amd64_%7C_arm64-2496ED?logo=linux&logoColor=white)
![geocheck](https://img.shields.io/badge/remnawave%2Fgeocheck-latest-00ADD8?logo=go&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

## Что это

- Speedtest по расписанию (по умолчанию раз в 30 мин): задержка в покое и под нагрузкой, пропускная способность, оценки bufferbloat и стабильности — как в [cloudflare-speed-cli](https://github.com/kavehtehrani/cloudflare-speed-cli).
- Проверка сервисов через [remnawave/geocheck](https://github.com/remnawave/geocheck) (раз в 6 ч): какие сервисы пускают IP ноды.
- Раз в 30 с шлёт `POST ${PANEL_URL}/api/agent/heartbeat` с `Authorization: Bearer <TOKEN>` и забирает команды «Run now». Порт открывать не нужно, агент только подключается наружу.
- Node.js ≥ 20, ноль сторонних зависимостей, один Docker-образ с geocheck внутри, один volume.
- Полный справочник — [CLAUDE.md](CLAUDE.md): §4 «Wire contract» (хартбит и локальный API), §5 «Schedulers», §7 «Environment variables», §8 «Build & deploy», §9 «Logs».

## Запуск на новом сервере

**Что нужно:** Linux-нода с Docker (для варианта через compose — ещё плагин `docker compose`) или с systemd для установки без Docker. Нода уже заведена в Remnawave, и консоль (`aerio-crm`) доступна с ноды по HTTPS: сначала поднимаются aerio-v2 и консоль, потом агенты. Домен, reverse proxy и открытые порты на ноде не нужны.

1. Получить токен. В консоли, на странице `/cluster`, выбрать ноду, открыть диалог агента и нажать **Generate token**. Диалог сразу показывает готовую команду установки с `PANEL_URL` и `TOKEN`.
2. Установить **одним из способов**.

   **Docker** (основной способ). GHCR-пакет пока **приватный**, поэтому сначала войти в реестр токеном GitHub с правом `read:packages` (или собрать образ локально, см. «Откат»):

   ```bash
   echo <github-pat> | docker login ghcr.io -u <github-user> --password-stdin
   ```

   ```bash
   docker run -d --name aerio-agent --restart unless-stopped \
     -e PANEL_URL=https://console.aerio.my -e TOKEN=<token> \
     -v aerio-agent-data:/data ghcr.io/wakeupmetha/cloudflare-speedtest-node:latest
   ```

   **Compose** (из клона репозитория):

   ```bash
   git clone https://github.com/wakeupmetha/aerio-node-agent.git && cd aerio-node-agent
   cp .env.example .env        # заполнить TOKEN (PANEL_URL уже стоит)
   docker compose up -d
   ```

   **systemd, без Docker.** Скрипт ставит агента в `/opt/aerio-agent` под отдельным пользователем. Если на хосте нет Node ≥ 20, скрипт скачает её сам. Токен кладётся в `/etc/aerio-agent.env` с правами `0600`:

   ```bash
   curl -sL https://raw.githubusercontent.com/wakeupmetha/cloudflare-speedtest-node/main/install.sh -o /tmp/aerio-agent-install.sh \
     && chmod +x /tmp/aerio-agent-install.sh \
     && sudo /tmp/aerio-agent-install.sh -t "<token>" -url "https://console.aerio.my"
   ```

   Образ имеет имя `cloudflare-speedtest-node`, а не `aerio-node-agent`: имя образа закрепили до переименования репозитория, потому что ноды тянут образ по нему. Пока репозиторий и GHCR-пакет приватные, `docker login ghcr.io` нужен на каждой ноде, а systemd-вариант (скачивает `install.sh` и архив исходников анонимно) не работает вовсе. Когда их сделают публичными, логин станет не нужен.
3. Проверить, что агент работает. В логах должна появиться строка `paired as "<нода>"`, а карточка ноды на `/cluster` заполнится в течение 30 с:

   ```bash
   docker logs -f aerio-agent        # compose: docker compose logs -f · systemd: journalctl -u aerio-agent -f
   docker exec aerio-agent wget -qO- http://127.0.0.1:9101/health   # panel.paired, panel.lastError
   curl -s http://127.0.0.1:9101/health                              # systemd: агент слушает loopback хоста
   ```

4. **Обновление.** Для Docker: `docker pull ghcr.io/wakeupmetha/cloudflare-speedtest-node:latest`, затем `docker rm -f aerio-agent` и снова команда `docker run` из шага 2. Для compose: `git pull && docker compose pull && docker compose up -d`. Для systemd: заново выполнить всю строку `curl … && sudo …` из шага 2 — скрипт в `/tmp` мог не пережить перезагрузку. Во всех трёх случаях история сохраняется: она лежит в volume `aerio-agent-data` или в `/opt/aerio-agent/data`.
5. **Откат.** CI публикует `latest` из `main`, а теги `X.Y.Z`/`X.Y` — только из git-тегов `v*`, которых пока нет. Поэтому откатиться сейчас можно только локальной сборкой из клона на нужном коммите (`git checkout <коммит>`):
   - compose: `docker compose build && docker compose up -d`. Сборка идёт под тегом `…/cloudflare-speedtest-node:latest`, поэтому следующий `docker compose pull` из шага 4 молча вернёт свежий образ;
   - `docker run`: `docker build -t aerio-agent:<коммит> .`, затем `docker rm -f aerio-agent` и команда из шага 2 с образом `aerio-agent:<коммит>` вместо `ghcr.io/…:latest`;
   - systemd: скачать скрипт заново, как в шаге 2, и запустить с `AERIO_AGENT_REF`: `sudo AERIO_AGENT_REF=<коммит> /tmp/aerio-agent-install.sh -t … -url …`.
6. **Удаление.** Для Docker: `docker rm -f aerio-agent`. Для systemd: скачать скрипт, как в шаге 2 (первые две команды строки), затем `sudo /tmp/aerio-agent-install.sh --uninstall`; с `--purge` удалятся и данные.

## Обязательные переменные окружения

| Переменная | Зачем | Как получить / пример |
|---|---|---|
| `TOKEN` | **Секрет.** По нему консоль определяет, какая это нода. Без токена агент не запускается (`TOKEN is not set — refusing to start`, exit 1) | Генерируется в консоли, в диалоге агента на `/cluster`, отдельно для каждой ноды. Сгенерировать его самому нельзя: токен должен лежать в `admin.speedtest.tokens` на стороне aerio-v2 |
| `PANEL_URL` | Адрес консоли, куда агент шлёт хартбиты. Должен начинаться с `http(s)://`, иначе агент завершится с ошибкой. Если оставить пустым, агент запустится автономно и будет только замерять, ничего никуда не отправляя | `https://console.aerio.my` |

Остальные переменные (частота замеров, параметры измерения, geocheck, логи, локальный API) с описанием и значениями по умолчанию перечислены в [.env.example](.env.example) и в [CLAUDE.md](CLAUDE.md) §7.

## Локальная разработка

```bash
npm test                                   # node --test, без фреймворка
TOKEN=devtok node src/index.js             # автономно: без консоли, только локальный API на 127.0.0.1:9101
TOKEN=<из консоли> PANEL_URL=http://localhost:3030 INTERVAL_MS=120000 node src/index.js
```

Для последней команды консоль должна быть запущена локально на моке — launch-конфиги `crm-mock` + `crm-api-mock` в `aerio-crm` (`.claude/launch.json`). Обычные `npm run dev` + `npm run dev:api` читают `.env.local`, который смотрит в прод, и **Generate token** записал бы токен в боевой реестр; мок держит токены в памяти процесса. Токен берётся на её странице `/cluster`, с выдуманным значением агент раз в 10 минут пишет `token rejected`. Чтобы работали проверки сервисов, `geocheck` должен быть в `PATH`: `go install github.com/remnawave/geocheck/cmd/geocheck@latest`. Без него агент выдаёт одно предупреждение и делает только speedtest.

## Трафик

Каждый замер длится 10 с и ограничен временем, а не объёмом, поэтому потребление растёт со скоростью канала. На линке 500 Мбит один замер — около 650 МБ, при интервале 30 мин это примерно 31 ГБ в сутки. Сократить потребление проще всего через `INTERVAL_MS`, а затем через `DOWNLOAD_SEC` / `UPLOAD_SEC` / `CONCURRENCY`.

## Логи: если нода не появилась в консоли

| Строка | Что значит | Что делать |
|---|---|---|
| `ERROR panel token rejected by panel` | Консоль не знает этот `TOKEN` | Сгенерировать токен для этой ноды на `/cluster` и переустановить агента |
| `WARN panel unreachable` | Неверный `PANEL_URL` или консоль недоступна | Проверить URL. Агент повторяет попытку каждые 30 с и, когда связь восстановится, пишет `paired as …` |
| `WARN panel node address mismatch` | Публичный IP ноды не совпадает с её адресом в Remnawave. За NAT или при адресе-хостнейме это нормально, агент работает | Если нода не за NAT и заведена по IP — проверить, что токен взят из диалога именно этой ноды |
| `WARN geocheck binary not found` | systemd: `install.sh` не смог скачать geocheck или запущен с `--no-geocheck`. Ручной запуск: `geocheck` нет в `PATH` | Перезапустить `install.sh` (шаг 2); вручную — установить `geocheck` или задать `GEOCHECK_BIN`. Speedtest работает и без него |
| `WARN speedtest run #N failed` | С ноды недоступен `speed.cloudflare.com` | Проблема с сетью или исходящим трафиком на ноде |

Когда хартбиты проходят успешно, агент ничего не пишет в лог: состояние видно в `/health` → `panel.lastOkAt`. `LOG_LEVEL=debug` выводит каждый неудачный хартбит, `LOG_JSON=1` переключает лог в JSON.

## Локальный API

По умолчанию API слушает только loopback (`BIND=127.0.0.1`, порт `9101`), консоль его не читает. Все маршруты, кроме `/health`, требуют `Authorization: Bearer <TOKEN>`.

| Маршрут | Возвращает |
|---|---|
| `GET /health` | состояние планировщиков, связи с консолью и geocheck (без авторизации) |
| `GET /speedtest/last` · `GET /speedtest/history?since=&limit=` | последний замер и историю |
| `GET /speedtest` · `GET /geocheck` | запустить замер или geocheck немедленно |
| `GET /geocheck/last` | последний дайджест geocheck |

В образе есть `wget`, а `curl` нет: `docker exec aerio-agent wget -qO- --header="Authorization: Bearer $TOKEN" http://127.0.0.1:9101/speedtest/last`.
