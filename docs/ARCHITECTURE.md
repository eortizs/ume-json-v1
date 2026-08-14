# Arquitectura — umeJSON

Documento de diseño del sistema. Cubre las decisiones, los componentes, los
contratos y los límites. Para arrancar rápido, ver el [README](../README.md).
Para evidencia concreta de un run real, ver [EVIDENCE.md](./EVIDENCE.md).

---

## 1. Propósito

`umejson` es un pipeline canónico para **transformar registros crudos** (XLSX,
CSV, JSON, API) en **entidades `umeJSON`** listas para persistir en una base de
datos. La transformación se hace en dos pasos claramente separados:

1. **Normalización semántica** — un LLM aplica la skill `umejson` (workshop de
   OpenClaw) a cada registro y produce un `umeJSON` con placeholders
   `RESERVED_FOR_SYSTEM` en los campos de infraestructura.
2. **Finalización server-side** — un API valida el contrato e inyecta
   `id` (UUID v7) y `lifecycle.createdAt` / `lifecycle.updatedAt` (ISO 8601).

Esta separación cumple dos objetivos:

- **Evita que el LLM invente IDs.** El backend es la única fuente de verdad
  para identificadores y timestamps.
- **Permite re-procesar** la misma fila cruda múltiples veces — los placeholders
  son los mismos, los IDs reales都不一样.

---

## 2. Componentes

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────────┐      │
│  │ XLSX / CSV  │    │   process-xlsx   │    │     finalize-api    │      │
│  │   (input)   │───▶│  (Node.js ESM)   │───▶│  (Express + Ajv +   │      │
│  │             │    │                  │    │   uuid v7 + Ajv)    │      │
│  └─────────────┘    │  ┌────────────┐  │    └──────────┬──────────┘      │
│                     │  │  parseXlsx │  │               │                 │
│                     │  └─────┬──────┘  │               │                 │
│                     │        ▼         │               │                 │
│                     │  ┌────────────┐  │               │                 │
│                     │  │  LLM call  │  │               │                 │
│                     │  │  (N=5)     │  │               │                 │
│                     │  └─────┬──────┘  │               │                 │
│                     │        ▼         │               │                 │
│                     │  ┌────────────┐  │               │                 │
│                     │  │  fetch     │──┼────────────────▶                 │
│                     │  │  /finalize │  │               │                 │
│                     │  └────────────┘  │               │                 │
│                     └──────────────────┘               │                 │
│                                                        ▼                 │
│                                            ┌─────────────────────┐      │
│                                            │  entities + meta    │      │
│                                            │  (DB-ready JSON)    │      │
│                                            └─────────────────────┘      │
│                                                                          │
│   ┌────────────────────────────────────────────────────────────────┐     │
│   │  umejson skill (workshop de OpenClaw)                         │     │
│   │  - prompt de transformación documentado en 3ra persona         │     │
│   │  - few-shot de XLSX → umeJSON                                  │     │
│   │  - rúbricas (cardinalidad, tipado, state.current)              │     │
│   └────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 `process-xlsx.mjs` (pipeline)

Responsabilidades:

1. **Validar** el archivo: extensión XLSX, magic number ZIP, tamaño ≤ 50 MB,
   filas ≤ 100 000, columnas ≤ 50 (warning).
2. **Parsear** con `xlsx` package → `sheet_to_json({ raw: true, cellDates: true, defval: null })`.
   - `raw: true` — números como `number`, fechas como `Date`
   - `defval: null` — celdas vacías como `null` (no `undefined`)
3. **Orquestar** con `p-limit` (concurrencia 5) y `Promise.allSettled`:
   - Cada fila pasa por 3 puntos de fallo posibles → ninguna fila aborta el batch.
