# umejson

Pipeline canónico para transformar registros crudos (XLSX, CSV, JSON, API) en entidades `umeJSON` listas para persistir.

## Componentes

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐    ┌──────────┐
│  XLSX / CSV     │ →  │  process-xlsx    │ →  │  finalize-api   │ →  │   DB     │
│  (registros     │    │  (skill + LLM)   │    │  /api/v1/       │    │ (lista   │
│   crudos)       │    │                  │    │  ume-json/      │    │ p/guardar│
└─────────────────┘    └──────────────────┘    │  finalize       │    └──────────┘
                              │                └─────────────────┘
                              ↓                       ↑
                       ┌──────────────┐               │
                       │  umejson     │               │ Bearer auth
                       │  skill       │               │ + JSON schema
                       │ (en workshop)│               │ + UUID v7
                       └──────────────┘               │ + ISO timestamps
```

| Pieza | Qué hace | Dónde vive |
|---|---|---|
| **Skill `umejson`** | Especificación de referencia del formato + reglas de transformación (en workshop de OpenClaw, aplicada) | Workshop de OpenClaw |
| **`process-xlsx.mjs`** | Pipeline que toma un XLSX, lo transforma fila por fila con el skill + LLM, llama al `/finalize`, devuelve entidades DB-ready | `process-xlsx/` |
| **`umejson-spec.md`** | Copia local de la skill — se usa como `system` prompt para el LLM | `process-xlsx/` |
| **`finalize-api/`** | Servidor Express que valida el umeJSON contra schema Ajv + inyecta UUID v7 + timestamps reales | `finalize-api/` |
| **Samples** | XLSX sintético de taller mecánico (18 órdenes) + su generador | `process-xlsx/samples/` |

## Setup

### 1. Levantar el API `/finalize`

```bash
cd /root/.openclaw/workspace/umejson/finalize-api
npm install
cp .env.example .env
# editar .env: PORT=8001, UMEJSON_FINALIZE_KEY=<un-token-seguro>

# arrancar (producción: pm2 / systemd / docker)
node server.mjs
# health: http://127.0.0.1:8001/health
# finalize: POST http://127.0.0.1:8001/api/v1/ume-json/finalize
```

### 2. Correr el pipeline

```bash
cd /root/.openclaw/workspace/umejson/process-xlsx
npm install
cp .env.example .env
# editar .env: UMEJSON_FINALIZE_URL, UMEJSON_FINALIZE_KEY, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL

# validar sin gastar LLM
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx --dry-run --limit 5

# real
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx --out entities.json --md-out resumen.md
```

## CLI

```
node process-xlsx.mjs <archivo.xlsx> [opciones]
```

| Flag | Descripción |
|---|---|
| `--dry-run` | Sin LLM, sin `/finalize`. Solo parsea XLSX + transformación local determinista. Útil para validar antes de gastar dinero. |
| `--limit N` | Procesa solo las primeras N filas. |
| `--out path.json` | Escribe entidades a archivo (default: stdout). |
| `--md-out path.md` | Escribe resumen Markdown a archivo. |
| `--json-only` | Solo imprime JSON, no Markdown. |
| `--md-only` | Solo imprime Markdown, no JSON. |

## Output

**JSON** — entidades listas para DB, con envelope del API:
```json
{
  "summary": {
    "file": "...",
    "file_hash": "sha256:...",
    "dry_run": false,
    "total_rows": 18,
    "processed": 18,
    "succeeded": 18,
    "failed": 0,
    "duration_ms": 142000
  },
  "entities": [
    {
      "ok": true,
      "data": {
        "id": "0190a...-uuid-v7-...",
        "entityName": "OrdenTrabajo",
        "dynamicProperties": { "idOrden": "OT-2026-0001", ... },
        "lifecycle": {
          "createdAt": "2026-08-14T16:51:06.273Z",
          "updatedAt": "2026-08-14T16:51:06.273Z",
          "version": 1
        },
        "relations": [],
        "state": { "current": "active", "statusLog": [...] },
        "markdownDocumentation": "..."
      }
    }
  ],
  "failures": [
    { "idx": 42, "status": "diagnostic", "detail": { ... } },
    { "idx": 89, "status": "normalize_fail", "error": "..." },
    { "idx": 102, "status": "finalize_fail", "umeJson": {...}, "error": "..." }
  ]
}
```

**Markdown** — resumen para chat / WhatsApp:
```
| Métrica | Valor |
|---|---|
| Modo | real |
| Filas totales | 18 |
| Exitosas | 18 (100.0%) |
| Fallidas | 0 |
| Duración | 51.3s |
```

## Pipeline interno

1. **Lee** el XLSX (límite 50 MB, magic number validado).
2. **Parsea** con `xlsx` → array de objetos `{ col1: val1, ... }`. Tipos nativos (numbers, dates, booleans).
3. Por cada fila (concurrencia 5):
   - **Transforma** a `umeJSON` vía LLM (OpenAI-compatible) usando `umejson-spec.md` como system prompt.
   - Si el LLM devuelve `__diagnostic`, se reporta como `diagnostic` y se sigue.
   - Si el LLM devuelve JSON inválido, se reporta como `normalize_fail`.
   - **Llama** a `POST /finalize` con el umeJSON (Authorization: Bearer).
   - Si `/finalize` falla (4xx/5xx), se reporta como `finalize_fail`.
4. **Acumula** successes + failures; entrega resumen + entidades DB-ready.

**Regla sagrada:** una fila mala NUNCA aborta el batch.

## Variables de entorno

| Variable | Default | Notas |
|---|---|---|
| `UMEJSON_FINALIZE_URL` | `http://localhost:8001/api/v1/ume-json/finalize` | Endpoint del API de finalización |
| `UMEJSON_FINALIZE_KEY` | (vacío) | Bearer token. **Obligatorio** en modo real. |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible. OpenRouter, Groq, etc. |
| `LLM_API_KEY` | (vacío) | API key del proveedor LLM. **Obligatorio** fuera de `--dry-run`. |
| `LLM_MODEL` | `gpt-4o-mini` | Modelo a invocar. |

**Ejemplos de combinaciones LLM:**

```bash
# OpenAI directo
LLM_BASE_URL=https://api.openai.com/v1  LLM_MODEL=gpt-4o-mini

# OpenRouter
LLM_BASE_URL=https://openrouter.ai/api/v1  LLM_MODEL=~deepseek/deepseek-v4-flash-latest

# Groq
LLM_BASE_URL=https://api.groq.com/openai/v1  LLM_MODEL=llama-3.3-70b-versatile
```

## Límites duros

| Límite | Valor | Por qué |
|---|---|---|
| Tamaño archivo | 50 MB | DoS |
| Filas | 100,000 | Memoria + costo LLM |
| Columnas | 50 (warning) | Schema mal formado probable |
| Concurrencia LLM | 5 | Rate limits |
| Body `/finalize` | 100 KB | Sanity limit |

## API `/finalize` — contrato

`POST /api/v1/ume-json/finalize`

| Header | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <UMEJSON_FINALIZE_KEY>` |

**Request body:** un objeto `umeJSON` con sentinels `RESERVED_FOR_SYSTEM` en `id`, `lifecycle.createdAt`, `lifecycle.updatedAt`, y los `state.statusLog[*].timestamp`.

**Respuestas:**

| Status | Cuándo | Body |
|---|---|---|
| `200` | Éxito | `{ ok: true, data: <entity con id y timestamps reales> }` |
| `401` | API key inválida | `{ ok: false, error: { code: 'unauthorized', ... } }` |
| `422` | Schema inválido / sentinel violación | `{ ok: false, error: { code: 'schema_violation' \| 'sentinel_violation', details: [...] } }` |
| `422` | `__diagnostic` del agente | `{ ok: false, source: 'umejson_skill', diagnostic: {...} }` |
| `429` | Rate limit | `{ ok: false, error: { code: 'rate_limited', ... } }` |

El servidor genera UUID v7 nativo (`uuid` package) e ISO timestamps con `new Date().toISOString()`. La mutación es **deep-clone** del input — el body original no se toca.

## Roadmap

- [x] `/finalize` API MVP local (v0.0.1)
- [x] Soporte `LLM_BASE_URL` agnóstico (OpenAI, OpenRouter, Groq)
- [x] Sample XLSX de taller mecánico (18 filas)
- [ ] Modo `--deterministic` (camino B sin LLM)
- [ ] Modo `--hybrid` (camino C: LLM analiza 5 filas → genera transformer → ejecuta batch)
- [ ] Soporte CSV / JSON directo
- [ ] Idempotencia vía hash de archivo (`Idempotency-Key` header)
- [ ] Tests Jest con XLSX sintéticos
- [ ] GitHub Actions: validar `node --check` en cada push
- [ ] Branch protection en `main`
