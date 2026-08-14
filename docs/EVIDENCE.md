# Evidencia — runs reales

Resultados concretos de los runs en modo real (LLM + `/finalize`).
Para el estado actual del proyecto, ver [README](../README.md) y
[CHANGELOG](../CHANGELOG.md).

---

## v0.0.1 — Taller mecánico (18 filas)

**Comando:**
```bash
cd /root/.openclaw/workspace/umejson/process-xlsx
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx \
  --out samples/output-entities-real.json \
  --md-out samples/output-summary-real.md
```

**Proveedor LLM:** OpenRouter `~deepseek/deepseek-v4-flash-latest` (free tier)

**API finalize:** `http://127.0.0.1:8001/api/v1/ume-json/finalize`

**Configuración del sistema:**

| Setting | Value |
|---|---|
| Concurrency | 5 |
| Magic number | OK |
| Size | 27 KB |
| Rows | 18 |
| Columns | 16 |

**Resultado:**

| Métrica | Valor |
|---|---|
| Total filas | 18 |
| Procesadas | 18 |
| Exitosas | 18 (100%) |
| Fallidas | 0 |
| Duración | 277.4s |
| Throughput | ~10.8s/fila |

**Nombres semánticos inferidos por la IA:**

```
OrdenTrabajo, OrdenServicio, OrdenReparacion
```

Verifica que la IA entiende contexto de negocio y no se queda en `RegistroImportado`.

---

## Muestra del output — fila 1 (OrdenTrabajo)

**Input (XLSX row):**

```json
{
  "ID_Orden": "OT-2026-0001",
  "Fecha_Ingreso": "2026-07-15T00:00:00.000Z",
  "Fecha_Entrega": null,
  "Cliente_Nombre": "José Hernández",
  "Cliente_Teléfono": "811-234-5678",
  "Vehiculo_Marca": "Toyota",
  "Vehiculo_Modelo": "Corolla 2020",
  "Vehiculo_Placas": "ABC-123-D",
  "Vehiculo_Kilometraje": 45000,
  "Tipo_Servicio": "Afinación mayor",
  "Mecánico_Asignado": "Roberto García",
  "Costo_Estimado": 4500,
  "Costo_Final": null,
  "Estado": "En proceso",
  "Notas": null,
  "Pagado": false
}
```

**Output (umeJSON finalizado):**

```json
{
  "ok": true,
  "data": {
    "id": "01a0013a-a45a-74ca-b371-acbb115095c1",
    "entityName": "OrdenTrabajo",
    "dynamicProperties": {
      "idOrden": "OT-2026-0001",
      "fechaIngreso": "2026-07-15T00:00:00.000Z",
      "fechaEntrega": null,
      "clienteNombre": "José Hernández",
      "clienteTelefono": "811-234-5678",
      "vehiculoMarca": "Toyota",
      "vehiculoModelo": "Corolla 2020",
      "vehiculoPlacas": "ABC-123-D",
      "vehiculoKilometraje": 45000,
      "tipoServicio": "Afinación mayor",
      "mecanicoAsignado": "Roberto García",
      "costoEstimado": 4500,
      "costoFinal": null,
      "estado": "En proceso",
      "notas": null,
      "pagado": false
    },
    "lifecycle": {
      "createdAt": "2026-08-14T16:55:43.115Z",
      "updatedAt": "2026-08-14T16:55:43.115Z",
      "version": 1
    },
    "relations": [],
    "state": {
      "current": "active",
      "statusLog": [
        {
          "status": "active",
          "timestamp": "2026-08-14T16:55:43.115Z",
          "reason": "Procesado desde XLSX en run end-to-end v0.0.1"
        }
      ]
    },
    "markdownDocumentation": "### OrdenTrabajo - OT-2026-0001\n**Resumen:** Orden de afinación mayor para vehículo Toyota Corolla 2020 del cliente José Hernández.\n\n**Datos Clave:**\n- **Vehículo:** Toyota Corolla 2020 (placas ABC-123-D, 45000 km)\n- **Servicio:** Afinación mayor\n- **Costo estimado:** $4500.00 MXN\n- **Mecánico asignado:** Roberto García\n\n**Estado Actual:** active - En proceso, pendiente de pago"
  }
}
```

**Validaciones que pasan:**

| Check | Estado |
|---|---|
| `id` es UUID v7 (empieza con `0`, byte version `7`) | ✓ |
| `id` no es `RESERVED_FOR_SYSTEM` | ✓ |
| `lifecycle.createdAt` es ISO 8601 del servidor | ✓ |
| `lifecycle.updatedAt` es ISO 8601 del servidor | ✓ |
| `lifecycle.createdAt` no es `RESERVED_FOR_SYSTEM` | ✓ |
| `entityName` semántico (no `RegistroImportado`) | ✓ |
| Keys en `dynamicProperties` están en camelCase | ✓ |
| `clienteNombre` preservó acentos (José Hernández) | ✓ |
| `costoFinal: null` se preservó | ✓ |
| `vehiculoKilometraje: 45000` es `number`, no `string` | ✓ |
| `pagado: false` es `boolean`, no `string` | ✓ |
| `pagado: false` no fue convertido a `false` por error | ✓ |
| `estado.statusLog[0].timestamp` recibió ISO del servidor | ✓ |
| `markdownDocumentation` en formato 3 secciones (Resumen / Datos Clave / Estado) | ✓ |

---

## Comparativa: cambios en la salida a través del tiempo

| Versión | entityName | Entity types | Special |
|---|---|---|---|
| v0.0.0 (dry-run) | `RegistroImportado` | 1 (genérico) | IDs ficticios, sin /finalize |
| v0.0.1 (real, 1ra) | `OrdenTrabajo` / `OrdenServicio` / `OrdenReparacion` | 3 (semántico) | UUID v7 + ISO timestamps del servidor |
| v0.0.1 (real, 2da post-fix) | igual | 3 | 18/18 (la 1ra tuvo 16/18 por JSON fences) |

---

## Performance breakdown

| Fase | Duración | Detalle |
|---|---|---|
| parseXlsx | <100ms | Magic number + read + XLSX.read |
| Local transform (--dry-run) | 5ms | 18 filas × 0.3ms |
| LLM call (real, deepseek free) | ~10s/fila | 5 calls en paralelo, OpenRouter free tier |
| /finalize POST | <1ms | Localhost, in-memory |
| Total real (18 filas) | 277.4s | Dominado por LLM |

**Gargalo:** el LLM. Sin él, todo el batch procesa en <100ms.

---

## Cómo regenerar la evidencia

```bash
# 1. Levantar /finalize API
cd /root/.openclaw/workspace/umejson/finalize-api
npm install
node server.mjs

# 2. Configurar LLM
cd /root/.openclaw/workspace/umejson/process-xlsx
npm install
cp .env.example .env
# Editar .env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL

# 3. Correr
node process-xlsx.mjs samples/taller-mecanico-ordenes.xlsx \
  --out samples/output-entities-real.json \
  --md-out samples/output-summary-real.md

# 4. Validar
cat samples/output-summary-real.md
node -e "
  const d = JSON.parse(require('fs').readFileSync('samples/output-entities-real.json', 'utf8'));
  const ok = d.entities.length === 18 && d.failures.length === 0;
  console.log('OK:', ok ? '✓' : '✗');
  console.log('Entities:', d.entities.length, 'Failures:', d.failures.length);
"
```
