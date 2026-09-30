import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { errorHandler } from './http.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import documentsRoutes from './routes/documents.js';
import filesRoutes from './routes/files.js';
import searchRoutes from './routes/search.js';
import feedbackRoutes from './routes/feedback.js';
import attestationsRoutes from './routes/attestations.js';
import checklistsRoutes from './routes/checklists.js';
import trainingRoutes from './routes/training.js';
import dashboardRoutes from './routes/dashboard.js';
import auditRoutes from './routes/audit.js';
import importexportRoutes from './routes/importexport.js';
import backupRoutes from './routes/backup.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? (config.env !== 'test' ? { level: config.isProd ? 'info' : 'warn', redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]'] } : false),
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: config.isProd,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 5 } });
  app.setErrorHandler(errorHandler);
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.isProd) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!reply.getHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CSP);
    if (req.url.startsWith('/api/') && !reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.get('/api/health', async () => ({ ok: true, app: 'Operate', version: process.env.npm_package_version ?? '1.0.0' }));

  for (const r of [authRoutes, adminRoutes, documentsRoutes, filesRoutes, searchRoutes, feedbackRoutes, attestationsRoutes, checklistsRoutes, trainingRoutes, dashboardRoutes, auditRoutes, importexportRoutes, backupRoutes]) await app.register(r);

  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, setHeaders: (res, path) => {
      if (path.endsWith('sw.js') || path.endsWith('index.html') || path.endsWith('manifest.webmanifest')) (res as any).setHeader('Cache-Control', 'no-cache');
      else if (path.includes('/assets/')) (res as any).setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: '見つかりません' });
      return reply.type('text/html').sendFile('index.html', join(config.webDist));
    });
  }
  return app;
}
