# Changelog — ume-json-v1

Todas las modificaciones relevantes a este proyecto se documentan aquí.

Para documentación detallada ver:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — diseño, contratos, decisiones
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — operación, troubleshooting
- [docs/EVIDENCE.md](docs/EVIDENCE.md) — runs reales, métricas
- [docs/POSTMORTEM.md](docs/POSTMORTEM.md) — bugs y lecciones

## Unreleased — 2026-09-01 · Persistencia: modelo head + journal (documentación)

**Sin cambios de código.** Diseño de persistencia cerrado y documentado.
La bitácora de comportamiento vive en una tabla append-only separada; el
documento umeJSON queda como estado vigente con esquema estable.

**Novedades:**

- `docs/PERSISTENCE.md` (nuevo) — fuente de verdad del diseño de persistencia:
  - Modelo **head + journal**: `entities` (documento jsonb, una fila por
    entidad) + `entity_events` (bitácora append-only con `seq` monotónico).
  - DDL normativo con índices y notas de diseño.
  - Protocolo de escritura transaccional con bloqueo optimista (`version`).
  - 9 invariantes normativas (historial nunca embebido, append-only, solo
    el servidor escribe la bitácora, bitemporalidad `occurred_at`/
    `recorded_at`, actor, proyección de `statusLog`).
  - Catálogo cerrado de tipos de evento + ejemplo canónico.
  - Escrito en estilo declarativo consumible por humanos y cualquier
    agente IA, independiente de framework o proveedor.
- `docs/ARCHITECTURE.md` — nueva sección 9 (Persistencia) y fila en la tabla
  de decisiones: historial en journal separado vs. embebido.
- `process-xlsx/umejson-spec.md` — regla de acotamiento: `state.statusLog`
  máximo 20 entradas, proyección de solo lectura de la bitácora.
- `README.md` — PERSISTENCE.md en el índice de documentación; ítem de
  roadmap v0.2.0 enlazado al diseño.

**No se cambiaron:**

- `finalize-api/server.mjs` — mismo comportamiento
- `process-table.mjs` — mismo comportamiento
- JSON Schema del `/finalize` — sin cambios estructurales

## v0.1.0 — 2026-08-14 · Multi-format support (XLSX, CSV, TSV, JSON)

**Soportada la lectura de 4 formatos de tabla.** El script se renombra
`process-xlsx.mjs` → `process-table.mjs` para reflejar la ampliación.
`process-xlsx.mjs` queda como shim de backward-compat.

**Novedades:**

- **Format detection automático** por extensión: `.xlsx`, `.csv`, `.tsv`, `.json`.
- **CSV parser** — vía `xlsx.read` con `type: 'string'`. Coerción de booleanos
  `"TRUE"/"FALSE"` → `true/false` (CSV no preserva tipos nativos).
- **TSV parser** — igual que CSV, con `FS: '\t'`.
- **JSON parser** con 5 shapes soportadas:
  - Array de objetos
  - `{rows: [...]}` / `{data: [...]}` / `{records: [...]}` (con wrappers)
  - Objeto individual (single record)
- **Magic number check** actualizado: solo se aplica a XLSX (los demás
  son texto plano).
- **Sample files** en `samples/`:
  - `taller-mecanico-ordenes.csv` (4.0 KB)
  - `taller-mecanico-ordenes.json` (10.4 KB, array)
  - `taller-mecanico-ordenes.rows.json` (11.1 KB, `{rows:[]}`)
  - `taller-mecanico-ordenes.single.json` (0.5 KB, single object)
- **Script generador** `samples/generate-csv-and-json.mjs` — regenera los
  samples a partir del XLSX.
- **Shim** `process-xlsx.mjs` — delega a `process-table.mjs`. Se eliminará
  en v0.2.0.
- **Documentación** `docs/FORMATS.md` — referencia de los 4 formatos (tipos,
  coerciones, shapes, limitaciones).

**Validación:**

| Formato | Filas | Resultado | Provider LLM | Duración |
|---|---|---|---|---|
| XLSX | 18 | 18/18 OK | OpenRouter `~deepseek-v4-flash` | 277.4s |
| CSV | 3 | 3/3 OK | OpenRouter `~deepseek-v4-flash` | 23.7s |
| JSON (single) | 1 | 1/1 OK | OpenRouter `~deepseek-v4-flash` | 46.2s |

**Bugs encontrados y corregidos en v0.1.0:**

1. **Typo `FINIZE_KEY`** (en vez de `FINALIZE_KEY`) en el header
   `Authorization` de `fetch /finalize`. El error era `FINIZE_KEY is not
   defined` capturado por `finalize_fail`. Fixed: variable correcta.

