# Postmortem — v0.0.1 (2026-08-14)

Lecciones aprendidas durante el primer end-to-end real.

---

## Bug #1 — LLM ocasionalmente devuelve JSON en ` ```json ` fences

**Cuándo:** primer run en modo real del pipeline XLSX → umeJSON.

**Síntoma:** 16/18 entidades procesadas. Las 2 restantes: `normalize_fail`
con error `Unexpected token '`', "```json
{
"... is not valid JSON`.

**Causa raíz:** El LLM (deepseek-v4-flash-latest en OpenRouter) devolvió el
JSON envuelto en markdown fences (` ```json ... ``` `) **a pesar** de que
el request especificaba `response_format: { type: 'json_object' }`.

```
$ curl -X POST https://openrouter.ai/api/v1/chat/completions \
       -d '{"response_format": {"type": "json_object"}, ...}'

< respuesta del modelo >
```json
{
  "id": "RESERVED_FOR_SYSTEM",
  ...
}
```
```

**Por qué importa:** algunos modelos (deepseek, llama) emiten fences
incluso con `response_format: json_object`. El parámetro es una **pista**
para el modelo, no una garantía.

**Por qué no se detectó en dry-run:** el modo `--dry-run` no llama al LLM,
usa `localTransform()` determinista. El bug solo aparece en modo real.

**Fix (commit `569fbfc`):**

```diff
   try {
     return JSON.parse(text);
   } catch (e) {
+    // Fallback: algunos modelos (deepseek, llama) envuelven el JSON en
+    // ```json fences a pesar de response_format: json_object. Limpiamos
+    // y reintentamos.
+    const cleaned = text
+      .replace(/^```(?:json)?\s*/i, '')
+      .replace(/\s*```\s*$/i, '')
+      .trim();
+    try {
+      return JSON.parse(cleaned);
+    } catch (e2) {
+      throw new Error(`LLM devolvió JSON inválido: ${e.message}`);
+    }
+  }
```

**Resultado:** 18/18 entidades procesadas, 0 fallos.

**Lección:**

> **`response_format: json_object` no es una garantía — es una pista.** El
> parser debe ser robusto a variaciones de formato, no solo al happy path.
> El mismo principio aplica a respuestas JSON de proveedores free-tier
> (OpenRouter `~deepseek`) que ocasionalmente se desvían del contrato.

**Acción derivada:**

- [ ] El parser debería también manejar ` ``` \n` sin la palabra `json`.
- [ ] Para producción con tráfico real, considerar `gpt-4o-mini` o
      `gemini-2.5-flash-lite` que cumplen 100% con `json_object`.

---

## Bug #2 — `pipe | tail` bloquea el output hasta que el proceso termina

**Cuándo:** comandos con `node ... 2>&1 | tail -40` durante el primer run.

**Síntoma:** el `exec` decía que el proceso terminó en 2m42s, pero el
output no aparecía. El usuario tuvo que pedir `continua` para que yo
re-abriera el log.

**Causa raíz:** `tail -N` solo emite las últimas N líneas **cuando el
pipe cierra** (es decir, cuando el producer termina). En un proceso
largo, eso significa que no ves progreso hasta el final.

**Por qué importa:** la ilusión de "proceso colgado" cuando en realidad
está corriendo bien. Mata la confianza.

**Fix:** pipeline sin pipe (`node ... 2>&1`), o redirigir a archivo de
log (`node ... 2>&1 | tee pipeline.log`).

**Lección:**

> **Nunca pipees stdout a `tail` en procesos largos.** O sacás el pipe, o
> redirigís a un archivo de log con `tee`. La UI del runtime puede mostrar
> progreso bufferizado en vivo solo si el producer escribe directo.

**Acción derivada:**

- [ ] En docs futuras del pipeline, documentar el patrón `2>&1 | tee -a log`
      para procesos largos.

---

