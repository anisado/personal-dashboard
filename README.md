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
| Translate | Upload an Arabic legal `.docx` and get an English translation paragraph by paragraph (legal register, optional glossary of fixed term renderings), downloadable as `.docx`. Requires `OPENAI_API_KEY` |
| Translation Audit | Upload the Arabic original and English translation as `.docx`, get aligned side-by-side segments and flagged issues (missing/added content, untranslated text, number, URL/placeholder, length-ratio, punctuation and terminology-consistency problems) with a score and audit history |
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
| `OPENAI_API_KEY` | unset | Hosted provider key; setting it (or `OPENAI_BASE_URL`) enables the Translate tab and the semantic review in Translation Audit |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint for translation and semantic review |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model used for translation and semantic review |

### Local model instead of OpenAI

No key needed — one command starts the stack with a bundled Ollama container, wires the API to it and downloads the model:

```bash
./scripts/local-ai.sh
```

Use another model with `OPENAI_MODEL=llama3.1:8b ./scripts/local-ai.sh`. Nothing leaves the machine, which matters for confidential legal documents. On CPU expect roughly half a minute per handful of paragraphs; a GPU host is much faster.

To go back to the hosted provider (or any other OpenAI-compatible server), run `docker compose up -d` with `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL`/`OPENAI_MODEL`) set.

With neither `OPENAI_API_KEY` nor `OPENAI_BASE_URL` the audit runs deterministic checks only: they catch mechanical errors (omissions, numbers, links, leftover Arabic, inconsistent terms) but cannot judge meaning.

## API

`GET /api/health`, `GET /api/stats`

CRUD (`GET` / `POST` / `PATCH /:id` / `DELETE /:id`) for `/api/tasks`, `/api/notes`, `/api/snippets`, `/api/bookmarks`, `/api/environments`.

Translation: `POST /api/translation/translate` (multipart with `source` = Arabic `.docx`, optional `glossary` JSON object), `GET /api/translation/translations`, `GET /api/translation/translations/:id`, `GET /api/translation/translations/:id/docx`, `DELETE /api/translation/translations/:id`.

Translation audit: `POST /api/translation/audit` (multipart with `source` = Arabic `.docx` and `target` = English `.docx`, optional `?llm=true`), `GET /api/translation/config`, `GET /api/translation/audits`, `DELETE /api/translation/audits/:id`. Max 15 MB per file.

Tools: `GET /api/tools/uuid?count=n`, `POST /api/tools/hash`, `POST /api/tools/jwt/decode`, `POST /api/tools/cron`, `POST /api/tools/http`.
