import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolveKernelDir } from '@almadar/runtime/kernelProgram';
import type { JsonValue } from '@almadar/core';
import type { VisionGraderHost } from '../vision-grader.js';

const orb = process.env.ALMADAR_ORB ?? join(homedir(), 'bin', 'orb');
const kernelReady = existsSync(join(resolveKernelDir(), 'pkg', 'orbital_wasm_bg.wasm')) && existsSync(orb);

interface Sent { url: string; body: { model: string; max_tokens: number; system: Array<{ text: string }>; messages: Array<{ content: Array<{ type: string }> }> } }

/** A recorded exchange: each call is answered with the next reply (the last one repeats). */
function transcript(replies: Array<JsonValue>): { sent: Sent[]; host: VisionGraderHost } {
  const sent: Sent[] = [];
  let i = 0;
  return {
    sent,
    host: {
      orb,
      http: {
        secrets: { get: async (name: string) => (name === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined), set: async () => undefined, forget: async () => undefined },
        fetch: async (url: URL, init: { body?: Uint8Array }) => {
          sent.push({ url: url.href, body: JSON.parse(new TextDecoder().decode(init.body)) });
          const reply = replies[Math.min(i++, replies.length - 1)];
          return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
        },
        resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
      },
    },
  };
}

function reply(data: JsonValue): JsonValue {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } };
}

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

describe.skipIf(!kernelReady)('gradeScreenshotQuality', () => {
  it('returns the validated report stamped with the default model, over std-llm on the kernel', async () => {
    const t = transcript([reply(validDimensions)]);
    const report = await gradeScreenshotQuality({ screenshotPaths: [tempScreenshot()], userPrompt: 'a dashboard', host: t.host });
    expect(report.model).toBe('claude-haiku-4-5');
    expect(report.dimensions).toEqual(validDimensions);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(t.sent[0].body.model).toBe('claude-haiku-4-5');
    expect(t.sent[0].body.max_tokens).toBe(1024);
  });

  it('derives the extract JSON Schema from the zod schema it validates with', async () => {
    const t = transcript([reply(validDimensions)]);
    await gradeScreenshotQuality({ screenshotPaths: [tempScreenshot()], userPrompt: 'x', host: t.host });
    const text = t.sent[0].body.system[0].text;
    const schema: JsonValue = JSON.parse(text.slice(text.indexOf('{')));
    expect(schema).toEqual(z.toJSONSchema(dimensionsSchema));
  });

  it('honors a model override', async () => {
    const t = transcript([reply(validDimensions)]);
    const report = await gradeScreenshotQuality({ screenshotPaths: [tempScreenshot()], userPrompt: 'x', model: 'claude-sonnet-4-5-20250929', host: t.host });
    expect(report.model).toBe('claude-sonnet-4-5-20250929');
    expect(t.sent[0].body.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('sends all screenshots in a single vision message, images before the text', async () => {
    const t = transcript([reply(validDimensions)]);
    await gradeScreenshotQuality({ screenshotPaths: [tempScreenshot(), tempScreenshot()], userPrompt: 'x', host: t.host });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].body.messages[0].content.map((part) => part.type)).toEqual(['image', 'image', 'text']);
  });

  it('retries once when the reply fails the schema, then succeeds', async () => {
    const bad = { ...validDimensions, layoutCoherence: { score: 7, rationale: 'x' } };
    const t = transcript([reply(bad), reply(validDimensions)]);
    const report = await gradeScreenshotQuality({ screenshotPaths: [tempScreenshot()], userPrompt: 'x', host: t.host });
    expect(t.sent).toHaveLength(2);
    expect(report.dimensions).toEqual(validDimensions);
  });

  it('throws a typed error after the retry is exhausted', async () => {
    const bad = { ...validDimensions, layoutCoherence: { score: 7, rationale: 'x' } };
    const t = transcript([reply(bad)]);
    await expect(gradeScreenshotQuality({ screenshotPaths: [tempScreenshot()], userPrompt: 'x', host: t.host })).rejects.toBeInstanceOf(VisionQualityGradingError);
    expect(t.sent).toHaveLength(2);
  });

  it('throws when no screenshots are supplied', async () => {
    await expect(gradeScreenshotQuality({ screenshotPaths: [], userPrompt: 'x' })).rejects.toBeInstanceOf(VisionQualityGradingError);
  });

  it('grades four study criteria from supplied check/frame evidence without replacing visual dimensions', async () => {
    const criterion = { score: 8, rationale: 'The declared flow is observed', citations: ['check:save', 'frame:desktop'] };
    const study = { criteria: { completion: criterion, design: criterion, utility: criterion, intentFit: criterion } };
    const t = transcript([reply({ dimensions: validDimensions, study })]);
    const report = await gradeScreenshotQuality({
      screenshotPaths: [tempScreenshot()], userPrompt: 'a task app', host: t.host,
      study: { turnPrompt: 'save a task', evidence: [
        { id: 'check:save', kind: 'check', observation: { passed: true, expected: { rows: 1 }, evidence: [{ rows: 1 }] } },
        { id: 'frame:desktop', kind: 'frame', observation: { route: '/tasks', viewport: { width: 1440, height: 900 } } },
      ] },
    });
    expect(report.dimensions).toEqual(validDimensions);
    expect(report.study).toEqual(study);
    expect(t.sent[0].body.max_tokens).toBe(4096);
    const text = JSON.stringify(t.sent[0].body.messages[0].content);
    expect(text).toContain('save a task');
    expect(text).toContain('check:save');
    expect(text).toContain('frame:desktop');
  });

  it('retries and rejects invented citations, missing evidence and out-of-range study scores', async () => {
    const criterion = { score: 8, rationale: 'Observed', citations: ['invented'] };
    for (const invalid of [criterion, { ...criterion, citations: [] }, { ...criterion, score: 11, citations: ['check:save', 'frame:desktop'] }]) {
      const t = transcript([reply({ dimensions: validDimensions, study: { criteria: { completion: invalid, design: invalid, utility: invalid, intentFit: invalid } } })]);
      await expect(gradeScreenshotQuality({
        screenshotPaths: [tempScreenshot()], userPrompt: 'a task app', host: t.host,
        study: { turnPrompt: 'save a task', evidence: [
          { id: 'check:save', kind: 'check' as const, observation: { passed: true } },
          { id: 'frame:desktop', kind: 'frame' as const, observation: { route: '/tasks' } },
        ] },
      })).rejects.toBeInstanceOf(VisionQualityGradingError);
      expect(t.sent).toHaveLength(2);
    }
  });
});