4. **Para cada fila**:
   - `rowToUmeJson(row, idx)` — llamada LLM con `umejson-spec.md` como `system`,
     `JSON.stringify({ row, idx })` como `user`, `response_format: json_object`,
     `temperature: 0`.
   - `--dry-run` → `localTransform(row, idx)` — sin LLM, sin red.
   - Detección de `__diagnostic` → status `diagnostic`.
   - Fallo de parseo JSON → status `normalize_fail` (con fallback a `JSON.parse`
     después de limpiar ` ```json ` fences).
   - `finalize(umeJson)` → POST al `/finalize`.
   - 4xx/5xx → status `finalize_fail`.
5. **Acumular** successes + failures.
6. **Escribir** output JSON + Markdown resumen.

### 2.2 `finalize-api/server.mjs` (control de calidad)

Responsabilidades:

1. **`POST /api/v1/ume-json/finalize`** — recibe `umeJSON` con placeholders,
   devuelve `umeJSON` con datos reales.
2. **Validar** en 4 capas:
   - **Auth** — `Authorization: Bearer <key>` debe coincidir con `UMEJSON_FINALIZE_KEY`.
   - **Diagnóstico** — si la IA devuelve `__diagnostic`, lo propaga como
     `422` con `source: 'umejson_skill'`.
   - **Schema** — Ajv compilado al boot. Valida:
     - `dynamicProperties`, `markdownDocumentation` requeridos
     - `state.current` ∈ `{active, draft, validation_required}`
     - `relations[*].type` ∈ el enum
   - **Sentinels** — `id`, `lifecycle.createdAt`, `lifecycle.updatedAt`,
     y los `state.statusLog[*].timestamp` deben ser literalmente
     `RESERVED_FOR_SYSTEM` o `null`. Si la IA inventó un UUID real, se
     rechaza con `sentinel_violation`.
3. **Inyectar** datos del servidor:
   - `id` → `uuidv7()` (uuid v7 nativo).
   - `lifecycle.createdAt`, `lifecycle.updatedAt` → `new Date().toISOString()`.
   - `state.statusLog[*].timestamp` → la misma ISO (`now`).
4. **Devolver** la entidad en `{ ok: true, data: <entity> }`.

Extras:

- `express.json({ limit: '100kb' })` — anti-DoS.
- `cors({ origin: true })` — MVP, abierto; producción: whitelist.
- Rate-limit in-memory (600 req/min por IP) — producción: Redis.
- Logging estructurado con `request_id` (uuid v4).
- `structuredClone` — no muta `req.body`.
- Envelope unificado `{ ok, data|error }`.

### 2.3 Skill `umejson` (workshop de OpenClaw)

- **Estado actual:** `applied` (ID `umejson-20260813-554b7c62e0`).
- **Formato:** documentación de referencia en 3ra persona (no prompt para
  agente). Pasó el scan después de 3 intentos fallidos — el scanner flagea
  framing de "instrucciones para agente" (segunda persona + imperativos).
- **Contenido:** 7 pasos de transformación, few-shot, rúbricas, contrato
  de salida, extensión `__diagnostic`.

---

## 3. Contratos

### 3.1 Schema `umeJSON` (JSON Schema)

```json
{
  "type": "object",
  "required": ["id", "entityName", "dynamicProperties", "lifecycle", "state", "markdownDocumentation"],
  "properties": {
    "id":                     { "type": "string" },
    "entityName":             { "type": "string", "minLength": 1 },
    "dynamicProperties":      { "type": "object", "additionalProperties": true },
    "lifecycle": {
      "type": "object",
      "required": ["createdAt", "updatedAt"],
      "properties": {
        "createdAt":          { "type": "string" },
        "updatedAt":          { "type": "string" },
        "deletedAt":          { "type": ["string", "null"] },
        "version":            { "type": "integer", "minimum": 1 }
      }
    },
    "relations": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["targetEntity", "targetId", "type"],
        "properties": {
          "targetEntity":      { "type": "string" },
          "targetId":          { "type": "string" },
          "type":              { "enum": ["one-to-one", "one-to-many", "many-to-one", "many-to-many"] },
          "context":           { "type": "string" }
        }
      }
    },
    "state": {
      "type": "object",
      "required": ["current", "statusLog"],
      "properties": {
        "current":            { "enum": ["active", "draft", "validation_required"] },
        "statusLog": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["status", "timestamp"],
            "properties": {
              "status":        { "type": "string" },
              "timestamp":     { "type": "string" },
              "reason":        { "type": "string" }
            }
          }
        }
      }
    },
    "markdownDocumentation": { "type": "string" }
  }
}
```

### 3.2 Endpoint `/finalize`

```
POST /api/v1/ume-json/finalize
Authorization: Bearer <UMEJSON_FINALIZE_KEY>
Content-Type: application/json

