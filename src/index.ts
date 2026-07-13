import { buildApp } from './app/app.js';
import { env } from './config/env.js';
import { startCheckpointJob } from './jobs/checkpoint.job.js';
import { db } from './db/client.js';

const app = buildApp();

app.listen({ port: env.port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

const checkpointJob = startCheckpointJob(
  undefined,
  (message) => app.log.info(message),
  (error) => app.log.error(error)
);

async function shutdown(): Promise<void> {
  checkpointJob.stop();
  await app.close();
  await db.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());