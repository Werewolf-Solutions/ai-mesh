#!/usr/bin/env node
/** Node process entry point: `node apps/node/dist/main.js --data <dir>`. */
import { resolveDataDir } from './config.js';
import { MeshNode } from './node.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const node = new MeshNode(resolveDataDir(arg('--data')));

let signals = 0;
const shutdown = (sig: string) => {
  signals++;
  if (signals > 1) {
    process.stderr.write('second signal: exiting immediately\n');
    process.exit(130);
  }
  node.stop(sig).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => {
  node.admission?.load().then(
    () => node.log.info('admission list reloaded (SIGHUP)'),
    (err) => node.log.error({ err: (err as Error).message }, 'admission reload failed'),
  );
});

node.start().catch((err) => {
  process.stderr.write(`failed to start: ${(err as Error).message}\n`);
  void node.stop('startup failure').finally(() => process.exit(1));
});
