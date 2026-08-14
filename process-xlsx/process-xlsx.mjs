#!/usr/bin/env node
/**
 * process-xlsx.mjs — shim de backward-compat.
 *
 * En v0.0.0/v0.0.1 el script se llamaba `process-xlsx.mjs` y solo
 * procesaba XLSX. En v0.1.0 pasó a llamarse `process-table.mjs` y
 * soporta XLSX, CSV, TSV, JSON.
 *
 * Este shim delega. Se eliminará en v0.2.0.
 */

import('./process-table.mjs');
