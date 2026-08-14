# umejson

> Pipeline canónico para transformar registros crudos (XLSX, CSV, JSON, API)
> en entidades `umeJSON` listas para persistir en una base de datos.

**Última release:** `v0.0.1` · **Estado:** real-mode end-to-end validado
(18/18 entidades procesadas en 277.4s, 0 fallos).

---

## Quick start

```bash
# 1. Clonar
git clone https://github.com/eortizs/ume-json-v1.git
cd ume-json-v1

# 2. Levantar /finalize API (puerto 8001)
cd finalize-api
npm install
cp .env.example .env       # editar UMEJSON_FINALIZE_KEY
node server.mjs &
cd ..

# 3. Correr el pipeline
cd process-xlsx
npm install
cp .env.example .env       # editar LLM keys + finalize URL
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx \
  --out samples/output-entities-real.json \
  --md-out samples/output-summary-real.md

# 4. Leer resultado
cat samples/output-summary-real.md
```

**Para una validación rápida sin gastar LLM:**

```bash
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx --dry-run --limit 5
```

---

## ¿Qué hace este proyecto?

1. **Lee** un XLSX (50 MB max, magic-number validado).
2. **Parsea** cada fila con tipos nativos (numbers, dates, booleans, nulls).
3. **Transforma** cada fila a `umeJSON` usando un LLM + la skill `umejson`
   (workshop de OpenClaw).
4. **Llama** a `POST /finalize` con cada `umeJSON` para que el servidor
   inyecte `id` (UUID v7) + `lifecycle.createdAt` / `lifecycle.updatedAt`.
5. **Devuelve** las entidades DB-ready + un resumen Markdown.

**Por qué este split:** el LLM nunca inventa IDs. La fuente de verdad para
identificadores y timestamps es el backend. Esto permite re-procesar
filas sin colisiones.

---

## Arquitectura

```
┌────────────┐    ┌──────────────────┐    ┌────────────────────┐
│ XLSX/CSV   │───▶│  process-xlsx    │───▶│   finalize-api     │
│ (input)    │    │  (Node.js ESM)   │    │  (Express + Ajv +  │
└────────────┘    │                  │    │   uuid v7)         │
                  │  LLM x 5 paralelo│    └─────────┬──────────┘
                  │  + /finalize     │              │
                  └──────────────────┘              ▼
                                            ┌────────────────────┐
                                            │ entities + meta    │
                                            │ (DB-ready JSON)    │
                                            └────────────────────┘
```

**Componentes:**

| Pieza | Ubicación | Qué hace |
|---|---|---|
| Skill `umejson` | Workshop OpenClaw (`umejson-20260813-554b7c62e0`) | Spec de transformación: 7 pasos, few-shot, rúbricas |
| `process-xlsx.mjs` | `process-xlsx/` | Pipeline: parse → LLM → finalize → output |
| `umejson-spec.md` | `process-xlsx/` | Copia local de la skill, usada como `system` prompt |
| `finalize-api/server.mjs` | `finalize-api/` | Validación Ajv + UUID v7 + ISO 8601 injection |
| Sample `taller-mecanico-ordenes.xlsx` | `process-xlsx/samples/` | 18 órdenes de taller con acentos, nulls, dates, booleans |

**Documentación detallada:**

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — diseño, contratos, decisiones
- **[docs/RUNBOOK.md](./docs/RUNBOOK.md)** — operación, troubleshooting, rotación de keys
- **[docs/EVIDENCE.md](./docs/EVIDENCE.md)** — runs reales, métricas, validación
- **[docs/POSTMORTEM.md](./docs/POSTMORTEM.md)** — bugs encontrados y lecciones

---

## Estado actual (v0.0.1)

**Validación real:** 18/18 entidades procesadas, 0 fallos.

| Métrica | Valor |
|---|---|
| Filas | 18 |
| Modo | real (LLM + /finalize) |
| LLM | OpenRouter `~deepseek/deepseek-v4-flash-latest` (free) |
| Concurrencia | 5 |
| Duración | 277.4s (~10.8s/fila) |
| Entity types inferidos | `OrdenTrabajo`, `OrdenServicio`, `OrdenReparacion` |
| Cost | $0 (free tier) |

**Lo que funciona:**

- ✓ Lectura XLSX con magic-number + size + filas + columnas validation
- ✓ Parseo con tipos nativos (numbers, dates, booleans, nulls)
- ✓ Pipeline LLM con concurrencia 5 + Promise.allSettled (ninguna fila aborta)
- ✓ `/finalize` API con Bearer auth + Ajv + uuid v7 + ISO 8601 + sentinel validation
- ✓ 3 tipos de failure reportados por separado: `diagnostic`, `normalize_fail`, `finalize_fail`
- ✓ Output JSON (entidades DB-ready) + Markdown resumen
- ✓ LLM agnóstico al proveedor vía `LLM_BASE_URL` (OpenAI, OpenRouter, Groq, Gemini)

**Bugs conocidos / lecciones:**

- ⚠️ `response_format: json_object` no es garantía — el parser tiene fallback para ` ```json ` fences (ver [POSTMORTEM.md](./docs/POSTMORTEM.md#bug-1))
- ⚠️ OpenRouter free tier tiene rate limits agresivos — para producción, considerar Gemini Flash Lite o gpt-4o-mini
- ⚠️ No hay idempotencia (re-procesar el mismo XLSX genera IDs nuevos)
- ⚠️ No hay tests automatizados (Jest está en el roadmap v0.1.0)

---

## CLI del pipeline

```
node process-xlsx.mjs <archivo.xlsx> [opciones]
```

| Flag | Descripción |
|---|---|
| `--dry-run` | Sin LLM, sin `/finalize`. Solo transformación local determinista. |
| `--limit N` | Procesa solo las primeras N filas. |
| `--out path.json` | Escribe entidades a archivo (default: stdout). |
| `--md-out path.md` | Escribe resumen Markdown a archivo. |
| `--json-only` | Solo imprime JSON, no Markdown. |
| `--md-only` | Solo imprime Markdown, no JSON. |

**Ejemplo end-to-end:**

```bash
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx \
  --out samples/output-entities-real.json \
  --md-out samples/output-summary-real.md
