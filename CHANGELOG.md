# Changelog — ume-json-v1

Todas las modificaciones relevantes a este proyecto se documentan aquí.

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