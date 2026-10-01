// Runs the desktop app from the source tree (npm run app).
// Clears ELECTRON_RUN_AS_NODE, which VS Code's terminal sets and which would
// otherwise make Electron start as plain Node instead of opening a window.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron'); // path to the Electron binary
const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, [root], { stdio: 'inherit', env }).on('exit', code => process.exit(code ?? 0));
