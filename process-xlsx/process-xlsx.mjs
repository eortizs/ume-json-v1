#!/usr/bin/env node
/**
 * process-xlsx.mjs
 *
 * Pipeline: XLSX → umeJSON (vía skill + LLM) → /finalize → entidades listas para DB.
 *
 * Uso:
 *   node process-xlsx.mjs <path-to-xlsx> [--dry-run] [--limit N] [--out entities.json]
 *
 * Variables de entorno (ver .env.example):
 *   UMEJSON_FINALIZE_URL  → endpoint POST /api/v1/ume-json/finalize
 *   UMEJSON_FINALIZE_KEY  → API key (Bearer token)
 *   LLM_API_KEY           → OpenAI API key (no requerida en --dry-run)
 *   LLM_MODEL             → modelo a usar (default: gpt-4o-mini)
 */

import * as XLSX from 'xlsx';
import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { argv, exit } from 'process';
import { config as loadEnv } from 'dotenv';
import pLimit from 'p-limit';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

loadEnv();

// ============================================================
// Config
// ============================================================
const FINALIZE_URL  = process.env.UMEJSON_FINALIZE_URL || 'http://localhost:8001/api/v1/ume-json/finalize';
const FINALIZE_KEY  = process.env.UMEJSON_FINALIZE_KEY || '';
const LLM_BASE_URL  = process.env.LLM_BASE_URL         || 'https://api.openai.com/v1';
const LLM_API_KEY   = process.env.LLM_API_KEY          || '';
const LLM_MODEL     = process.env.LLM_MODEL            || 'gpt-4o-mini';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ROWS       = 100_000;
const MAX_COLS       = 50;
const CONCURRENCY    = 5;

const limit = pLimit(CONCURRENCY);

// ============================================================
// CLI
// ============================================================
const args = argv.slice(2);

// Acepta tanto `--flag=value` como `--flag value`
function getFlag(name) {
  // Sintaxis con `=`
  const eqArg = args.find(a => a.startsWith(`--${name}=`));
  if (eqArg) return eqArg.split('=').slice(1).join('='); // soporta paths con `=`

  // Sintaxis con espacio (lee el siguiente argumento)
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) {
    const next = args[idx + 1];
    if (!next.startsWith('--')) return next;
  }
  return null;
}

const positional = args.filter(a => !a.startsWith('--'));

const dryRun   = args.includes('--dry-run');
const jsonOnly = args.includes('--json-only');
const mdOnly   = args.includes('--md-only');
const limitArg = parseInt(getFlag('limit') || '0', 10);
const outArg   = getFlag('out');
const mdArg    = getFlag('md-out')
                 || (outArg ? outArg.replace(/\.json$/, '.summary.md') : null);

const filePath = positional[0];
if (!filePath) {
  console.error('Uso: node process-xlsx.mjs <path-to-xlsx> [--dry-run] [--limit N] [--out entities.json]');
  exit(1);
}

// ============================================================
// Skill prompt (umejson specification)
// ============================================================
const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, 'umejson-spec.md');

let SKILL_PROMPT;
try {
  SKILL_PROMPT = (await readFile(SPEC_PATH, 'utf-8')).trim();
} catch (e) {
  console.error(`[error] No se encontró ${SPEC_PATH}. Ese archivo debe contener la especificación umeJSON.`);
  exit(1);
}

// ============================================================
// 1. Validar y parsear el XLSX
// ============================================================
function isValidXlsxMagic(buf) {
  // XLSX = archivo ZIP. Magic number: 50 4B 03 04 (o 05 06 / 07 08 para variantes).
  return buf[0] === 0x50 && buf[1] === 0x4B &&
         [0x03, 0x05, 0x07].includes(buf[2]) &&
         [0x04, 0x06, 0x08].includes(buf[3]);
}

