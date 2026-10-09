import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { callWithVision, createAnthropicClient } = vi.hoisted(() => {
  const callWithVision = vi.fn();
  return {
    callWithVision,
    createAnthropicClient: vi.fn(() => ({ callWithVision })),
  };
});

vi.mock('@almadar/llm', () => ({
  createAnthropicClient,
  ANTHROPIC_MODELS: { CLAUDE_HAIKU_4_5: 'claude-haiku-4-5' },
}));

const {
  gradeScreenshotQuality,
  buildGradingPrompt,
  dimensionsSchema,
  VisionQualityGradingError,
} = await import('../vision-grader.js');

const validDimensions = {
  layoutCoherence: { score: 4, rationale: 'aligned stacks' },
  visualHierarchy: { score: 3, rationale: 'clear headings' },
  densityBalance: { score: 4, rationale: 'balanced spacing' },
  intentMatch: { score: 5, rationale: 'matches request' },
  compositionEvidence: { score: 2, rationale: 'mostly flat' },
};

function tempScreenshot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vision-grader-'));
  const path = join(dir, 'section.png');
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return path;
}

describe('dimensionsSchema', () => {
  it('accepts a well-formed five-dimension report', () => {
    expect(dimensionsSchema.safeParse(validDimensions).success).toBe(true);
  });

  it('rejects a score outside 1–5', () => {
    const bad = { ...validDimensions, layoutCoherence: { score: 7, rationale: 'x' } };
    expect(dimensionsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing dimension', () => {
    const { compositionEvidence, ...partial } = validDimensions;
    void compositionEvidence;
    expect(dimensionsSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects an empty rationale', () => {
    const bad = { ...validDimensions, intentMatch: { score: 3, rationale: '' } };
    expect(dimensionsSchema.safeParse(bad).success).toBe(false);
  });
});

describe('buildGradingPrompt', () => {
  it('names all five dimensions and embeds the user prompt', () => {
    const prompt = buildGradingPrompt('a habit tracker');
    for (const dim of [
      'layoutCoherence',
      'visualHierarchy',
      'densityBalance',
      'intentMatch',
      'compositionEvidence',
    ]) {
      expect(prompt).toContain(dim);
    }
    expect(prompt).toContain('a habit tracker');
  });

  it('stays generic — no spec, organism, or domain-specific vocabulary', () => {
    const prompt = buildGradingPrompt('anything').toLowerCase();
    for (const term of ['orbital', 'organism', 'molecule', 'std-', 'behavior', '.orb', '.lolo']) {
      expect(prompt).not.toContain(term);
    }
  });
});

describe('gradeScreenshotQuality', () => {
  beforeEach(() => {
    callWithVision.mockReset();
    createAnthropicClient.mockClear();
  });

  it('returns the validated report stamped with the default model', async () => {
    callWithVision.mockResolvedValueOnce({ data: validDimensions, raw: '', finishReason: 'stop', usage: null });
    const report = await gradeScreenshotQuality({
      screenshotPaths: [tempScreenshot()],
      userPrompt: 'a dashboard',
    });
    expect(report.model).toBe('claude-haiku-4-5');
    expect(report.dimensions).toEqual(validDimensions);
    expect(createAnthropicClient).toHaveBeenCalledWith({ model: 'claude-haiku-4-5' });
  });

  it('honors a model override', async () => {
    callWithVision.mockResolvedValueOnce({ data: validDimensions, raw: '', finishReason: 'stop', usage: null });
    const report = await gradeScreenshotQuality({
      screenshotPaths: [tempScreenshot()],
      userPrompt: 'x',
      model: 'claude-sonnet-4-5-20250929',
    });
    expect(report.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('sends all screenshots in a single vision call', async () => {
    callWithVision.mockResolvedValueOnce({ data: validDimensions, raw: '', finishReason: 'stop', usage: null });
    await gradeScreenshotQuality({
      screenshotPaths: [tempScreenshot(), tempScreenshot()],
      userPrompt: 'x',
    });
    expect(callWithVision).toHaveBeenCalledTimes(1);
    expect(callWithVision.mock.calls[0][0].images).toHaveLength(2);
  });

  it('retries once on failure then succeeds', async () => {
    callWithVision
      .mockRejectedValueOnce(new Error('schema mismatch'))
      .mockResolvedValueOnce({ data: validDimensions, raw: '', finishReason: 'stop', usage: null });
    const report = await gradeScreenshotQuality({
      screenshotPaths: [tempScreenshot()],
      userPrompt: 'x',
    });
    expect(callWithVision).toHaveBeenCalledTimes(2);
    expect(report.dimensions).toEqual(validDimensions);
  });

  it('throws a typed error after the retry is exhausted', async () => {
    callWithVision.mockRejectedValue(new Error('schema mismatch'));
    await expect(
      gradeScreenshotQuality({ screenshotPaths: [tempScreenshot()], userPrompt: 'x' }),
    ).rejects.toBeInstanceOf(VisionQualityGradingError);
    expect(callWithVision).toHaveBeenCalledTimes(2);
  });

  it('throws when no screenshots are supplied', async () => {
    await expect(
      gradeScreenshotQuality({ screenshotPaths: [], userPrompt: 'x' }),
    ).rejects.toBeInstanceOf(VisionQualityGradingError);
  });

  it('grades four study criteria from supplied check/frame evidence without replacing visual dimensions', async () => {
    const criterion = { score: 8, rationale: 'The declared flow is observed', citations: ['check:save', 'frame:desktop'] };
    const study = { criteria: { completion: criterion, design: criterion, utility: criterion, intentFit: criterion } };
    callWithVision.mockResolvedValueOnce({ data: { dimensions: validDimensions, study }, raw: '', finishReason: 'stop', usage: null });
    const report = await gradeScreenshotQuality({
      screenshotPaths: [tempScreenshot()], userPrompt: 'a task app',
      study: { turnPrompt: 'save a task', evidence: [
        { id: 'check:save', kind: 'check', observation: { passed: true, expected: { rows: 1 }, evidence: [{ rows: 1 }] } },
        { id: 'frame:desktop', kind: 'frame', observation: { route: '/tasks', viewport: { width: 1440, height: 900 } } },
      ] },
    });
    expect(report.dimensions).toEqual(validDimensions);
    expect(report.study).toEqual(study);
    expect(callWithVision.mock.calls[0][0].userText).toContain('save a task');
    expect(callWithVision.mock.calls[0][0].userText).toContain('check:save');
    expect(callWithVision.mock.calls[0][0].userText).toContain('frame:desktop');
  });

  it('retries and rejects invented citations, missing evidence and out-of-range study scores', async () => {
    const criterion = { score: 8, rationale: 'Observed', citations: ['invented'] };
    const input: Parameters<typeof gradeScreenshotQuality>[0] = {
      screenshotPaths: [tempScreenshot()], userPrompt: 'a task app',
      study: { turnPrompt: 'save a task', evidence: [
        { id: 'check:save', kind: 'check' as const, observation: { passed: true } },
        { id: 'frame:desktop', kind: 'frame' as const, observation: { route: '/tasks' } },
      ] },
    };
    for (const invalid of [criterion, { ...criterion, citations: [] }, { ...criterion, score: 11, citations: ['check:save', 'frame:desktop'] }]) {
      callWithVision.mockReset();
      callWithVision.mockResolvedValue({ data: { dimensions: validDimensions, study: { criteria: { completion: invalid, design: invalid, utility: invalid, intentFit: invalid } } } });
      await expect(gradeScreenshotQuality(input)).rejects.toBeInstanceOf(VisionQualityGradingError);
      expect(callWithVision).toHaveBeenCalledTimes(2);
    }
  });
});
