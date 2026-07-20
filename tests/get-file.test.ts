import { describe, it, expect } from 'vitest';
import { getFileTool } from '../src/tools/get-file.js';

describe('getFile tool', () => {
  it('reads an existing file from the sample repo', async () => {
    const result = await getFileTool.execute({ path: 'src/auth.ts' });

    expect(result).toContain('export async function login');
    expect(result).toContain('verifyToken');
  });

  it('returns an error for non-existent files', async () => {
    const result = await getFileTool.execute({ path: 'src/does-not-exist.ts' });

    expect(result).toContain('Error: file');
    expect(result).toContain('not found');
  });
});
