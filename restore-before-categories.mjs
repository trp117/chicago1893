// Run with: node restore-before-categories.mjs
// Restores public/index.html to the pre-category-build backup
import { existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = join(__dirname, 'public/index.backup-catbuild.html');
const dest = join(__dirname, 'public/index.html');
if (!existsSync(src)) {
  console.error('No category-build backup found at public/index.backup-catbuild.html');
  process.exit(1);
}
copyFileSync(src, dest);
console.log('Homepage restored from pre-category-build backup successfully.');
