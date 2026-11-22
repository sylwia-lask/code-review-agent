import { describe, it, expect } from 'vitest';
import { COMPLAINT_CATEGORIES } from '../hr-server/hr-db.js';
import {
  buildReviewerSystemPrompt,
  HR_SYSTEM_PROMPT_ADDENDUM,
  REVIEWER_SYSTEM_PROMPT,
} from '../src/prompts.js';

describe('buildReviewerSystemPrompt', () => {
  it('returns the base reviewer prompt without HR instructions when hrEnabled is false', () => {
    const prompt = buildReviewerSystemPrompt({ hrEnabled: false });

    expect(prompt).toBe(REVIEWER_SYSTEM_PROMPT);
    expect(prompt).not.toContain('HR Department');
    expect(prompt).not.toContain('file_complaint');
  });

  it('appends the HR addendum with HEAD Commit SHA rules and all 6 fixed categories when hrEnabled is true', () => {
    const prompt = buildReviewerSystemPrompt({ hrEnabled: true });

    expect(prompt).toContain(HR_SYSTEM_PROMPT_ADDENDUM);
    expect(prompt).toContain('"HEAD Commit SHA"');
    expect(prompt).toContain('commit_sha');
    for (const category of COMPLAINT_CATEGORIES) {
      expect(prompt).toContain(category);
    }
    expect(prompt).not.toContain('minor | moderate | severe | legendary');
  });

  it('injects the trimmed PR author section when prAuthor is provided', () => {
    const prompt = buildReviewerSystemPrompt({
      hrEnabled: true,
      prAuthor: '  Sylwia Laskowska  ',
    });

    expect(prompt).toContain('## PR author');
    expect(prompt).toContain('"Sylwia Laskowska"');
  });
});
