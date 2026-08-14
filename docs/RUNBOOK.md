# Runbook — operaciones del día a día

Cómo arrancar, monitorear, parar y triggerear el sistema. Para entender
qué hace, ver [ARCHITECTURE.md](./ARCHITECTURE.md). Para ver qué
rompió y cómo, ver [POSTMORTEM.md](./POSTMORTEM.md).

---

## 1. Arranque

### 1.1 `/finalize` API

```bash
cd /root/.openclaw/workspace/umejson/finalize-api
npm install
cp .env.example .env
# Editar .env:
#   PORT=8001
#   HOST=127.0.0.1
#   UMEJSON_FINALIZE_KEY=<random hex de 32+ chars>

# Foreground (debug)
node server.mjs

# Background (PM2)
pm2 start server.mjs --name umejson-finalize-api
pm2 save

# Background (bare)
nohup node server.mjs > logs/finalize.log 2>&1 &
```

**Smoke check:**

```bash
curl http://127.0.0.1:8001/health
# Esperado: {"ok":true,"service":"umejson-finalize-api","version":"0.1.0",...}
```

### 1.2 `process-xlsx` pipeline

```bash
cd /root/.openclaw/workspace/umejson/process-xlsx
npm install
cp .env.example .env
# Editar .env:
#   UMEJSON_FINALIZE_URL=http://127.0.0.1:8001/api/v1/ume-json/finalize
#   UMEJSON_FINALIZE_KEY=<el mismo que en finalize-api/.env>
#   LLM_BASE_URL=https://api.openai.com/v1   # o openrouter, groq, etc.
#   LLM_API_KEY=<key del proveedor>
#   LLM_MODEL=<modelo>
```

**Validación sin gastar LLM:**

```bash
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx \
  --dry-run --limit 5
# Esperado: 5/5 en <100ms
```

**Run real:**

```bash
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx \
  --out samples/output-entities-real.json \
  --md-out samples/output-summary-real.md
```

---

## 2. Monitoreo

### 2.1 `/finalize` API

```bash
# Logs estructurados (stdout)
tail -f /path/to/finalize.log | jq '.'

# Métricas básicas
curl -s http://127.0.0.1:8001/health | jq

# Tasa de errores (últimas 100 requests)
grep -c '"status":4' /path/to/finalize.log  # 4xx
grep -c '"status":5' /path/to/finalize.log  # 5xx
```

### 2.2 Pipeline

```bash
# Mientras corre, el script escribe a stderr:
# [start] archivo=... hash=... dryRun=false
# [parse] N filas (procesando M)
# [done] X/Y exitosas en N s
# [write] entidades → path
# [write] resumen  → path

# Si querés ver progreso en vivo, redirigí a log:
node process-xlsx.mjs ... 2>&1 | tee pipeline.log
```

---

## 3. Kill / restart

### 3.1 `/finalize` API

```bash
# Por nombre
pkill -f 'node server.mjs'

# Por PID (PM2)
pm2 restart umejson-finalize-api
pm2 stop umejson-finalize-api

# Verificar
ps -ef | grep 'node server.mjs' | grep -v grep
```

### 3.2 Pipeline

```bash
# Ver los que están corriendo
ps -ef | grep process-xlsx | grep -v grep

# Matar todos
pkill -f process-xlsx

# Matar uno específico
kill -TERM <PID>
```

