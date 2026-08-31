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
import { loadDoc } from '../../src/lib/docs-loader.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

const FIXTURE_DOC = { slug: 'xamdatagrid-getting-started', title: 'Getting Started', body: 'text', xamlSnippets: [] };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadDoc', () => {
  it('returns null when the docs directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadDoc('xamdatagrid-getting-started')).toBeNull();
  });

  it('returns the parsed entry on an exact slug match', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(FIXTURE_DOC));

    const result = loadDoc('xamdatagrid-getting-started');

    expect(result).toEqual(FIXTURE_DOC);
    expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('xamdatagrid-getting-started.json'), 'utf-8');
  });

  it('falls back to a case-insensitive directory scan when the exact path is missing', () => {
    mockExistsSync.mockImplementation((p) => !String(p).toLowerCase().endsWith('xamdatagrid-getting-started.json'));
    mockReaddirSync.mockReturnValue(['XamDataGrid-Getting-Started.json'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValue(JSON.stringify(FIXTURE_DOC));

    const result = loadDoc('XamDataGrid-Getting-Started');

    expect(result).toEqual(FIXTURE_DOC);
  });

  it('returns null when neither an exact nor a case-insensitive match exists', () => {
    mockExistsSync.mockImplementation((p) => !String(p).toLowerCase().endsWith('nonexistent-slug.json'));
    mockReaddirSync.mockReturnValue(['xamdatagrid-getting-started.json'] as unknown as ReturnType<typeof readdirSync>);

    expect(loadDoc('nonexistent-slug')).toBeNull();
  });
});
