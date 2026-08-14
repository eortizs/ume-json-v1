# umejson

Pipeline canónico para transformar registros crudos (XLSX, CSV, JSON, API) en entidades `umeJSON` listas para persistir.

## Componentes

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐    ┌──────────┐
│  XLSX / CSV     │ →  │  process-xlsx    │ →  │  /api/v1/       │ →  │   DB     │
│  (registros     │    │  (skill + LLM)   │    │  ume-json/      │    │ (lista   │
│   crudos)       │    │                  │    │  finalize       │    │ p/guardar│
└─────────────────┘    └──────────────────┘    └─────────────────┘    └──────────┘
                              │
                              ↓
                       ┌──────────────┐
                       │  umejson     │
                       │  skill       │
                       │ (en workshop)│
                       └──────────────┘
```

| Pieza | Qué hace | Dónde vive |
|---|---|---|
| **Skill `umejson`** | Especificación de referencia del formato + reglas de transformación | Workshop de OpenClaw (live) |
| **`process-xlsx.mjs`** | Pipeline que toma un XLSX, lo transforma fila por fila usando el skill + LLM, llama al finalize, devuelve entidades DB-ready | `process-xlsx/` |
| **`umejson-spec.md`** | Copia local de la skill — se usa como `system` prompt para el LLM | `process-xlsx/` |
| **API `/finalize`** | Valida el umeJSON contra schema Ajv + inyecta UUID v7 + timestamps reales | (pendiente — provee tu equipo backend) |

## Setup

```bash
cd /root/.openclaw/workspace/umejson/process-xlsx

# 1. Instalar dependencias
npm install

# 2. Copiar y editar el .env
cp .env.example .env
# Editar .env con UMEJSON_FINALIZE_KEY, LLM_API_KEY, etc.

# 3. Validar contra un XLSX sin gastar LLM
node process-xlsx.mjs /ruta/al/archivo.xlsx --dry-run --limit 5

# 4. Cuando esté OK, correr real
node process-xlsx.mjs /ruta/al/archivo.xlsx --out entities.json --md-out resumen.md
```

## CLI

```
node process-xlsx.mjs <archivo.xlsx> [opciones]
```

| Flag | Descripción |
|---|---|
| `--dry-run` | Sin LLM, sin `/finalize`. Solo parsea XLSX + transformación local. Útil para validar antes de gastar dinero. |
| `--limit N` | Procesa solo las primeras N filas (test rápido). |
| `--out path.json` | Escribe entidades a archivo (default: stdout). |
| `--md-out path.md` | Escribe resumen Markdown a archivo. Si no se da y hay `--out`, se infiere como `<out>.summary.md`. |
| `--json-only` | Solo imprime JSON, no Markdown. |
| `--md-only` | Solo imprime Markdown, no JSON. |

## Output

**JSON** (entidades listas para DB):
```json
{
  "summary": { "file": "...", "total_rows": 847, "succeeded": 832, "failed": 15, "duration_ms": 142000 },
  "entities": [ /* 832 entidades umeJSON con id UUID v7 real */ ],
  "failures": [
    { "idx": 42, "status": "diagnostic", "detail": { "code": "AMBIGUOUS_ENTITY", ... } },
    { "idx": 89, "status": "normalize_fail", "error": "..." },
    { "idx": 102, "status": "finalize_fail", "umeJson": {...}, "error": "..." }
  ]
}
```

**Markdown** (resumen para WhatsApp / chat):
```
| Métrica | Valor |
|---|---|
| Filas totales | 847 |
| Exitosas | 832 (98.2%) |
| Fallidas | 15 |
| Duración | 142s |

## Fallos (15)
| # | idx | status | detalle |
|---|---|---|---|
| 1 | 43 | diagnostic | AMBIGUOUS_ENTITY: ... |
| 2 | 90 | normalize_fail | ... |
| ... |
```

## Pipeline interno (resumen)

1. **Lee** el XLSX (límite 50 MB, magic number validado).
2. **Parsea** con `xlsx` package → array de objetos `{ col1: val1, col2: val2, ... }`.
3. Por cada fila (en paralelo, máx 5 simultáneas):
   - **Transforma** a `umeJSON` vía LLM (OpenAI) usando el skill como system prompt.
   - Si el LLM devuelve `__diagnostic`, se reporta como `diagnostic` y se sigue.
   - Si el LLM devuelve JSON inválido, se reporta como `normalize_fail`.
   - **Llama** a `POST /api/v1/ume-json/finalize` con el umeJSON.
   - Si `/finalize` falla (4xx/5xx), se reporta como `finalize_fail`.
4. **Acumula** successes y failures; al final entrega resumen + entidades DB-ready.

**Regla sagrada:** una fila mala NUNCA aborta el batch. Cada fila se reporta individualmente.

## Variables de entorno

| Variable | Default | Notas |
|---|---|---|
| `UMEJSON_FINALIZE_URL` | `http://localhost:8000/api/v1/ume-json/finalize` | Endpoint del API de finalización |
| `UMEJSON_FINALIZE_KEY` | (vacío) | Bearer token. **Obligatorio** en modo real. |
| `LLM_API_KEY` | (vacío) | OpenAI API key. **Obligatorio** fuera de `--dry-run`. |
| `LLM_MODEL` | `gpt-4o-mini` | Modelo a usar. |

## Límites duros

| Límite | Valor | Por qué |
|---|---|---|
| Tamaño archivo | 50 MB | DoS |
| Filas | 100,000 | Memoria + costo LLM |
| Columnas | 50 (warning) | Schema mal formado probable |
| Concurrencia LLM | 5 | Rate limits |

## Roadmap

- [ ] Modo `--deterministic` (camino B sin LLM, solo reglas codificadas)
- [ ] Modo `--hybrid` (camino C: LLM analiza 5 filas → genera transformer → ejecuta batch)
- [ ] Soporte para CSV y JSON directamente
- [ ] Idempotencia vía hash de archivo (`Idempotency-Key` header al `/finalize`)
- [ ] Tests Jest con XLSX sintéticos