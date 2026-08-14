#!/usr/bin/env node
/**
 * server.mjs — umeJSON finalize API (MVP local).
 *
 * Recibe un umeJSON validado por el skill, valida estructura + sentinels,
 * inyecta id (UUID v7) + timestamps reales del servidor, y devuelve la
 * entidad lista para persistir en DB.
 *
 * Uso:
 *   node server.mjs
 *   PORT=8001 UMEJSON_FINALIZE_KEY=xxx node server.mjs
 */

import express from 'express';
import cors from 'cors';
import { v7 as uuidv7 } from 'uuid';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '.env') });

// ============================================================
// Config
// ============================================================
const PORT = parseInt(process.env.PORT || '8001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const FINALIZE_KEY = process.env.UMEJSON_FINALIZE_KEY || 'dev-key-change-me';
const SENTINEL = 'RESERVED_FOR_SYSTEM';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 600; // req/min por IP

// ============================================================
// Schema (contrato umeJSON completo)
// ============================================================
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);

const umeJsonSchema = {
  type: 'object',
  required: ['id', 'entityName', 'dynamicProperties', 'lifecycle', 'state', 'markdownDocumentation'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    entityName: { type: 'string', minLength: 1 },
    dynamicProperties: { type: 'object', additionalProperties: true },
    lifecycle: {
      type: 'object',
      required: ['createdAt', 'updatedAt'],
      additionalProperties: true,
      properties: {
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        deletedAt: { type: ['string', 'null'] },
        version: { type: 'integer', minimum: 1 }
      }
    },
    relations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['targetEntity', 'targetId', 'type'],
        additionalProperties: true,
        properties: {
          targetEntity: { type: 'string' },
          targetId: { type: 'string' },
          type: { type: 'string', enum: ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] },
          context: { type: 'string' }
        }
      }
    },
    state: {
      type: 'object',
      required: ['current', 'statusLog'],
      additionalProperties: true,
      properties: {
        current: { type: 'string', enum: ['active', 'draft', 'validation_required'] },
        statusLog: {
          type: 'array',
          items: {
            type: 'object',
            required: ['status', 'timestamp'],
            additionalProperties: true,
            properties: {
              status: { type: 'string' },
              timestamp: { type: 'string' },
              reason: { type: 'string' }
            }
          }
        }
      }
    },
    markdownDocumentation: { type: 'string' }
  }
};

const validateUmeJson = ajv.compile(umeJsonSchema);

// ============================================================
// App
// ============================================================
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: true })); // MVP: abierto. Producción: whitelist.

app.use((req, res, next) => {
  const requestId = randomUUID();
  req.requestId = requestId;
  const started = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latency_ms: Date.now() - started,
      ip: req.ip
    }));
  });
  next();
});

// Rate limit in-memory por IP (suficiente para MVP local)
const buckets = new Map();
app.use((req, res, next) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const bucket = buckets.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + RATE_LIMIT_WINDOW_MS; }
  bucket.count++;
  buckets.set(ip, bucket);
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - bucket.count));
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: { code: 'rate_limited', message: 'Demasiadas solicitudes' } });
  }
  next();
});

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'umejson-finalize-api', version: '0.1.0', uptime_s: Math.round(process.uptime()) });
});

// Finalize
app.post('/api/v1/ume-json/finalize', (req, res) => {
  // 1. Auth
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== FINALIZE_KEY) {
    return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'API key inválida' } });
  }

  const input = req.body;

  // 2. __diagnostic primero (la IA nos dice que no pudo)
  if (input && typeof input === 'object' && input.__diagnostic) {
    return res.status(422).json({
      ok: false,
      source: 'umejson_skill',
      error: { code: 'umejson_diagnostic', message: 'El agente umeJSON rechazó el input' },
      diagnostic: input.__diagnostic
    });
  }

  // 3. Validar contrato
  const isValid = validateUmeJson(input);
  if (!isValid) {
    return res.status(422).json({
      ok: false,
      source: 'umejson_api',
      error: {
        code: 'schema_violation',
        message: 'La entidad no cumple con el esquema umeJSON',
        details: validateUmeJson.errors
      }
    });
  }

  // 4. Validar sentinels: id y lifecycle.* DEBEN ser RESERVED_FOR_SYSTEM o null
  const sentinelErrors = [];
  if (input.id !== SENTINEL && input.id !== null) {
    sentinelErrors.push({ field: 'id', expected: SENTINEL, got: input.id });
  }
  if (input.lifecycle.createdAt !== SENTINEL && input.lifecycle.createdAt !== null) {
    sentinelErrors.push({ field: 'lifecycle.createdAt', expected: SENTINEL, got: input.lifecycle.createdAt });
  }
  if (input.lifecycle.updatedAt !== SENTINEL && input.lifecycle.updatedAt !== null) {
    sentinelErrors.push({ field: 'lifecycle.updatedAt', expected: SENTINEL, got: input.lifecycle.updatedAt });
  }
  if (input.lifecycle.deletedAt !== undefined && input.lifecycle.deletedAt !== null && input.lifecycle.deletedAt !== SENTINEL) {
    sentinelErrors.push({ field: 'lifecycle.deletedAt', expected: 'null | ' + SENTINEL, got: input.lifecycle.deletedAt });
  }
  if (Array.isArray(input.state?.statusLog)) {
    input.state.statusLog.forEach((log, i) => {
      if (log.timestamp !== SENTINEL && log.timestamp !== null) {
        sentinelErrors.push({ field: `state.statusLog[${i}].timestamp`, expected: SENTINEL, got: log.timestamp });
      }
    });
  }
  if (sentinelErrors.length > 0) {
    return res.status(422).json({
      ok: false,
      source: 'umejson_api',
      error: {
        code: 'sentinel_violation',
        message: 'Los campos reservados deben venir con sentinel RESERVED_FOR_SYSTEM o null',
        details: sentinelErrors
      }
    });
  }

  // 5. Deep clone + inyectar datos del servidor
  let entity;
  try {
    entity = structuredClone(input);
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: 'clone_failed', message: e.message } });
  }

  const nowIso = new Date().toISOString();
  const newId = uuidv7();

  entity.id = newId;
  entity.lifecycle.createdAt = nowIso;
  entity.lifecycle.updatedAt = nowIso;
  if ('deletedAt' in entity.lifecycle) entity.lifecycle.deletedAt = entity.lifecycle.deletedAt ?? null;

  if (Array.isArray(entity.state?.statusLog)) {
    entity.state.statusLog = entity.state.statusLog.map(log => ({
      ...log,
      timestamp: log.timestamp === SENTINEL || log.timestamp == null ? nowIso : log.timestamp
    }));
  }

  // 6. Respuesta con envelope unificado
  return res.status(200).json({ ok: true, data: entity });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: { code: 'not_found', message: `Ruta ${req.method} ${req.path} no existe` } });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), request_id: req.requestId, error: err.message, stack: err.stack }));
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: { code: 'internal_error', message: 'Error interno del servidor' } });
});

app.listen(PORT, HOST, () => {
  console.log(`[umejson-finalize-api] listening on http://${HOST}:${PORT}`);
  console.log(`[umejson-finalize-api] health: http://${HOST}:${PORT}/health`);
  console.log(`[umejson-finalize-api] finalize: POST http://${HOST}:${PORT}/api/v1/ume-json/finalize`);
});
