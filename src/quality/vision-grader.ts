/**
 * Vision-based visual quality grader.
 *
 * Feeds one or more rendered screenshots plus the originating user prompt to a
 * vision-capable Claude model (default `claude-haiku-4-5`) through `@almadar/llm`
 * and returns a schema-validated, advisory quality report. All model access is
 * delegated to the LLM client — this module never talks HTTP itself.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import {
  createAnthropicClient,
  ANTHROPIC_MODELS,
  type LLMClient,
  type VisionImagePart,
  type VisionImageMediaType,
} from '@almadar/llm';

/** The five visual-quality dimensions, each scored 1–5 with a one-line rationale. */
export interface VisionQualityReport {
  dimensions: Record<
    | 'layoutCoherence'
    | 'visualHierarchy'
    | 'densityBalance'
    | 'intentMatch'
    | 'compositionEvidence',
    { score: 1 | 2 | 3 | 4 | 5; rationale: string }
  >;
  model: string;
}

/** Thrown when the model output cannot be validated against the schema after a retry. */
export class VisionQualityGradingError extends Error {
  constructor(
    message: string,
    public readonly cause: Error | string | null,
  ) {
    super(message);
    this.name = 'VisionQualityGradingError';
  }
}

const DEFAULT_MODEL = ANTHROPIC_MODELS.CLAUDE_HAIKU_4_5;

const scoreSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const dimensionSchema = z.object({
  score: scoreSchema,
  rationale: z.string().min(1),
});

/** Schema for the model's raw output — the five dimensions only; `model` is stamped locally. */
export const dimensionsSchema = z.object({
  layoutCoherence: dimensionSchema,
  visualHierarchy: dimensionSchema,
  densityBalance: dimensionSchema,
  intentMatch: dimensionSchema,
  compositionEvidence: dimensionSchema,
});

const MEDIA_TYPES: Record<string, VisionImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function loadImage(path: string): VisionImagePart {
  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
  if (!mediaType) {
    throw new VisionQualityGradingError(
      `Unsupported screenshot format for "${path}" (expected .png/.jpg/.jpeg/.gif/.webp)`,
      null,
    );
  }
  return { base64: readFileSync(path).toString('base64'), mediaType };
}

/**
 * Assemble the grading prompt. Deliberately generic: it grounds each dimension
 * in the render substrate's visual language (stack-based layout, typography
 * hierarchy, spacing/density discipline, atom→molecule composition depth) and
 * never mentions any specific spec, organism, entity, or domain.
 */
export function buildGradingPrompt(userPrompt: string): string {
  return [
    'You are a visual quality reviewer for generated application interfaces.',
    'You are shown one or more screenshots of a single rendered application (each image is one section of the same app) and the natural-language request it was generated from.',
    'Judge the interface against the render substrate\'s visual language:',
    '- Layout is built from vertical and horizontal stacks and containers; sibling elements should align on a shared axis with consistent gaps rather than drifting.',
    '- Text carries hierarchy through typographic scale — headings, body, captions — not through undifferentiated blocks of same-sized text.',
    '- Spacing and density should feel balanced: neither a single cramped column nor vast empty voids.',
    '- Richer interfaces compose small primitives into larger blocks (cards, grids, lists, toolbars); a flat one-per-line dump shows shallow composition.',
    '',
    'Score each of these five dimensions on an integer scale from 1 (poor) to 5 (excellent), with a single concise sentence of rationale:',
    '- layoutCoherence: are elements aligned and grouped on consistent axes with sensible gaps?',
    '- visualHierarchy: is there clear typographic and structural emphasis guiding the eye?',
    '- densityBalance: is content spacing balanced, avoiding both crowding and emptiness?',
    '- intentMatch: does the rendered interface satisfy what the request asked for?',
    '- compositionEvidence: is there evidence of composed, nested structure rather than a flat list?',
    '',
    `Request: ${userPrompt}`,
    '',
    'Respond with ONLY a JSON object of this exact shape and no prose:',
    '{"layoutCoherence":{"score":<1-5>,"rationale":"..."},"visualHierarchy":{"score":<1-5>,"rationale":"..."},"densityBalance":{"score":<1-5>,"rationale":"..."},"intentMatch":{"score":<1-5>,"rationale":"..."},"compositionEvidence":{"score":<1-5>,"rationale":"..."}}',
  ].join('\n');
}

/**
 * Grade the visual quality of one rendered application from its screenshot(s).
 *
 * All screenshots are sent in a single vision message. The model output is
 * validated against {@link dimensionsSchema}; on a schema mismatch the call is
 * retried once, then a {@link VisionQualityGradingError} is thrown. Advisory
 * only — this never decides pass/fail.
 */
export async function gradeScreenshotQuality(input: {
  screenshotPaths: string[];
  userPrompt: string;
  model?: string;
}): Promise<VisionQualityReport> {
  const model = input.model ?? DEFAULT_MODEL;
  const client: LLMClient = createAnthropicClient({ model });
  return gradeWithClient(client, input, model);
}

async function gradeWithClient(
  client: LLMClient,
  input: { screenshotPaths: string[]; userPrompt: string },
  model: string,
): Promise<VisionQualityReport> {
  if (input.screenshotPaths.length === 0) {
    throw new VisionQualityGradingError('No screenshots supplied to grade', null);
  }

  const images = input.screenshotPaths.map(loadImage);
  const prompt = buildGradingPrompt(input.userPrompt);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.callWithVision({
        userText: prompt,
        images,
        schema: dimensionsSchema,
        maxTokens: 1024,
        temperature: 0,
      });
      return { dimensions: response.data, model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const detail = lastError?.message ?? 'no error captured';
  throw new VisionQualityGradingError(
    `Vision grader failed after one retry: ${detail}`,
    lastError ?? null,
  );
}