```

Output:
```
[start] archivo=samples/taller-mecanico-ordenes.xlsx hash=e3215c6fa3de0ea6 dryRun=false
[parse] 18 filas (procesando 18)
[done] 18/18 exitosas en 277.4s
[write] entidades → samples/output-entities-real.json
[write] resumen  → samples/output-summary-real.md
```

---

## Variables de entorno

| Variable | Default | Notas |
|---|---|---|
| `UMEJSON_FINALIZE_URL` | `http://localhost:8001/api/v1/ume-json/finalize` | Endpoint del API |
| `UMEJSON_FINALIZE_KEY` | (vacío) | Bearer token. **Obligatorio** en modo real. |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible |
| `LLM_API_KEY` | (vacío) | API key del LLM. **Obligatorio** fuera de `--dry-run` |
| `LLM_MODEL` | `gpt-4o-mini` | Modelo a invocar |

**Combinaciones soportadas:**

```bash
# OpenAI
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# OpenRouter (validado en v0.0.1)
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=~deepseek/deepseek-v4-flash-latest

# Gemini
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash-lite

# Groq
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
```

---

## API `/finalize` — referencia rápida

`POST /api/v1/ume-json/finalize`

```bash
curl -X POST http://127.0.0.1:8001/api/v1/ume-json/finalize \
  -H "Authorization: Bearer <UMEJSON_FINALIZE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "RESERVED_FOR_SYSTEM",
    "entityName": "Cliente",
    "dynamicProperties": { "nombre": "Ana" },
    "lifecycle": {
      "createdAt": "RESERVED_FOR_SYSTEM",
      "updatedAt": "RESERVED_FOR_SYSTEM",
      "version": 1
    },
    "relations": [],
    "state": {
      "current": "active",
      "statusLog": [
        { "status": "active", "timestamp": "RESERVED_FOR_SYSTEM", "reason": "import" }
      ]
    },
    "markdownDocumentation": "### Cliente - Ana\n**Resumen:** cliente nuevo"
  }'
```

Response 200:
```json
{
  "ok": true,
  "data": {
    "id": "01a001xx-xxxx-7xxx-xxxx-xxxxxxxxxxxx",
    "entityName": "Cliente",
    "dynamicProperties": { "nombre": "Ana" },
    "lifecycle": {
      "createdAt": "2026-08-14T16:51:06.273Z",
      "updatedAt": "2026-08-14T16:51:06.273Z",
      "version": 1
    },
    "state": {
      "current": "active",
      "statusLog": [
        { "status": "active", "timestamp": "2026-08-14T16:51:06.273Z", "reason": "import" }
      ]
    }
  }
}
```

**Status codes:**

| Status | Cuándo | Body |
|---|---|---|
| `200` | Éxito | `{ ok: true, data: <entity> }` |
| `401` | API key inválida | `{ ok: false, error: { code: 'unauthorized', ... } }` |
| `422` | `__diagnostic` | `{ ok: false, source: 'umejson_skill', diagnostic: {...} }` |
| `422` | Schema inválido | `{ ok: false, error: { code: 'schema_violation', details: [...] } }` |
| `422` | Sentinel violación | `{ ok: false, error: { code: 'sentinel_violation', details: [...] } }` |
| `429` | Rate limit | `{ ok: false, error: { code: 'rate_limited', ... } }` |

---

## Límites

| Límite | Valor | Configurable |
|---|---|---|
| Tamaño XLSX | 50 MB | `MAX_FILE_BYTES` |
| Filas | 100 000 | `MAX_ROWS` |
| Columnas | 50 (warning) | `MAX_COLS` |
| Concurrencia LLM | 5 | `CONCURRENCY` |
| Body `/finalize` | 100 KB | `express.json({ limit })` |
| Rate limit `/finalize` | 600/min/IP | `RATE_LIMIT_MAX` |

---

## Roadmap

### v0.1.0 — Producción end-to-end

- [ ] **Modo `--deterministic`** (camino B sin LLM) — para archivos recurrentes
- [ ] **Modo `--hybrid`** (camino C: LLM aprende schema, ejecuta determinista)
- [ ] **Soporte CSV / JSON** directo
- [ ] **Idempotencia** — `Idempotency-Key` header en `/finalize`
- [ ] **Tests Jest** con XLSX sintéticos (happy path, schema fail, fence detection)
- [ ] **GitHub Actions** — `node --check` + `npm test` en cada PR
- [ ] **Branch protection** en `main` (require PR + 1 review)

### v0.2.0 — Hardening

- [ ] Persistir las entities a PostgreSQL (no solo devolverlas)
- [ ] Autenticación JWT con refresh tokens (no solo Bearer estático)
- [ ] Rate-limit con Redis (multi-instancia)
- [ ] CORS whitelist
- [ ] Métricas Prometheus
- [ ] Migración del server a TypeScript (.mts)

### v0.3.0 — Multi-formato

- [ ] Soporte `.xls` legacy
- [ ] Soporte `.xlsm` (con sandboxing para macros)
- [ ] Soporte `.xlsb` (binary workbook)
- [ ] Soporte `.numbers` (Apple)
- [ ] Soporte PDF de tablas (via OCR)

---

## Licencia

TBD — privado. Repo `eortizs/ume-json-v1` (privado en GitHub).
