import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Migrator,
  type MigrationProvider,
  type Migration,
  type MigrationResult,
} from 'kysely/migration';
import { db } from './client.js';

class WindowsSafeMigrationProvider implements MigrationProvider {
  constructor(private migrationFolder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    const files = await fs.readdir(this.migrationFolder);

    for (const fileName of files) {
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.js')) continue;

      const fullPath = path.join(this.migrationFolder, fileName);
      const fileUrl = pathToFileURL(fullPath).href; // safe for import() on Windows

      const migration = await import(fileUrl);
      const migrationKey = fileName.substring(0, fileName.lastIndexOf('.'));

      migrations[migrationKey] = migration;
    }

    return migrations;
  }
}

async function migrateToLatest() {
  const migrator = new Migrator({
    db,
    provider: new WindowsSafeMigrationProvider(
      path.join(process.cwd(), 'src/db/migrations')
    ),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((result: MigrationResult) => {
    if (result.status === 'Success') {
      console.log(`✓ migration "${result.migrationName}" executed successfully`);
    } else if (result.status === 'Error') {
      console.error(`✗ failed to execute migration "${result.migrationName}"`);
    }
  });

  if (error) {
    console.error('Migration failed:');
    console.error(error);
    process.exit(1);
  }

  await db.destroy();
}

migrateToLatest();