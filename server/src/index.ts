import { config } from './config.js';
import { getDb, migrateSystem } from './db/index.js';
import { createApp } from './http/app.js';
import { installSecurity } from './security/index.js';
import { installEffects } from './effects/index.js';
import { installAutomation } from './automation/index.js';
import { installFlows } from './flow/index.js';

async function main(): Promise<void> {
  const db = await getDb();
  await migrateSystem(db);
  installSecurity();
  installAutomation();
  installFlows();
  installEffects();

  const app = createApp(db);
  const server = app.listen(config.port, () => {
    console.log(`[meridian] listening on ${config.baseUrl} (${db.kind})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[meridian] ${signal} received, shutting down`);
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[meridian] failed to start:', err);
  process.exit(1);
});
