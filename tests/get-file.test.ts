import { describe, it, expect } from 'vitest';
import { getFileTool } from '../src/tools/get-file.js';

describe('getFile tool', () => {
  it('reads an existing file from the repo', async () => {
    const result = await getFileTool.execute({ path: 'package.json' });

    expect(result).toContain('ai-agent-from-scratch');
  });

  it('returns an error for non-existent files', async () => {
    const result = await getFileTool.execute({ path: 'does-not-exist.ts' });

    expect(result).toContain('Error: file');
    expect(result).toContain('not found');
  });
});
