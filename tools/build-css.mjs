// Compile Tailwind ahead of time (replaces the in-browser CDN compiler, which costs
// ~300 KB of JS plus a blocking style recalculation on every page load).
//   npm run build:css        one-off build of css/tw-<page>.css for every page
// Each page keeps its own theme in tools/tailwind/<page>.config.cjs.
import { execSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss');
const bin = existsSync(localBin) ? `"${localBin}"` : 'npx tailwindcss';
const configs = readdirSync(path.join(root, 'tools', 'tailwind')).filter(f => f.endsWith('.config.cjs'));
for (const f of configs) {
    const page = f.replace('.config.cjs', '');
    execSync(`${bin} -c "tools/tailwind/${f}" -o "css/tw-${page}.css" --minify`, { cwd: root, stdio: 'inherit' });
}
console.log(`built ${configs.length} stylesheets`);