async function parseXlsx(path) {
  const buf = await readFile(path);

  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`XLSX demasiado grande: ${(buf.length / 1024 / 1024).toFixed(1)} MB (máx ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
  }
  if (!isValidXlsxMagic(buf)) {
    throw new Error('Magic number inválido — el archivo no es un XLSX legítimo');
  }

  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('XLSX sin hojas');

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    defval: null,
    raw: true,        // tipos nativos: números como numbers, fechas como Date (con cellDates arriba)
    blankrows: false
  });

  if (rows.length > MAX_ROWS) {
    throw new Error(`Demasiadas filas: ${rows.length} (máx ${MAX_ROWS})`);
  }
  if (rows.length > 0 && Object.keys(rows[0]).length > MAX_COLS) {
    console.warn(`[warn] La primera fila tiene ${Object.keys(rows[0]).length} columnas (recomendado ≤ ${MAX_COLS})`);
  }

  return rows;
}

// ============================================================
// 2. Transformar fila → umeJSON
// ============================================================
async function llmComplete({ system, user }) {
  // OpenAI-compatible (OpenAI, OpenRouter, Groq, etc.). Override base URL con LLM_BASE_URL.
  const url = `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' },
      temperature: 0
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`LLM ${res.status}: ${err.error?.message || JSON.stringify(err)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// Transformador determinista para --dry-run: aplica las reglas mínimas del skill
// sin gastar tokens de LLM. Útil para validar el XLSX antes de pagar transformación real.
function localTransform(row, idx) {
  const camelCase = (s) => s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');

  const dynamicProperties = {};
  for (const [k, v] of Object.entries(row)) {
    dynamicProperties[camelCase(k)] = v;
  }

  return {
    id: 'RESERVED_FOR_SYSTEM',
    entityName: 'RegistroImportado',
    dynamicProperties,
    lifecycle: {
      createdAt: 'RESERVED_FOR_SYSTEM',
      updatedAt: 'RESERVED_FOR_SYSTEM',
      version: 1
    },
    relations: [],
    state: {
      current: 'active',
      statusLog: [{
        status: 'active',
        timestamp: 'RESERVED_FOR_SYSTEM',
        reason: `Fila ${idx + 1} procesada en modo --dry-run (sin LLM).`
      }]
    },
    markdownDocumentation: `### RegistroImportado - Fila ${idx + 1}\n**Resumen:** Transformación local determinista para validación.\n\n**Datos Clave:**\n- *Columnas*: ${Object.keys(row).length}\n- *Modo*: dry-run`
  };
}

async function rowToUmeJson(row, idx) {
  if (dryRun) return localTransform(row, idx);

  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY no configurada — requerida para modo real (sin --dry-run)');
  }

  const text = await llmComplete({
    system: SKILL_PROMPT,
    user: JSON.stringify({ row, idx: idx + 1 }, null, 2)
  });

  try {
    return JSON.parse(text);
  } catch (e) {
    // Fallback: algunos modelos (deepseek, llama) envuelven el JSON en ```json fences
    // a pesar de response_format: json_object. Limpiamos y reintentamos.
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch (e2) {
      throw new Error(`LLM devolvió JSON inválido: ${e.message}`);
    }
  }
}

