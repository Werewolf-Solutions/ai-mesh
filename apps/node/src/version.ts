import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const SOFTWARE_VERSION = '0.2.1';

/** Repository root (apps/node/dist/.. or apps/node/src/.. → ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
