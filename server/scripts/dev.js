/**
 * `npm run dev`: tsx watch with stdin detached.
 *
 * tsx watch reads stdin (Return = rerun) and the server inherits the same handle. When that handle is
 * a pipe held open by a parent process (the desktop app's dev-server runner, any `spawn` with piped
 * stdio), the server freezes the first time it loads puppeteer-core (the saved-profile check on the
 * feed page, a sign-in, Explore through the browser): the module load fires more than a thousand
 * dependency notices from the tsx loader to the watch parent, and in that burst the server's main
 * thread ends up blocked on the shared stdin pipe until something is typed on it. Seen 2026-10-16 on
 * Windows: every request hung, /api/health included, with nothing logged. With stdin ignored
 * (a terminal is unaffected either way) the load takes two seconds. Nothing here reads stdin.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const tsx = path.join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, 'watch', '--clear-screen=false', 'src/index.ts', ...process.argv.slice(2)], {
  cwd: path.join(__dirname, '..'),
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
