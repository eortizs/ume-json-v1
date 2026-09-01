# umejson — Especificación del Formato

## Descripción

`umeJSON` es el formato canónico para representar entidades en el sistema. Toda entidad umeJSON comparte una misma forma base: los datos específicos del dominio viven en `dynamicProperties`, las conexiones a otras entidades en `relations`, y el historial operativo en `state.statusLog`.

Esta especificación documenta cómo transformar un registro de datos crudo (fila de XLSX/CSV, respuesta de API, texto plano, diccionario clave-valor) en una entidad `umeJSON` válida y persistible.

## Estructura Canónica

Una entidad `umeJSON` válida tiene esta forma:

```json
{
  "id": "RESERVED_FOR_SYSTEM",
  "entityName": "TransaccionVenta",
  "dynamicProperties": { },
  "lifecycle": {
    "createdAt": "RESERVED_FOR_SYSTEM",
    "updatedAt": "RESERVED_FOR_SYSTEM",
    "version": 1
  },
  "relations": [ ],
  "state": {
    "current": "active",
    "statusLog": [ ]
  },
  "markdownDocumentation": "..."
}
```

## Pasos de Transformación

### 1. `entityName` (PascalCase)

Identifica el concepto central de negocio a partir del contexto del registro. Formato: `PascalCase` (ej. `Cliente`, `Factura`, `OrdenCompra`). Si los datos no sugieren un concepto claro, asignar `EntidadGenerica` y registrar el motivo en `state.statusLog[0].reason`.

### 2. `dynamicProperties` (camelCase + tipado)

Mapear todas las columnas del registro original dentro de `dynamicProperties`.

**Limpieza de keys (estricta):**
1. Eliminar acentos (NFD + remove combining marks).
2. Eliminar caracteres especiales (`_`, `-`, `.`, `/`, `?`, `!`, `¿`, etc.) excepto letras, dígitos y espacios.
3. Convertir a `camelCase`.
4. Ejemplos:
   - `Teléfono Móvil` → `telefonoMovil`
   - `ID_Transaccion` → `idTransaccion`
   - `Fecha Factura` → `fechaFactura`
   - `Comentarios.` → `comentarios`

**Tipado de valores (rúbrica):**
- `string` por defecto.
- `integer` si el campo es numérico sin punto decimal y NO es un identificador/código.
- `float` si el campo es numérico con punto decimal y NO es un identificador/código.
- `boolean` si el valor es literalmente `true`, `false`, `sí`, `no`, `yes`, `no`.
- **Mantener como `string`** si el nombre del campo empieza con: `id`, `codigo`, `folio`, `clave`, `zip`, `cp`, `rfc`, `curp`, `cuenta`, `numero`, `ref` (cuando el valor contiene caracteres no numéricos como `TX-9948` o `CL-552`).
- En caso de duda, mantener `string`.

### 3. `relations` (cardinalidad conservadora)

Por cada referencia externa detectada, construir un objeto con esta forma:

```json
{
  "targetEntity": "Cliente",
  "targetId": "CL-552",
  "type": "many-to-one",
  "context": "realizada_por",
  "cardinality_uncertain": false
}
```

- `targetEntity`: nombre de la entidad destino en `PascalCase`.
- `targetId`: ID externo encontrado; el sistema lo mapeará a su identificador canónico en la fase de persistencia.
- `context`: propósito del vínculo en minúsculas y guiones bajos (ej. `pagado_por`, `asignado_a`).

**Reglas de cardinalidad:**
- `many-to-one` (valor por defecto): esta fila referencia a una sola instancia de otra entidad (caso más común: `Factura → Cliente`).
- `one-to-one`: cuando ambos lados tienen IDs únicos y se infiere simetría.
- `one-to-many`: cuando el campo contiene una lista o múltiples IDs. Rara vez inferible desde una sola fila.
- `many-to-many`: requiere catálogo de entidades.
- Cuando no se pueda determinar con certeza, usar `"many-to-one"` y marcar `cardinality_uncertain: true`.

### 4. `state.current` (rúbrica estricta)

| Condición detectada | Valor |
|---|---|
| Falta `entityName`, o es `EntidadGenerica`, o hay campos numéricos críticos con `null`/vacíos, o hay ambigüedad semántica | `validation_required` |
| Faltan solo campos opcionales (comentarios, notas, tags, metadatos) | `draft` |
| Datos completos, tipos correctos, al menos 1 propiedad dinámica con valor no-vacío | `active` |

El primer elemento de `statusLog` describe el motivo de la asignación.

**Acotamiento:** `statusLog` contiene un máximo de 20 entradas. Es una proyección de solo lectura del historial de comportamiento, cuya fuente de verdad es la bitácora persistida (`entity_events`); el historial completo nunca se embebe en el documento (ver `docs/PERSISTENCE.md`).

### 5. `markdownDocumentation`

Ficha técnica ejecutiva en formato Markdown:

```
### [Entidad] - [Identificador Corto]
**Resumen:** Breve descripción de una línea.
**Datos Clave:**
- *Propiedad 1*: Valor
- *Propiedad 2*: Valor
**Estado Actual:** [Estado] - [Motivo corto]
```