2. **CSV booleans como strings** — `xlsx.read` con `raw: false` entrega
   `TRUE`/`FALSE` como strings. Solución: `coerceCsvBooleans()` corre
   como post-proceso, matchea `^(?i:true|false)$` → boolean nativo.

**Output del LLM (deepseek) con CSV:**

```json
{
  "ok": true,
  "data": {
    "id": "01a00156-4d04-77da-b517-5c63e049a6b3",
    "entityName": "OrdenServicio",
    "dynamicProperties": {
      "idOrden": "OT-2026-0001",
      "clienteNombre": "José Hernández",
      "pagado": false,           // ← boolean, no string "FALSE"
      "costoEstimado": 4500,
      ...
    },
    "lifecycle": {
      "createdAt": "2026-08-14T17:33:48.164Z",
      "updatedAt": "2026-08-14T17:33:48.164Z",
      "version": 1
    }
  }
}
```

**No se cambiaron:**

- `finalize-api/server.mjs` — mismo comportamiento
- `process-table.mjs` mantiene misma API HTTP al `/finalize`
- Tag v0.0.1 sigue siendo la última release de código con un solo formato

**Pendientes para v0.2.0:**

- [ ] Modo `--deterministic` + `--hybrid`
- [ ] Idempotencia (`Idempotency-Key` header)
- [ ] Tests Jest con XLSX/CSV/JSON sintéticos
- [ ] Soporte NDJSON (un JSON por línea)
- [ ] Soporte `.xls` legacy (binary OLE2)
- [ ] Soporte `.xlsx` multi-hoja

## v0.0.2 — 2026-08-14 · Documentation kit

**Sin cambios de código.** Solo documentación.

**Novedades:**

- `docs/ARCHITECTURE.md` (13 KB) — diseño sistema, componentes, contratos, decisiones, límites, dependencias
- `docs/RUNBOOK.md` (7 KB) — arranque, monitoreo, troubleshooting, rotación de keys, backup
- `docs/EVIDENCE.md` (6 KB) — runs reales del taller mecánico, métricas, validación
- `docs/POSTMORTEM.md` (7 KB) — 3 bugs del v0.0.1 (JSON fences, pipe a tail, huérfanos) + 1 issue operacional (gh CLI auth)
- `README.md` actualizado — executive summary + TOC que apunta a docs/

**No se cambiaron:**
- `process-xlsx.mjs` — mismo comportamiento
- `finalize-api/server.mjs` — mismo comportamiento
- `samples/output-entities-real.json` — mismo contenido
- Tags — sigue siendo `v0.0.1` la última release

**Pendientes para v0.1.0:** (sin cambios desde v0.0.1)
- Modo `--deterministic` + `--hybrid`
- Soporte CSV/JSON
- Idempotencia
- Tests Jest

## v0.0.1 — 2026-08-14 · finalize-api MVP + sample XLSX + real-mode pipeline

**Pipeline XLSX → umeJSON end-to-end validado en modo real.**

**Novedades:**

- **`finalize-api/`** — servidor Express completo con todos los fixes del code review:
  - Bearer auth (`UMEJSON_FINALIZE_KEY` via `.env`)
  - JSON Schema completa via Ajv: `markdownDocumentation` + `dynamicProperties` requeridos, `state.current` enum (`active`/`draft`/`validation_required`), sentinels `RESERVED_FOR_SYSTEM` validados antes de inyectar
  - `structuredClone` (no muta el `req.body`)
  - handler dedicado para `__diagnostic` del skill
  - validación de `lifecycle.deletedAt` (null o ausente)
  - `express.json({ limit: '100kb' })`, CORS abierto (MVP), `cors`, rate-limit por IP (600/min), logger estructurado con `request_id`, envelope unificado `{ ok, data|error }`
  - ruta `/health` para smoke check
  - UUID v7 nativo (`uuid@^11.0.4`) + `new Date().toISOString()` para timestamps

