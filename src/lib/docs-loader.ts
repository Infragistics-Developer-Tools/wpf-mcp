import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveInside } from './safe-path.js';
import type { DocEntry } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '../data/docs');

export function loadDoc(slug: string): DocEntry | null {
  if (!existsSync(DOCS_DIR)) return null;

  // Exact slug match
  const exactPath = resolveInside(DOCS_DIR, `${slug}.json`);
  if (!exactPath) return null;
  if (existsSync(exactPath)) {
    return JSON.parse(readFileSync(exactPath, 'utf-8')) as DocEntry;
  }

  // Case-insensitive fallback
  const lower = `${slug.toLowerCase()}.json`;
  const match = readdirSync(DOCS_DIR).find(f => f.toLowerCase() === lower);
  return match
    ? JSON.parse(readFileSync(join(DOCS_DIR, match), 'utf-8')) as DocEntry
    : null;
}
