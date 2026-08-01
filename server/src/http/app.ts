import express from 'express';
import type { Express } from 'express';
import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { authenticate, errorHandler, meterApiUsage, notFound } from './middleware.js';

/** Build the HTTP app over a given database. Tests construct one per ephemeral database. */
export function createApp(db: Db): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(corsForClient());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', driver: db.kind, version: config.defaultApiVersion });
  });

  // Metering needs the context, so it runs after an optional auth pass.
  app.use('/services', authenticate(db, { optional: true }), meterApiUsage(db));

  app.use('/api/auth', authRoutes(db));
  app.use('/services/data', dataRoutes(db));

  app.use(notFound());
  app.use(errorHandler());
  return app;
}

/** Allow the Vite dev client to call the API with cookies during development. */
function corsForClient(): express.RequestHandler {
  const allowed = new Set([process.env.CLIENT_ORIGIN ?? 'http://localhost:5173']);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