// ============================================================
// 3. Finalizar (POST a /api/v1/ume-json/finalize)
// ============================================================
async function finalize(umeJson) {
  if (dryRun) {
    // En dry-run no se llama al API; se inyectan valores ficticios para que el output
    // sea coherente y puedas inspeccionar el resultado sin servidor.
    const now = new Date().toISOString();
    const fakeId = `dryrun-${createHash('sha256').update(JSON.stringify(umeJson)).digest('hex').slice(0, 24)}`;
    return {
      ...umeJson,
      id: fakeId,
      lifecycle: { ...umeJson.lifecycle, createdAt: now, updatedAt: now },
      state: {
        ...umeJson.state,
        statusLog: umeJson.state.statusLog.map(log => ({ ...log, timestamp: now }))
      }
    };
  }

  const res = await fetch(FINALIZE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${FINALIZE_KEY}`
    },
    body: JSON.stringify(umeJson)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`finalize ${res.status}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

// ============================================================
// 4. Orquestador
// ============================================================
async function processXlsx(path) {
  const fileHash = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 16);
  console.error(`[start] archivo=${path} hash=${fileHash} dryRun=${dryRun}`);

  const rows = await parseXlsx(path);
  const targetRows = limitArg > 0 ? rows.slice(0, limitArg) : rows;
  console.error(`[parse] ${rows.length} filas (procesando ${targetRows.length})`);

  const startTime = Date.now();

  const results = await Promise.allSettled(
    targetRows.map((row, idx) =>
      limit(async () => {
        let umeJson;
        try {
          umeJson = await rowToUmeJson(row, idx);
        } catch (e) {
          return { idx, status: 'normalize_fail', error: e.message };
        }

        if (umeJson?.__diagnostic) {
          return { idx, status: 'diagnostic', detail: umeJson.__diagnostic };
        }

        try {
          const finalized = await finalize(umeJson);
          return { idx, status: 'success', entity: finalized };
        } catch (e) {
          return { idx, status: 'finalize_fail', umeJson, error: e.message };
        }
      })
    )
  );

  const successes = results
    .filter(r => r.status === 'fulfilled' && r.value?.status === 'success')
    .map(r => r.value.entity);
  const failures = results
    .filter(r => r.status === 'fulfilled' && r.value?.status !== 'success')
    .map(r => r.value);

  const summary = {
    file: path,
    file_hash: fileHash,
    dry_run: dryRun,
    total_rows: rows.length,
    processed: targetRows.length,
    succeeded: successes.length,
    failed: failures.length,
    duration_ms: Date.now() - startTime
  };

  console.error(`[done] ${successes.length}/${targetRows.length} exitosas en ${(summary.duration_ms / 1000).toFixed(1)}s`);
  return { summary, entities: successes, failures };
}

// ============================================================
// 5. Output
// ============================================================
function buildMarkdown(result) {
  const { summary, failures } = result;
  const pct = summary.processed > 0
    ? ((summary.succeeded / summary.processed) * 100).toFixed(1)
    : '0.0';

  let md = `# Resumen — ${summary.file}\n\n`;
  md += `| Métrica | Valor |\n|---|---|\n`;
  md += `| Modo | ${summary.dry_run ? 'dry-run' : 'real'} |\n`;
  md += `| Hash | \`${summary.file_hash}\` |\n`;
  md += `| Filas totales | ${summary.total_rows} |\n`;
  md += `| Procesadas | ${summary.processed} |\n`;
  md += `| Exitosas | ${summary.succeeded} (${pct}%) |\n`;
  md += `| Fallidas | ${summary.failed} |\n`;
  md += `| Duración | ${(summary.duration_ms / 1000).toFixed(1)}s |\n\n`;

  if (failures.length > 0) {
    md += `## Fallos (${failures.length})\n\n`;
    md += `| # | idx | status | detalle |\n|---|---|---|---|\n`;
    failures.slice(0, 20).forEach((f, i) => {
      const detail = (f.error || f.detail?.message || '').slice(0, 80);
      md += `| ${i + 1} | ${f.idx + 1} | \`${f.status}\` | ${detail} |\n`;
    });
    if (failures.length > 20) {
      md += `\n_… y ${failures.length - 20} más (ver archivo JSON para detalle)_\n`;
    }
  }

  return md;
}

// ============================================================
// Main
// ============================================================
try {
  const result = await processXlsx(filePath);

  const jsonOut = {
    summary: result.summary,
    entities: result.entities,
    failures: result.failures
  };

  const md = buildMarkdown(result);

  if (outArg) {
    await writeFile(outArg, JSON.stringify(jsonOut, null, 2));
    console.error(`[write] entidades → ${outArg}`);
  }
  if (mdArg) {
    await writeFile(mdArg, md);
    console.error(`[write] resumen  → ${mdArg}`);
  }

  if (!outArg && !mdOnly) {
    console.log(JSON.stringify(jsonOut, null, 2));
  }
  if (!mdArg && !jsonOnly) {
    console.log('\n' + md);
  }

  exit(0);
} catch (e) {
  console.error(`[error] ${e.message}`);
  exit(1);
}