- **`process-xlsx.mjs` agnóstico al proveedor LLM**
  - nueva variable `LLM_BASE_URL` (default: `https://api.openai.com/v1`)
  - soporta OpenAI, OpenRouter (`https://openrouter.ai/api/v1`), Groq, etc.
  - fallback al `JSON.parse` que limpia bloques ```json fences que algunos modelos (deepseek, llama) emiten pese a `response_format: json_object`

- **Sample sintético `process-xlsx/samples/`**
  - `taller-mecanico-ordenes.xlsx` — 18 órdenes con acentos, nulls, dates, booleans, currency
  - `generate-taller-mecanico.mjs` — script regenerable
  - `output-entities-real.json` — 18 entidades finales (output real, no dry-run)
  - `output-summary-real.md` — resumen para chat

- **README actualizado** — incluye setup del `finalize-api/`, contrato del endpoint, ejemplos de `LLM_BASE_URL` para OpenAI/OpenRouter/Groq, y roadmap actualizado

**Validación end-to-end (real-mode):**

| Métrica | Valor |
|---|---|
| Filas | 18 |
| Modo | real (LLM + /finalize) |
| Provider LLM | OpenRouter · `~deepseek/deepseek-v4-flash-latest` |
| Exitosas | **18 (100%)** |
| Fallidas | 0 |
| Duración | 277.4s (~10.8s/fila con concurrencia=5) |

**Outputs destacados (3 entidades generadas con nombres semánticos diferentes):**

| # | Entidad | entityName |
|---|---|---|
| 1 | Afinación mayor (José Hernández, Toyota Corolla 2020) | `OrdenTrabajo` |
| 4 | Reemplazo de batería (Mario Ñuñez) | `OrdenServicio` |
| 11 | Reparación de transmisión (Laura Zúñiga, Kia Sportage) | `OrdenReparacion` |

`id` finales son UUID v7 reales generados server-side, `lifecycle.createdAt`/`updatedAt` ISO 8601, placeholders `RESERVED_FOR_SYSTEM` reemplazados sin residuo.

**Cambios en control de versiones:**

- v0.0.1 commit: `569fbfc` ("v0.0.1: finalize-api MVP + sample XLSX + real-mode pipeline")
- tag `v0.0.1` anotado, pusheado a `eortizs/ume-json-v1`

**Pendientes para v0.1.0:**

- [ ] Modo `--deterministic` (camino B sin LLM)
- [ ] Modo `--hybrid` (camino C: LLM analiza 5 filas → genera transformer → ejecuta batch)
- [ ] Soporte directo para CSV y JSON
- [ ] Idempotencia vía hash de archivo + `Idempotency-Key` header en `/finalize`
- [ ] Tests Jest con XLSX sintéticos
- [ ] GitHub Actions: validar `node --check` + AJV schema smoke en cada push
- [ ] Branch protection en `main` (require PR + 1 review)
- [ ] Demo público (un caso real, no solo taller mecánico)

## v0.0.0 — 2026-08-13 · Initial release

**Pipeline base `XLSX → umeJSON → DB`:**

- **Skill `umejson`** (live en workshop OpenClaw · ID `umejson-20260813-554b7c62e0`)
  - Especificación de referencia del formato `umeJSON`
  - 7 pasos de transformación documentados en tercera persona
  - Few-shot canónico, contrato de salida, envoltura `__diagnostic`
  - Rúbricas explícitas: cardinalidad conservadora, tipado de números, `state.current`

- **`process-xlsx.mjs`** (pipeline principal)
  - Lee XLSX con magic-number validation (límite 50 MB)
  - Parsea con tipos nativos (`raw: true`): numbers, dates, strings
  - Modo `--dry-run`: transformación local determinista (sin LLM, sin API)
  - Modo real: LLM (OpenAI-compatible, default `gpt-4o-mini`) + `temperature: 0` + `response_format: json_object`
  - Concurrencia limitada (5 LLM calls simultáneas vía `p-limit`)
  - Llama `POST /api/v1/ume-json/finalize` por cada umeJSON
  - 3 tipos de failure reportados por fila: `diagnostic`, `normalize_fail`, `finalize_fail`
  - Output: JSON con entidades DB-ready + Markdown resumen

- **`umejson-spec.md`** — copia local de la skill, usada como system prompt del LLM

- **API `/finalize`** (snippet del usuario, no desplegado)
  - 5 críticos pendientes: auth, schema completo, deep clone, `__diagnostic` handler, `deletedAt` validación

**Smoke test:** XLSX de 3 filas (incluyendo filas con campos null/vacíos) → 3/3 entidades procesadas en <1ms, tipos nativos correctos.

**Pendientes para v0.1.0:**
- [ ] Levantar API `/finalize` con los 5 críticos resueltos
- [ ] Probar el pipeline con un XLSX real (no sintético)
- [ ] Modo `--deterministic` (camino B sin LLM)
- [ ] Modo `--hybrid` (camino C: LLM analiza 5 filas → genera transformer → ejecuta batch)
- [ ] Soporte directo para CSV y JSON
- [ ] Idempotencia vía hash de archivo
- [ ] Tests Jest con XLSX sintéticos