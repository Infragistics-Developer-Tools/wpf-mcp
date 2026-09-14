import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveInside } from './safe-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_RESOURCES_DIR = join(__dirname, '../data/theme-resources');

/**
 * Reads a theme resource XAML file by its theme-index-relative path
 * (e.g. "Themes/MetroDark/MetroDark.xamDataChart.xaml" or
 * "DefaultStyles/Ribbon/RibbonMetroDark.xaml"). Returns null if the file
 * doesn't exist, if the path points at a directory, or if the path attempts
 * to escape the resources directory.
 */
export function loadThemeResource(relPath: string): string | null {
  const fullPath = resolveInside(THEME_RESOURCES_DIR, relPath);
  if (!fullPath) return null;

  // Must resolve to an existing regular file — a directory (e.g. ".", "Themes/",
  // "DefaultStyles/") would pass an existence check but throw EISDIR on read.
  const stats = statSync(fullPath, { throwIfNoEntry: false });
  if (!stats?.isFile()) return null;

  return readFileSync(fullPath, 'utf-8');
}