- Usar `null`, `""` o `"N/A"` cuando una propiedad no aplique.
- Limitar `Datos Clave` a un máximo de 5 viñetas.

### 6. Identidad y Trazabilidad

- **Placeholders reservados:** `id`, `lifecycle.createdAt`, `lifecycle.updatedAt`, `state.statusLog[*].timestamp` siempre contienen la cadena literal `"RESERVED_FOR_SYSTEM"`.
- El backend completa estos campos en la fase de persistencia, con identificadores únicos canónicos y marcas de tiempo reales.
- **Excepción:** `lifecycle.version` se inicializa en `1`.

### 7. Formato de Salida

- La salida debe ser única y exclusivamente el objeto JSON resultante.
- Para reportar errores que impiden la transformación, usar la envoltura `__diagnostic` (ver sección final).

---

## Ejemplo Canónico

### Input — Fila 4 de `ventas_2026.xlsx`

```
ID_Transaccion: TX-9948
Fecha Factura: 2026-03-15
Cliente_Ref: CL-552
Nombre del Item: Laptop Pro 16
Cantidad Vendida: 2
Precio_Unitario: 1450.00
Comentarios: Enviar con empaque de regalo. Urgentísimo.
```

### Output Esperado

```json
{
  "id": "RESERVED_FOR_SYSTEM",
  "entityName": "TransaccionVenta",
  "dynamicProperties": {
    "idTransaccion": "TX-9948",
    "fechaFactura": "2026-03-15",
    "nombreDelItem": "Laptop Pro 16",
    "cantidadVendida": 2,
    "precioUnitario": 1450.00,
    "comentarios": "Enviar con empaque de regalo. Urgentísimo."
  },
  "lifecycle": {
    "createdAt": "RESERVED_FOR_SYSTEM",
    "updatedAt": "RESERVED_FOR_SYSTEM",
    "version": 1
  },
  "relations": [
    {
      "targetEntity": "Cliente",
      "targetId": "CL-552",
      "type": "many-to-one",
      "context": "realizada_por",
      "cardinality_uncertain": false
    }
  ],
  "state": {
    "current": "active",
    "statusLog": [
      {
        "status": "active",
        "timestamp": "RESERVED_FOR_SYSTEM",
        "reason": "Entidad creada exitosamente a partir de la importación del archivo de ventas."
      }
    ]
  },
  "markdownDocumentation": "### TransaccionVenta - TX-9948\n**Resumen:** Registro de venta de equipo tecnológico a cliente externo.\n\n**Datos Clave:**\n- **Item:** Laptop Pro 16 (Cantidad: 2)\n- **Total Estimado:** $2900.00\n- **Notas:** Requiere empaque de regalo y envío urgente.\n\n**Estado Actual:** active - Procesado correctamente desde origen."
}
```

---

## Diagnóstico de Errores

Cuando el input no se puede transformar (JSON malformado, XLSX corrupto, schema irreconocible, input vacío), la respuesta es la envoltura `__diagnostic` en lugar del objeto umeJSON:

```json
{
  "__diagnostic": {
    "ok": false,
    "code": "INPUT_UNREADABLE",
    "message": "El input no pudo ser parseado como registro estructurado.",
    "input_hint": "Se esperaba un objeto JSON, fila de CSV o diccionario clave-valor."
  }
}
```

Códigos sugeridos: `INPUT_UNREADABLE`, `EMPTY_INPUT`, `AMBIGUOUS_ENTITY`, `INVALID_TYPES`.

---

## Contrato de Salida

| Campo | Tipo | Requerido | Notas |
|---|---|---|---|
| `id` | string | sí | `"RESERVED_FOR_SYSTEM"` |
| `entityName` | string | sí | `PascalCase` |
| `dynamicProperties` | object | sí | keys en `camelCase`, valores tipados |
| `lifecycle.createdAt` | string | sí | `"RESERVED_FOR_SYSTEM"` |
| `lifecycle.updatedAt` | string | sí | `"RESERVED_FOR_SYSTEM"` |
| `lifecycle.version` | int | sí | inicia en `1` |
| `relations` | array | no | `[]` si no hay relaciones |
| `state.current` | enum | sí | `active` \| `draft` \| `validation_required` |
| `state.statusLog` | array | sí | 1 a 20 elementos; proyección de la bitácora |
| `markdownDocumentation` | string | sí | Markdown estructurado |
| `__diagnostic` | object | no | solo presente en errores |

---

## Reglas de Validación del Formato

- **`entityName`** debe estar en `PascalCase` y no contener espacios ni caracteres especiales.
- **`dynamicProperties`** debe tener todas sus keys en `camelCase`.
- **`lifecycle.version`** es siempre un entero positivo que inicia en `1`.
- **`state.current`** solo puede tomar uno de tres valores: `active`, `draft`, `validation_required`.
- **`state.statusLog`** contiene máximo 20 elementos. Ninguna colección del documento crece de forma no acotada; el historial completo vive en la bitácora de la base de datos (`docs/PERSISTENCE.md`).
- **`relations[].type`** solo puede tomar valores del conjunto: `one-to-one`, `one-to-many`, `many-to-one`, `many-to-many`.
- **Identificadores (`id*`, `codigo*`, `folio*`, etc.)** que contengan caracteres no numéricos deben permanecer como `string`.