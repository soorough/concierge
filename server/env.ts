import { existsSync } from 'node:fs';

/**
 * Local development reads .env; on Railway the platform supplies the environment, so a
 * missing file is normal rather than an error.
 */
export function loadEnv(path = '.env'): void {
  if (existsSync(path) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path);
  }
}
