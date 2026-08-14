# Changelog — ume-json-v1

Todas las modificaciones relevantes a este proyecto se documentan aquí.

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