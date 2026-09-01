# Persistencia — Modelo Head + Journal

Documento de referencia para la persistencia de entidades `umeJSON` en
PostgreSQL. Este documento es la **fuente de verdad** del diseño de
persistencia: el DDL incluido es normativo y cualquier implementación
(SQL directo, ORM o migración) debe reproducir exactamente estas tablas,
columnas e índices.

Está escrito en estilo declarativo y normativa en tercera persona para que
pueda ser consumido por implementadores humanos y por **cualquier agente IA,
independientemente del framework, proveedor o herramienta** que lo utilice.
Las reglas no dependen de ningún producto y son verificables de forma
automática.

Para el formato del documento ver [umejson-spec.md](../process-xlsx/umejson-spec.md).
Para el diseño general del sistema ver [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. Principio rector

Cada entidad es, en sentido lógico, su propia base de datos: todo lo que le
pertenece (datos vigentes, relaciones, documentación e historial) cuelga de
su `id`. La implementación física en PostgreSQL traduce esta idea con dos
estructuras por entidad:

- **Head** — tabla `entities`: una fila por entidad con el documento umeJSON
  completo (estado vigente). Su forma es estable.
- **Journal (bitácora)** — tabla `entity_events`: historial de comportamiento
  append-only, indexado por entidad y secuencia.

El historial de comportamiento **nunca se embebe** en el documento umeJSON.
El documento representa el *ahora*; la bitácora representa *lo que ocurrió
en el tiempo*. "Base de datos por entidad" es una propiedad lógica (todo es
alcanzable desde el `id` de la entidad), no física: no se crean bases ni
schemas de PostgreSQL por entidad.

## 2. Separación de responsabilidades temporales

| Concepto | Vive en | Qué contiene | Crecimiento |
|---|---|---|---|
| Metadatos del registro | `doc.lifecycle` | `createdAt`, `updatedAt`, `deletedAt`, `version` — contabilidad técnica del registro | Fijo |
| Máquina de estados de negocio | `doc.state` | `current` + `statusLog` (proyección acotada, máx. 20 entradas) | Acotado |
| Historial de comportamiento | `entity_events` | Eventos append-only: cambios de propiedades, transiciones de estado, anotaciones, relaciones, provenance | No acotado |

`lifecycle` es la envoltura técnica del registro y no incorpora semántica
de negocio. `state` describe dónde está la entidad en su ciclo de vida
semántico. El historial completo de comportamiento vive exclusivamente en
la bitácora.

**Motivos de la separación** (referencia para decisiones futuras):

1. El documento tiene tamaño acotado (el límite de body de `/finalize` es
   100 KB); un historial embebido lo revienta.
2. PostgreSQL reescribe la fila completa en cada `UPDATE` (MVCC); historial
   embebido implica reescribir todo el pasado en cada evento nuevo.
3. Las analíticas sobre comportamiento (duración por estado, frecuencia de
   cambios) son SQL sobre la tabla de eventos, no extracción de arrays JSONB.
4. El borrado/anonimización selectivo (GDPR) opera sobre eventos sin
   reescribir el documento.
5. El contrato del documento (schema Ajv, spec del LLM) queda congelado:
   agregar estructura al formato obliga a revalidar specs, few-shots y todo
   lo ya persistido.

## 3. Esquema (DDL normativo)

```sql
-- Head: una fila por entidad
CREATE TABLE entities (
  id          uuid PRIMARY KEY,                 -- UUID v7, generado en /finalize
  entity_name text NOT NULL,                    -- espejo de doc->>'entityName'
  doc         jsonb NOT NULL,                   -- documento umeJSON completo (estado vigente)
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz                      -- soft delete; NULL = vigente
);

CREATE INDEX entities_by_name ON entities (entity_name);
CREATE INDEX entities_doc_gin ON entities USING gin (doc jsonb_path_ops);

-- Journal: bitácora append-only del historial de comportamiento
CREATE TABLE entity_events (
  entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  seq         integer NOT NULL CHECK (seq >= 1),   -- 1, 2, 3... por entidad, sin huecos
  event_type  text NOT NULL,                       -- ver sección 6
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- datos del evento (diff, from/to, etc.)
  actor       text NOT NULL DEFAULT 'system',      -- usuario | sistema | id del proceso/agente
  reason      text,
  occurred_at timestamptz NOT NULL,                -- tiempo de NEGOCIO (cuándo pasó el hecho)
  recorded_at timestamptz NOT NULL DEFAULT now(),  -- tiempo de SISTEMA (cuándo llegó a la DB)
  PRIMARY KEY (entity_id, seq)
);

CREATE INDEX entity_events_by_type ON entity_events (event_type, occurred_at);
```

**Notas de diseño:**

- Las columnas relacionales (`entity_name`, `version`, `created_at`,
  `updated_at`, `deleted_at`) son espejos de `doc` mantenidos en la misma
  transacción. La duplicación es intencional: permite índices B-tree y
  bloqueo optimista sin extraer JSONB. Las columnas relacionales son la
  autoridad para concurrencia e indexado; el documento es la autoridad para
  el contenido.
- `PRIMARY KEY (entity_id, seq)` garantiza orden total y unicidad de la
  secuencia por entidad.
- `ON DELETE CASCADE`: el hard delete de una entidad elimina su bitácora.
  El borrado normal es soft (`deleted_at`); el hard delete es una operación
  administrativa excepcional (GDPR).
- A escala (decenas de millones de eventos): particionar `entity_events`
  por `RANGE (occurred_at)` mensual y archivar particiones frías. No
  particionar antes de tiempo.

## 4. Protocolo de escritura (transacción atómica)

Toda mutación de una entidad se ejecuta como **una sola transacción** con
dos operaciones: actualizar el head y registrar el evento. Los parámetros
`$n` siguen la convención del driver PostgreSQL.

```sql
BEGIN;

-- 1. Actualizar el head con bloqueo optimista
UPDATE entities
SET doc = $nuevo_doc, version = version + 1, updated_at = now()
WHERE id = $id AND version = $version_esperada;
-- 0 filas afectadas = conflicto de concurrencia:
-- releer la entidad, recomputar el cambio y reintentar. Nunca forzar.

-- 2. Registrar el evento (seq monotónico por entidad)
INSERT INTO entity_events (entity_id, seq, event_type, payload, actor, reason, occurred_at)
SELECT $id, coalesce(max(seq), 0) + 1, $tipo, $payload, $actor, $motivo, $occurred
FROM entity_events WHERE entity_id = $id;

COMMIT;
```

**Reglas del protocolo:**

1. El `doc` nuevo ya incluye `lifecycle.version = version + 1` y
   `lifecycle.updatedAt` consistentes con las columnas relacionales.
2. El fallo del `UPDATE` por versión aborta la transacción completa:
   no se registra evento sin head nuevo, ni head nuevo sin evento.
3. El alta de una entidad (`INSERT INTO entities` + evento `created`)
   sigue el mismo patrón: dos operaciones, una transacción.

## 5. Invariantes (obligatorias)

Estas reglas son normativas para cualquier implementación, humana o
automatizada. Su cumplimiento es verificable.

1. **Prohibición de historial embebido.** Ninguna colección dentro de `doc`
   crece de forma no acotada. `state.statusLog` tiene un máximo de 20
   entradas. El historial completo vive en `entity_events`.
2. **Append-only.** `entity_events` solo recibe `INSERT`. Está prohibido
   `UPDATE` y `DELETE` sobre eventos existentes. Una corrección se expresa
   como evento compensatorio que referencia el `seq` corregido en su
   `payload`.
3. **Solo el servidor escribe la bitácora.** Agentes IA y LLM jamás generan
   entradas de bitácora, IDs ni timestamps. Extensión directa de la
   filosofía `RESERVED_FOR_SYSTEM` del formato: la capa de persistencia del
   backend es la única fuente de verdad de infraestructura.
4. **Atomicidad.** Head y evento se escriben en la misma transacción
   (sección 4).
5. **Bloqueo optimista obligatorio.** Todo `UPDATE` de `entities` incluye
   `AND version = $esperada`. Un resultado de 0 filas es un conflicto que
   se resuelve reintentando con estado fresco.
6. **Secuencia monotónica.** `seq` es por entidad, inicia en 1 y no tiene
   huecos ni duplicados (la PK compuesta lo garantiza).
7. **Bitemporalidad.** `occurred_at` (tiempo de negocio) y `recorded_at`
   (tiempo de sistema) son obligatorios y semánticamente distintos. Si el
   negocio no declara un tiempo propio, `occurred_at` toma el valor de
   `recorded_at`.
8. **Trazabilidad de actor.** Todo evento registra quién o qué lo produjo
   (`actor`): un usuario, un identificador de sistema o el identificador
   del proceso automatizado que ejecutó la mutación.
9. **Fuente de verdad única.** El historial de comportamiento es
   `entity_events`. `state.statusLog` en el documento es una proyección de
   solo lectura (caché de conveniencia para lectura sin JOIN), nunca una
   segunda fuente.

## 6. Tipos de evento

| `event_type` | `payload` | Cuándo se emite |
|---|---|---|
| `created` | `{ "entityName": "...", "state": "active", "source": "import" }` | Alta de la entidad |
| `property.updated` | `{ "diff": { "costoFinal": { "from": null, "to": 5200 } } }` | Cambio de una o más `dynamicProperties` |
| `state.changed` | `{ "from": "draft", "to": "active" }` | Transición de `state.current` |
| `relation.added` | `{ "targetEntity": "Cliente", "targetId": "CL-552", "context": "realizada_por" }` | Nueva entrada en `relations` |
| `annotation.added` | `{ "text": "Cliente confirma entrega parcial" }` | Nota de comportamiento sin cambio de datos |
| `imported.from` | `{ "file_hash": "sha256:...", "row_idx": 4 }` | Ingesta: provenance de la importación |
| `correction` | `{ "ref_seq": 7, "text": "..." }` | Evento compensatorio sobre un evento previo |

La lista es cerrada: un tipo nuevo requiere actualizar este documento antes
de usarse. La variabilidad va en `payload` (JSONB), no en columnas.

## 7. Ejemplo canónico

Entidad `OrdenTrabajo` creada por importación y luego actualizada. Estado
del head (`entities`, `version = 3`):

```json
{
  "id": "0195a2f3-7c1b-7be3-9f2a-3d84c1e55601",
  "entityName": "OrdenTrabajo",
  "dynamicProperties": {
    "idOrden": "OT-2026-0001",
    "costoEstimado": 4500,
    "costoFinal": 5200,
    "pagado": false
  },
  "lifecycle": {
    "createdAt": "2026-09-01T12:00:00.000Z",
    "updatedAt": "2026-09-01T15:30:00.000Z",
    "version": 3
  },
  "relations": [
    { "targetEntity": "Cliente", "targetId": "CL-552", "type": "many-to-one", "context": "solicitada_por" }
  ],
  "state": {
    "current": "en_proceso",
    "statusLog": [
      { "status": "active", "timestamp": "2026-09-01T12:00:00.000Z", "reason": "Importación taller-mecanico-ordenes.xlsx" },
      { "status": "en_proceso", "timestamp": "2026-09-01T14:10:00.000Z", "reason": "Mecánico inicia trabajo" }
    ]
  },
  "markdownDocumentation": "### OrdenTrabajo - OT-2026-0001 ..."
}
```

Bitácora asociada (`entity_events`, ordenada por `seq`):

| seq | event_type | payload (resumen) | actor | occurred_at | recorded_at |
|---|---|---|---|---|---|
| 1 | `imported.from` | `{file_hash: "sha256:e321...", row_idx: 4}` | `llm-import` | 2026-07-15 | 2026-09-01T12:00 |
| 2 | `created` | `{entityName: "OrdenTrabajo", state: "active", source: "import"}` | `llm-import` | 2026-07-15 | 2026-09-01T12:00 |
| 3 | `property.updated` | `{diff: {costoFinal: {from: null, to: 5200}}}` | `usuario:roberto` | 2026-09-01T14:00 | 2026-09-01T14:00 |
| 4 | `state.changed` | `{from: "active", to: "en_proceso"}` | `usuario:roberto` | 2026-09-01T14:10 | 2026-09-01T14:10 |

Observar: la fila del XLSX correspondía a una orden ingresada el
2026-07-15, importada el 2026-09-01 — por eso `occurred_at` ≠ `recorded_at`
en los eventos de creación. La versión del head (3) refleja las mutaciones
posteriores a la creación.

## 8. Proyección de `statusLog`

`doc.state.statusLog` se deriva de la bitácora: los eventos `created`
(estado inicial) y `state.changed` (estado destino), últimos 20:

```sql
SELECT payload->>'to' AS status, reason, occurred_at AS timestamp
FROM entity_events
WHERE entity_id = $1 AND event_type = 'state.changed'
UNION ALL
SELECT payload->>'state', reason, occurred_at
FROM entity_events
WHERE entity_id = $1 AND event_type = 'created'
ORDER BY timestamp DESC
LIMIT 20;
```

La proyección se recalcula dentro de la misma transacción de escritura.
Si ambas copias difieren, `entity_events` manda y el documento se corrige.

## 9. Consultas comunes

Historial completo de una entidad:

```sql
SELECT seq, event_type, payload, actor, occurred_at, recorded_at
FROM entity_events WHERE entity_id = $1 ORDER BY seq;
```

Duración promedio por estado:

```sql
WITH transiciones AS (
  SELECT entity_id, payload->>'to' AS estado, occurred_at,
         lead(occurred_at) OVER (PARTITION BY entity_id ORDER BY seq) AS siguiente
  FROM entity_events
  WHERE event_type = 'state.changed'
)
SELECT estado, avg(siguiente - occurred_at) AS duracion_promedio
FROM transiciones WHERE siguiente IS NOT NULL
GROUP BY estado;
```

Reconstrucción punto-instante: aplicar en orden los eventos con
`occurred_at <= T` sobre el estado inicial (patrón replay). Para entidades
con muchos eventos, materializar snapshots cada N eventos (p. ej. 100) en
una tabla `entity_snapshots` opcional — fuera del alcance de este documento
hasta que el volumen lo justifique.

## 10. Qué NO cambia del contrato umeJSON

Este diseño no modifica el pipeline existente (`process-xlsx` → `/finalize`)
ni el JSON Schema. El único ajuste al formato es la regla de acotamiento de
`state.statusLog` (máx. 20 entradas, proyección de la bitácora), registrada
en `umejson-spec.md`. La decisión vive exclusivamente en la capa de
persistencia, correspondiente al ítem de roadmap v0.2.0.

## 11. Criterio de aceptación

Un implementador (humano o agente IA) entiende este documento
correctamente cuando puede, sin información adicional:

1. Crear las tablas exactamente como define la sección 3.
2. Ejecutar una mutución completa (head + evento) siguiendo la sección 4.
3. Citar qué invariante prohíbe embeber historial en el documento
   (invariante 1) y quién tiene permitido escribir la bitácora
   (invariante 3).
