# personal-dashboard

A personal developer assistant dashboard: React (Vite) frontend, Node/Express API, fully Dockerized.

## Features

| Area | What it does |
| --- | --- |
| Overview | Greeting, counters for tasks/notes/snippets/bookmarks, next-up tasks, API health |
| Tasks | Create/complete/delete tasks with priority, project, due date; open/done/all filters |
| Notes | Markdown-ish scratchpad with tags and full-text search |
| Snippets | Save code/commands per language, copy to clipboard |
| Bookmarks | Grouped links by category |
| Environments | Register services and health-check them (status code + latency) |
| Dev Tools | HTTP request runner, JSON formatter, JWT decoder, Base64/URL encoder, hash generator (md5/sha1/sha256/sha512), regex tester, cron next-run preview, timestamp converter, UUID generator |

Data is persisted by the API as JSON in `DATA_DIR` (a named Docker volume in compose), so no external database is required.

## Run with Docker

```bash
docker compose up --build
```

- Dashboard: http://localhost:8080
- API: http://localhost:4000/api/health

Override ports with `WEB_PORT` / `API_PORT`. The web container serves the built frontend through nginx and proxies `/api` to the API container.

## Local development

```bash
cd server && npm install && npm run dev     # http://localhost:4000
cd client && npm install && npm run dev     # http://localhost:5173 (proxies /api to :4000)
```

Environment variables:

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `4000` | API listen port |
| `DATA_DIR` | `./data` | API JSON storage directory |
| `VITE_API_TARGET` | `http://localhost:4000` | Vite dev proxy target |
| `VITE_API_BASE` | `/api` | Frontend API base path |

## API

`GET /api/health`, `GET /api/stats`

CRUD (`GET` / `POST` / `PATCH /:id` / `DELETE /:id`) for `/api/tasks`, `/api/notes`, `/api/snippets`, `/api/bookmarks`, `/api/environments`.

Tools: `GET /api/tools/uuid?count=n`, `POST /api/tools/hash`, `POST /api/tools/jwt/decode`, `POST /api/tools/cron`, `POST /api/tools/http`.
