# Formatos soportados — reference

Detalle de los formatos que `process-table.mjs` puede consumir. Para el
funcionamiento general, ver [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Resumen

| Formato | Extensión | Tipos preservados | Concurrencia | Magic number |
|---|---|---|---|---|
| XLSX | `.xlsx` | ✓ (numbers, dates, booleans, nulls) | 5 | `50 4B 03 04` (ZIP) |
| CSV | `.csv` | parcial (ver coercion) | 5 | — |
| TSV | `.tsv` | parcial (ver coercion) | 5 | — |
| JSON | `.json` | ✓ (todo nativo) | 5 | — |

---

## XLSX

**Cómo se parsea:** `XLSX.read(buf, { type: 'buffer', cellDates: true })` →
`sheet_to_json({ raw: true, defval: null, blankrows: false })`.

**Tipos preservados:**
- `number` → `number` (int o float)
- `Date` → `Date` (con option `cellDates`)
- `boolean` → `boolean`
- `null` para celdas vacías

**Magic number:** los primeros 4 bytes deben ser `50 4B 03 04` (o variantes
`05 06` / `07 08`). Si no, se rechaza con error claro.

**Limitaciones:**
- Solo XLSX (Excel 2007+). `.xls` legacy (binary OLE2) y `.xlsm` (con macros)
  requieren parsers adicionales — pendientes en v0.2.0.
- Solo la primera hoja (`wb.SheetNames[0]`). Multi-hoja pendiente.

---

## CSV

**Cómo se parsea:** `XLSX.read(buf.toString('utf-8'), { type: 'string', raw: false })`
→ `sheet_to_json` → `coerceCsvBooleans`.

**Tipos:**
- `string` → `string` (sin coerción de tipos nativos)
- `null` para campos vacíos
- Los literales `TRUE` / `FALSE` (case-insensitive) → `boolean` (true/false)
  via `coerceCsvBooleans` después del parseo

**Limitaciones:**
- ❌ `number` siempre llega como `string` (no se distinguió de texto en el CSV)
- ❌ `Date` siempre llega como `string` ISO (no se detecta serial de Excel)
- ❌ Solo coma como separador. Para tab, usar `.tsv`.

**Workaround futuro:** post-procesar con `papaparse` (detecta tipos) o
agregar columna `--type-hints` con mapeo manual.

---

## TSV

Igual que CSV pero con tab (`\t`) como separador. Usa `XLSX.read` con
`FS: '\t'`.

---

## JSON

**Cómo se parsea:** `JSON.parse(buf.toString('utf-8'))` → shape detection.

**Shapes aceptados** (en orden de prioridad):

1. **Array de objetos** — la más simple y común
   ```json
   [ { "foo": 1 }, { "foo": 2 } ]
   ```

2. **Objeto con `rows`** — convención de algunas APIs
   ```json
   { "rows": [ { "foo": 1 }, { "foo": 2 } ] }
   ```

3. **Objeto con `data`** — convención de otras APIs
   ```json
   { "data": [ { "foo": 1 }, { "foo": 2 } ] }
   ```

4. **Objeto con `records`** — convención tabular
   ```json
   { "records": [ { "foo": 1 }, { "foo": 2 } ] }
   ```

5. **Objeto único** — un solo registro
   ```json
   { "foo": 1 }
   ```

**Tipos preservados:** ✓ todos los nativos de JSON (number, string, boolean,
null, array, object).

**Limitaciones:**
- ❌ No soporta JSONL (NDJSON: una línea = un JSON). El parser hace
  `JSON.parse` sobre todo el buffer y falla si hay múltiples líneas.
- ❌ No soporta JSON Schema validation. Asumimos que el input está bien
  formado; cualquier validación es responsabilidad del LLM.

---

## Detección de formato

```
extname(path).toLowerCase()
  ├── .xlsx  → xlsx (magic number check)
  ├── .xls   → xls (no implementado, ver TODO)
  ├── .csv   → csv
  ├── .tsv   → tsv
  ├── .json  → json
  └── otros  → Error: "Formato no soportado"
```

La detección es **por extensión**, no por contenido. Esto significa:

- `.xlsx` renombrado a `.csv` falla (no tiene magic number ZIP)
- `.csv` con JSON adentro falla (no es JSON válido después del parseo)

Si querés forzar formato, agregá un flag `--format=xlsx` (TODO v0.2.0).

---

## Cómo agregar un formato nuevo

1. Agregar `parseFooBuf(buf)` en `process-table.mjs`
2. Mapear la extensión en `detectFormat()`
3. Crear un sample en `samples/`
4. Actualizar `docs/FORMATS.md`

Ejemplo: agregar YAML:

```js
function parseYamlBuf(buf) {
  const yaml = require('js-yaml');
  return yaml.load(buf.toString('utf-8'));
}

function detectFormat(path) {
  const ext = extname(path).toLowerCase().replace(/^\./, '');
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  // ...
}
```

---

## Cuándo usar cada formato

| Caso | Formato recomendado |
|---|---|
| Datos tabulares de Excel | XLSX |
| Export de base de datos / API | CSV o JSON |
| Log estructurado | JSONL (TODO) |
| Spreadsheet多人edición | XLSX (preserva types) |
| Pipeline de datos | JSON (más rico) |
| Streaming / one-record-per-line | NDJSON (TODO) |