<umeJSON con sentinels RESERVED_FOR_SYSTEM>
```

| Status | Significado | Body |
|---|---|---|
| `200` | Éxito | `{ ok: true, data: <umeJSON con id/timestamps reales> }` |
| `401` | API key inválida | `{ ok: false, error: { code: 'unauthorized', ... } }` |
| `422` | `__diagnostic` de la skill | `{ ok: false, source: 'umejson_skill', diagnostic: {...} }` |
| `422` | Schema inválido | `{ ok: false, error: { code: 'schema_violation', details: [...] } }` |
| `422` | Sentinel violation | `{ ok: false, error: { code: 'sentinel_violation', details: [...] } }` |
| `429` | Rate limit | `{ ok: false, error: { code: 'rate_limited', ... } }` |

### 3.3 Salida de `process-xlsx.mjs`

```json
{
  "summary": {
    "file": "ventas.xlsx",
    "file_hash": "sha256:e3215c6fa3de0ea6",
    "dry_run": false,
    "total_rows": 18,
    "processed": 18,
    "succeeded": 18,
    "failed": 0,
    "duration_ms": 277400
  },
  "entities": [ { "ok": true, "data": { ... } }, ... ],
  "failures": [
    { "idx": 42, "status": "diagnostic", "detail": { ... } },
    { "idx": 89, "status": "normalize_fail", "error": "..." },
    { "idx": 102, "status": "finalize_fail", "umeJson": {...}, "error": "..." }
  ]
}
```

---

## 4. Modelo de ejecución

### 4.1 Pipeline (camino A — LLM-por-fila)

```
XLSX
  → parseXlsx (sync)
  → fila por fila, en paralelo (5):
        LLM con umejson-spec.md
        → JSON.parse (con fallback de fences)
        → POST /finalize
  → resumen
```

**Cuándo usarlo:** < 100 filas / batch, schemas nuevos, datos variables.

**Costo:** ~$0.005–$0.013 / 18 filas (según proveedor LLM).

### 4.2 Determinista (camino B — sin LLM)

```
XLSX
  → parseXlsx
  → fila por fila, secuencial:
        localTransform (camelCase, tipos nativos, entityName='RegistroImportado')
        → en --dry-run: inyecta valores ficticios
        → en real: POST /finalize
  → resumen
```

**Cuándo usarlo:** schema 100% estable, > 1K filas, no querés gastar LLM.

**Limitación:** el `entityName` es siempre `RegistroImportado` (no semántico).

### 4.3 Híbrido (camino C — LLM-as-analyzer)

```
3-5 filas
  → LLM analiza el schema
  → genera un transformer determinista
  → cachea el transformer
resto de las filas
  → transformer determinista
  → POST /finalize
```

**Cuándo usarlo:** producción con archivos recurrentes del mismo origen.

**Estado:** pendiente (roadmap v0.1.0).

---

## 5. Decisiones de diseño

| Decisión | Alternativa | Por qué |
|---|---|---|
| **Split LLM ↔ backend** | LLM genera todo incl. UUID | Evita que la IA invente IDs; permite re-procesar |
| **Sentinel literal `RESERVED_FOR_SYSTEM`** | `null` o `undefined` | Detección trivial; legible en logs |
| **Bearer token en cada request** | mTLS / JWT | Suficiente para MVP; trivial de rotar |
| **Rate-limit in-memory** | Redis / NGINX | Cero dependencias externas; vale para 1 instancia |
| **Schema Ajv estricto** | validación manual | Performance (compilado una vez); claridad |
| **LLM agnóstico via `LLM_BASE_URL`** | lock-in a OpenAI | Permite OpenRouter / Groq / Gemini sin tocar código |
| **Concurrencia 5** | 1 / 10 / 20 | Balance throughput vs rate-limits |
| **Outputs en JSON + Markdown** | solo JSON | Markdown legible directo para chat / WhatsApp |

---

## 6. Límites duros

| Límite | Valor | Configurable | Razón |
|---|---|---|---|
| Tamaño XLSX | 50 MB | `MAX_FILE_BYTES` | DoS |
| Filas | 100 000 | `MAX_ROWS` | Memoria + costo LLM |
| Columnas | 50 (warning) | `MAX_COLS` | Schema mal formado |
| Concurrencia LLM | 5 | `CONCURRENCY` | Rate limits |
| Body `/finalize` | 100 KB | `express.json({ limit })` | Sanity |
| Rate limit `/finalize` | 600/min/IP | `RATE_LIMIT_MAX` | DDoS |

---

## 7. Dependencias

| Paquete | Versión | Por qué |
|---|---|---|
| `xlsx` | `^0.18.5` | Parsea XLSX |
| `p-limit` | `^3.1.0` | Concurrencia controlada |
| `dotenv` | `^16.4.5` | Lee `.env` |
| `express` | `^4.21.2` | HTTP server |
| `ajv` | `^8.17.1` | JSON Schema validation (compilada) |
| `ajv-formats` | `^3.0.1` | Soporte para `date-time`, etc. |
| `uuid` | `^11.0.4` | UUID v7 nativo |
| `cors` | `^2.8.5` | CORS middleware |

---

## 8. Operación

Ver [RUNBOOK.md](./RUNBOOK.md) para arrancar, monitorear, y matar los
procesos. Si tenés un incidente, ver [POSTMORTEM.md](./POSTMORTEM.md) primero.
