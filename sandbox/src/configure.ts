import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
// Never print credentials or overwrite an existing configuration.
const value = `SUDOKO_REFEREE_KEY=${randomBytes(32).toString('hex')}\nINFERENCE_PROXY_KEY=${randomBytes(32).toString('hex')}\n`;
await writeFile('.sandbox.env', value, { flag: 'wx', mode: 0o600 });
console.log('Created .sandbox.env. Supply Bitdeer credentials separately only for model runs.');