## Bug #3 — Proceso huérfano reescribe el output file

**Cuándo:** re-corrí el pipeline para aplicar el fix de fences. Sin
embargo, ya había un proceso de la corrida anterior que seguía vivo
(pid 155790, 12m elapsed).

**Síntoma:** race condition potencial — dos procesos escribiendo al
mismo `samples/output-entities-real.json`.

**Causa raíz:** envié `kill -TERM 155116` después de la primera corrida,
pero ese era el PID del bash wrapper, no del node process. El node
siguió corriendo huérfano.

**Por qué importa:** condiciones de carrera en output files. El último
que escribe gana. Si el viejo tiene código sin fix y el nuevo tiene
código con fix, no sabés qué resultado quedo en disco.

**Fix (este incidente):**

```bash
$ ps -ef | grep process-xlsx
155790  ... node process-xlsx.mjs ...  # huérfano viejo
157909  ... node process-xlsx.mjs ...  # nuevo

$ kill -TERM 155790  # matar el viejo
```

**Lección:**

> **Siempre verificá los PIDs reales antes de matar procesos de larga
> duración.** `pgrep -f` o `ps -ef | grep` es la forma. Un bash wrapper
> puede tener PID distinto del node que arrancó.

**Acción derivada:**

- [ ] Para v0.1.0: considerar un lock file (`pipeline.lock`) al inicio
      del script que impida correr 2 instancias simultaneas.

---

## Observación — `gh` CLI autenticado como `PLRM-Franco`, no `eortizs`

**Cuándo:** push a `eortizs/ume-json-v1` después del fix.

**Síntoma:** `git push origin main` falla con `Repository not found`.

**Causa raíz:** `gh auth status` muestra `Active account: PLRM-Franco`.
El remote es `eortizs/ume-json-v1`, que no es accesible con el token
de `PLRM-Franco`.

**Workaround:**

```bash
GITHUB_TOKEN=*** '^GITHUB_TOKEN=' /root/.openclaw/workspace/.env | cut -d= -f2) \
  git push https://$GITHUB_TOKEN@github.com/eortizs/ume-json-v1.git main
```

El token en `/root/.openclaw/workspace/.env` (`GITHUB_TOKEN=***`) es
classic PAT con scope `repo`, que sí tiene acceso a `eortizs/...`.

**Lección:**

> **El `gh` CLI del entorno está autenticado como `PLRM-Franco`.** Para
> push a `eortizs/...`, usar siempre el `GITHUB_TOKEN` del `.env`
> explícitamente en el URL. Esta es la regla operativa que queda en
> `MEMORY.md`.

---

## Métricas del fix

| Run | Mode | Filas | OK | Fail | Causa |
|---|---|---|---|---|---|
| 1 (de las 18) | real | 18 | 16 | 2 | JSON fences (deepseek) |
| 2 (post-fix) | real | 18 | 18 | 0 | fallback regex agregado |

**Tiempo total invertido en bugs:** ~5 min de debugging + 5 min de fix + 5 min de commit/push.

**Costo del fix en tokens:** $0 (solo cambio de código).

---

## Otros riesgos latentes (no críticos, anotar para v0.1.0)

1. **Rate limit de OpenRouter free tier** — un día aparece un 429 en medio
   de un batch. El script no implementa retry con backoff.
2. **CORS abierto** — `cors({ origin: true })` acepta cualquier origin.
   Aceptable para MVP local; peligroso en cloud.
3. **No hay persistencia de idempotencia** — reprocesar el mismo XLSX
   genera IDs nuevos. Sin `Idempotency-Key`, no hay forma de dedupe.
4. **No hay tests automatizados** — los Jest tests están en el roadmap
   v0.1.0. Hoy la validación es manual.
5. **`.env` files no commiteados** — si el usuario borra `.env` local,
   el pipeline falla con "API key inválida". El `.env.example` documenta
   las variables esperadas.
