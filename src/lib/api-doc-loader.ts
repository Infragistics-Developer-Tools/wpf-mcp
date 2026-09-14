import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveInside } from './safe-path.js';
import type { ApiEntry } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(__dirname, '../data/api');

export function loadApiDoc(component: string): ApiEntry | null {
  if (!existsSync(API_DIR)) return null;

  // Exact match first
  const exactPath = resolveInside(API_DIR, `${component}.json`);
  if (!exactPath) return null;
  if (existsSync(exactPath)) {
    return JSON.parse(readFileSync(exactPath, 'utf-8')) as ApiEntry;
  }

  // Case-insensitive fallback
  const match = readdirSync(API_DIR).find(
    f => f.toLowerCase() === `${component.toLowerCase()}.json`
  );
  return match
    ? JSON.parse(readFileSync(join(API_DIR, match), 'utf-8')) as ApiEntry
    : null;
}
