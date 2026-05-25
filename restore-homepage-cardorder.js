// Run with: node restore-homepage-cardorder.js
// Restores the homepage to the pre-card-reorder backed-up version
import { existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = join(__dirname, 'public/index.backup-cardorder.html');
const dest = join(__dirname, 'public/index.html');
if (!existsSync(src)) {
  console.error('No card-order backup found at public/index.backup-cardorder.html');
  process.exit(1);
}
copyFileSync(src, dest);
console.log('Homepage restored from card-order backup successfully.');
