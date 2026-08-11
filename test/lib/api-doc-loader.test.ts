import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, readdirSync } from 'fs';
import { loadApiDoc } from '../../src/lib/api-doc-loader.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

const FIXTURE_ENTRY = { component: 'XamDataGrid', properties: [], events: [], methods: [] };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadApiDoc', () => {
  it('returns null when the API directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadApiDoc('XamDataGrid')).toBeNull();
  });

  it('returns the parsed entry on an exact filename match', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(FIXTURE_ENTRY));

    const result = loadApiDoc('XamDataGrid');

    expect(result).toEqual(FIXTURE_ENTRY);
    expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('XamDataGrid.json'), 'utf-8');
  });

  it('falls back to a case-insensitive directory scan when the exact path is missing', () => {
    mockExistsSync.mockImplementation((p) => !String(p).toLowerCase().endsWith('xamdatagrid.json'));
    mockReaddirSync.mockReturnValue(['XamDataGrid.json'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValue(JSON.stringify(FIXTURE_ENTRY));

    const result = loadApiDoc('xamdatagrid');

    expect(result).toEqual(FIXTURE_ENTRY);
  });

  it('returns null when neither an exact nor a case-insensitive match exists', () => {
    mockExistsSync.mockImplementation((p) => !String(p).toLowerCase().endsWith('nonexistent.json'));
    mockReaddirSync.mockReturnValue(['XamDataGrid.json'] as unknown as ReturnType<typeof readdirSync>);

    expect(loadApiDoc('Nonexistent')).toBeNull();
  });
});

