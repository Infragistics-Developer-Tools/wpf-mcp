import { readFileSync, existsSync } from 'fs';
import { join, dirname, normalize, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_RESOURCES_DIR = join(__dirname, '../data/theme-resources');

/**
 * Reads a theme resource XAML file by its theme-index-relative path
 * (e.g. "Themes/MetroDark/MetroDark.xamDataChart.xaml" or
 * "DefaultStyles/Ribbon/RibbonMetroDark.xaml"). Returns null if the file
 * doesn't exist, or if the path attempts to escape the resources directory.
 */
export function loadThemeResource(relPath: string): string | null {
  const normalized = normalize(relPath);
  const fullPath = normalize(join(THEME_RESOURCES_DIR, normalized));

  // Path traversal guard — the resolved path must stay inside THEME_RESOURCES_DIR.
  if (fullPath !== THEME_RESOURCES_DIR && !fullPath.startsWith(THEME_RESOURCES_DIR + sep)) return null;
  if (!existsSync(fullPath)) return null;

  return readFileSync(fullPath, 'utf-8');
}
