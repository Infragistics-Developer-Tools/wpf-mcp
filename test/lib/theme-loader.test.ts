import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { readFileSync, statSync } from 'fs';
import { loadThemeResource } from '../../src/lib/theme-loader.js';

const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadThemeResource', () => {
  it('returns the file content for a valid relative path', () => {
    mockStatSync.mockReturnValue({ isFile: () => true } as unknown as ReturnType<typeof statSync>);
    mockReadFileSync.mockReturnValue('<Style>fake xaml</Style>');

    const result = loadThemeResource('Themes/MetroDark/MetroDark.xamDataChart.xaml');

    expect(result).toBe('<Style>fake xaml</Style>');
  });

  it('returns null when the resolved path escapes the resources directory (path traversal)', () => {
    const result = loadThemeResource('../../../../etc/passwd');
    expect(result).toBeNull();
    // Should short-circuit before ever touching the filesystem.
    expect(mockStatSync).not.toHaveBeenCalled();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('returns null when the path resolves to a directory', () => {
    mockStatSync.mockReturnValue({ isFile: () => false } as unknown as ReturnType<typeof statSync>);
    const result = loadThemeResource('Themes/MetroDark');
    expect(result).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('returns null when the file does not exist', () => {
    mockStatSync.mockReturnValue(undefined as unknown as ReturnType<typeof statSync>);
    const result = loadThemeResource('Themes/MetroDark/DoesNotExist.xaml');
    expect(result).toBeNull();
  });
});
