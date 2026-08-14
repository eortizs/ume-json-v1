#!/usr/bin/env node
/**
 * generate-csv-and-json.mjs
 *
 * Lee el XLSX del taller mecánico y emite los formatos equivalentes
 * CSV + JSON (3 shapes) que las pruebas pueden consumir.
 *
 * Uso:
 *   node generate-csv-and-json.mjs
 */

import * as XLSX from 'xlsx';
import { readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const XLSX_PATH = resolve(__dirname, 'taller-mecanico-ordenes.xlsx');
const CSV_PATH  = resolve(__dirname, 'taller-mecanico-ordenes.csv');
const JSON_PATH = resolve(__dirname, 'taller-mecanico-ordenes.json');

const buf = await readFile(XLSX_PATH);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: null });

console.log(`XLSX: ${rows.length} filas`);

// === CSV ===
// Headers en el orden original; valores vacíos → string vacío.
// Para fechas, XLSX con `cellDates: true` devuelve Date → convertimos a ISO.
const csvSheet = XLSX.utils.aoa_to_sheet([
  Object.keys(rows[0]),
  ...rows.map(r => Object.keys(rows[0]).map(k => {
    const v = r[k];
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return v;
  }))
]);
const csv = XLSX.utils.sheet_to_csv(csvSheet);
await writeFile(CSV_PATH, csv, 'utf-8');
console.log(`CSV : ${CSV_PATH} (${csv.length} chars)`);

// === JSON (array directo) ===
// El parser acepta 4 shapes: array, {rows:[]}, {data:[]}, {records:[]}, u objeto único.
// Acá escribimos array (la más simple).
await writeFile(JSON_PATH, JSON.stringify(rows, null, 2), 'utf-8');
console.log(`JSON: ${JSON_PATH} (${rows.length} filas, shape=array)`);

console.log('\nListo. Sample files:');
console.log(`  - ${CSV_PATH}`);
console.log(`  - ${JSON_PATH}`);

console.log('\nMuestra del CSV (primeras 3 líneas):');
console.log(csv.split('\n').slice(0, 3).join('\n'));

// === JSON alternativo (con wrapper {rows: []}) ===
const JSON_ROWS_PATH  = resolve(__dirname, 'taller-mecanico-ordenes.rows.json');
await writeFile(JSON_ROWS_PATH, JSON.stringify({ rows }, null, 2), 'utf-8');
console.log(`JSON (shape={rows}): ${JSON_ROWS_PATH}`);

// === JSON alternativo (objeto único) ===
const JSON_SINGLE_PATH = resolve(__dirname, 'taller-mecanico-ordenes.single.json');
await writeFile(JSON_SINGLE_PATH, JSON.stringify(rows[0], null, 2), 'utf-8');
console.log(`JSON (shape=objeto único): ${JSON_SINGLE_PATH}`);
