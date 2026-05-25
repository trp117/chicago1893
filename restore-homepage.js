// Run with: node restore-homepage.js
// Restores the homepage to the last backed-up version
import { existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = join(__dirname, 'public/index.backup.html');
const dest = join(__dirname, 'public/index.html');
if (!existsSync(src)) {
  console.error('No backup found at public/index.backup.html');
  process.exit(1);
}
copyFileSync(src, dest);
console.log('Homepage restored from backup successfully.');
