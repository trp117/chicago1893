// Run with: node restore-homepage-ux.js
// Restores the homepage to the pre-UX-fix backed-up version
import { existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = join(__dirname, 'public/index.backup-ux.html');
const dest = join(__dirname, 'public/index.html');
if (!existsSync(src)) {
  console.error('No UX backup found at public/index.backup-ux.html');
  process.exit(1);
}
copyFileSync(src, dest);
console.log('Homepage restored from UX backup successfully.');