⚠️ **Cuidado con procesos huérfanos** — ver
[POSTMORTEM.md#bug-3](./POSTMORTEM.md#bug-3--proceso-huérfano-reescribe-el-output-file).
Múltiples procesos escribiendo al mismo output file pueden corromper
resultados.

---

## 4. Cambiar de proveedor LLM

```bash
# 1. Editar process-xlsx/.env
nano /root/.openclaw/workspace/umejson/process-xlsx/.env

# 2. Cambiar 3 variables:
# LLM_BASE_URL=https://api.openai.com/v1
# LLM_API_KEY=sk-...
# LLM_MODEL=gpt-4o-mini

# 3. Validar con --dry-run que sigue parseando
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx --dry-run --limit 3

# 4. Smoke test con 3 filas reales
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx --limit 3 \
  --out /tmp/smoke.json --md-out /tmp/smoke.md

# 5. Comparar contra el run anterior
diff /tmp/smoke.md samples/output-summary-real.md
```

**Combinaciones probadas:**

| Base URL | Provider | Status |
|---|---|---|
| `https://api.openai.com/v1` | OpenAI | ✓ default |
| `https://openrouter.ai/api/v1` | OpenRouter (deepseek free) | ✓ validado en v0.0.1 |
| `https://api.groq.com/openai/v1` | Groq | ⚠️ no validado |
| `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini | ⚠️ no validado |

---

## 5. Rotación de API keys

### 5.1 `UMEJSON_FINALIZE_KEY`

```bash
# 1. Generar nueva key
NEW_KEY=$(openssl rand -hex 32)
echo "Nueva: $NEW_KEY"

# 2. Editar finalize-api/.env
nano /root/.openclaw/workspace/umejson/finalize-api/.env

# 3. Reiniciar API
pkill -f 'node server.mjs'
cd /root/.openclaw/workspace/umejson/finalize-api
nohup node server.mjs > logs/finalize.log 2>&1 &

# 4. Editar process-xlsx/.env
nano /root/.openclaw/workspace/umejson/process-xlsx/.env

# 5. Smoke test
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx --limit 1
```

### 5.2 `LLM_API_KEY`

```bash
# 1. Obtener nueva key del proveedor (OpenAI, OpenRouter, etc.)
# 2. Editar process-xlsx/.env
# 3. Smoke test
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx --limit 1
```

---

## 6. Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:8001` | API no está corriendo | Arrancar `finalize-api` |
| `401 Unauthorized` | API key mismatch | Verificar que `UMEJSON_FINALIZE_KEY` sea idéntico en ambos `.env` |
| `422 sentinel_violation` | LLM inventó un UUID real | Buscar en el spec de la skill; el LLM no debe inventar IDs |
| `422 schema_violation details: [...]` | LLM no siguió el contrato | Revisar `umejson-spec.md`; considerar un modelo más grande |
| `429 rate_limited` | Demasiadas requests | Bajar `CONCURRENCY` en el script |
| `LLM 401` | `LLM_API_KEY` inválida o expirada | Rotar la key |
| `LLM 429` | Rate limit del proveedor LLM | Esperar o cambiar de proveedor |
| `Magic number inválido` | El "XLSX" no es un XLSX | Verificar que el archivo sea un .xlsx legítimo |
| `XLSX demasiado grande` | > 50 MB | Subir el límite o partir el archivo |
| `Demasiadas filas` | > 100 000 | Aumentar `MAX_ROWS` (cuidado con memoria + costo) |
| `JSON.parse` falla con `Unexpected token '\`'` | El LLM ahora emite fences (regresión) | El fallback debería tomarlo; si no, revisar regex |

---

## 7. Backup / restore

**No hay DB.** El sistema es stateless (más allá del `.env` con keys).

**Lo único que se pierde** al borrar `/root/.openclaw/workspace/umejson/`:

- Código (recuperable del repo `eortizs/ume-json-v1`)
- Outputs generados (`samples/output-*.json`) — regenerables con el script
- `.env` files con API keys — **NO commiteados**, hay que regenerar

**Recuperación ante desastre:**

```bash
# 1. Clonar repo
git clone https://github.com/eortizs/ume-json-v1.git
cd ume-json-v1

# 2. Instalar deps
(cd process-xlsx && npm install)
(cd finalize-api && npm install)

# 3. Crear .env desde .env.example
cp process-xlsx/.env.example process-xlsx/.env
cp finalize-api/.env.example finalize-api/.env
# (editar con las keys)

# 4. Arrancar
(cd finalize-api && node server.mjs) &
node process-xlsx/process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx
```

---

## 8. Métricas para alertas

Si montás monitoreo, estas son las señales que importan:

| Señal | Umbral | Acción |
|---|---|---|
| `/finalize` latency (p99) | > 50ms | Optimizar (no es esperable a esta escala) |
| `/finalize` 5xx rate | > 1% | Página al equipo |
| Pipeline success rate | < 95% | Revisar failures, reevaluar LLM |
| Pipeline throughput | < 0.5 filas/s | Considerar Gemini Flash Lite |
| Pipeline duration para 1K filas | > 1h | Cambiar a modo híbrido |
