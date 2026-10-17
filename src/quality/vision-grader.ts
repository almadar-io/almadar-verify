/**
 * Vision-based visual quality grader.
 *
 * Feeds one or more rendered screenshots plus the originating user prompt to a
 * vision-capable Claude model (default `claude-haiku-4-5`) through `std-llm` run on the
 * kernel (`programs/vision-grader.lolo`) and returns a schema-validated, advisory
 * quality report. All model access is the kernel's — this module never talks HTTP itself.
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import type { JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile, type KernelProgramOptions } from '@almadar/runtime/kernelProgram';

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
  study?: StudyQualityReport;
}

export interface StudyQualityEvidence {
  id: string;
  kind: 'check' | 'frame';
  observation: JsonValue;
}

export interface StudyQualityInput {
  turnPrompt: string;
  evidence: ReadonlyArray<StudyQualityEvidence>;
}

const studyCriterionSchema = z.object({
  score: z.number().int().min(1).max(10),
  rationale: z.string().min(1),
  citations: z.array(z.string().min(1)).min(1),
});

export const studyQualitySchema = z.object({ criteria: z.object({
  completion: studyCriterionSchema,
  design: studyCriterionSchema,
  utility: studyCriterionSchema,
  intentFit: studyCriterionSchema,
}) });

export type StudyQualityReport = z.infer<typeof studyQualitySchema>;

export function validateStudyQuality(report: StudyQualityReport, input: StudyQualityInput): StudyQualityReport {
  const parsed = studyQualitySchema.parse(report);
  const evidence = new Map(input.evidence.map(item => [item.id, item.kind]));
  if (evidence.size !== input.evidence.length || input.evidence.some(item => item.id.trim().length === 0)) {
    throw new Error('Study evidence IDs must be nonempty and unique');
  }
  for (const [criterion, value] of Object.entries(parsed.criteria)) {
    if (value.citations.some(id => !evidence.has(id))) throw new Error(`Study criterion '${criterion}' cites unavailable evidence`);
    const requiredKind = criterion === 'design' ? 'frame' : 'check';
    if (!value.citations.some(id => evidence.get(id) === requiredKind)) throw new Error(`Study criterion '${criterion}' requires ${requiredKind} evidence`);
  }
  return parsed;
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

const DEFAULT_MODEL = 'claude-haiku-4-5';
const PROGRAM_ORBITAL = 'VisionGraderOrbital';

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

const studyVisionSchema = z.object({ dimensions: dimensionsSchema, study: studyQualitySchema });

type VisionImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface VisionImagePart {
  base64: string;
  mediaType: VisionImageMediaType;
}

/** Where the kernel runs the grader: the transport and tools a host may name. Absent, the real ones. */
export type VisionGraderHost = Pick<KernelProgramOptions, 'http' | 'kernelDir'> & { orb?: string };

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

const DIMENSIONS_SHAPE = '{"layoutCoherence":{"score":<1-5>,"rationale":"..."},"visualHierarchy":{"score":<1-5>,"rationale":"..."},"densityBalance":{"score":<1-5>,"rationale":"..."},"intentMatch":{"score":<1-5>,"rationale":"..."},"compositionEvidence":{"score":<1-5>,"rationale":"..."}}';
const STUDY_SHAPE = '{"dimensions":{<the five visual dimensions as specified above>},"study":{"criteria":{"completion":{"score":<1-10>,"rationale":"...","citations":["supplied-id"]},"design":{"score":<1-10>,"rationale":"...","citations":["supplied-id"]},"utility":{"score":<1-10>,"rationale":"...","citations":["supplied-id"]},"intentFit":{"score":<1-10>,"rationale":"...","citations":["supplied-id"]}}}}';

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('vision-grader: package root not found');
    dir = parent;
  }
  return dir;
}

/**
 * Assemble the grading prompt. Deliberately generic: it grounds each dimension
 * in the render substrate's visual language (stack-based layout, typography
 * hierarchy, spacing/density discipline, atom→molecule composition depth) and
 * never mentions any specific spec, organism, entity, or domain.
 */
export function buildGradingPrompt(userPrompt: string, study?: StudyQualityInput): string {
  const prompt = [
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
    DIMENSIONS_SHAPE,
  ].join('\n');
  if (study === undefined) return prompt;
  return [prompt,
    '',
    'For this study, retain the five visual dimensions and ALSO grade four independent criteria on integer scales from 1 to 10. Do not convert the five visual scores into study scores.',
    'completion: 1–3 most requests missing; 4–6 core present but secondary missing; 7–8 all present but some shallow; 9–10 all present and working.',
    'design: 1–3 broken/blank/overflow; 4–6 default/cluttered/duplicated controls; 7–8 clean consistent theme and hierarchy; 9–10 fitting theme, density, empty states and realistic content.',
    'utility: 1–3 dead affordances; 4–6 main flow works but edges fail; 7–8 flows and feedback work; 9–10 flows, validation and roles/rules enforced.',
    'intentFit: 1–3 wrong domain; 4–6 right domain but generic; 7–8 user nouns/fields/rules; 9–10 tailored to this request.',
    'Screenshots alone do not prove functionality. Ground functional conclusions in the supplied observable checks, including failures; ground design in the supplied frame evidence.',
    'Every criterion needs a nonempty rationale and exact citation IDs from the supplied evidence. Design must cite a frame; completion, utility and intentFit must cite a check. Never invent evidence IDs.',
    `Current turn request: ${study.turnPrompt}`,
    `Observable evidence: ${JSON.stringify(study.evidence)}`,
    'The required response shape for this study replaces the earlier response shape:',
    STUDY_SHAPE,
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
  study?: StudyQualityInput;
  host?: VisionGraderHost;
}): Promise<VisionQualityReport> {
  const model = input.model ?? DEFAULT_MODEL;
  if (input.screenshotPaths.length === 0) {
    throw new VisionQualityGradingError('No screenshots supplied to grade', null);
  }
  const images = input.screenshotPaths.map(loadImage);
  const root = packageRoot();
  const host = input.host ?? {};
  const schema = await resolveProgramFile(join(root, 'programs', 'vision-grader.lolo'), root, host.orb);
  const program = await KernelProgram.open(schema, {
    languageFrom: root,
    ...(host.http !== undefined ? { http: host.http } : {}),
    ...(host.kernelDir !== undefined ? { kernelDir: host.kernelDir } : {}),
  });
  try {
    return await gradeWithProgram(program, input, images, model);
  } finally {
    program.close();
  }
}

async function extractJson(
  program: KernelProgram,
  input: { userPrompt: string; study?: StudyQualityInput },
  images: VisionImagePart[],
  model: string,
): Promise<JsonValue> {
  const schema = JSON.stringify(z.toJSONSchema(input.study === undefined ? dimensionsSchema : studyVisionSchema));
  const run = await program.dispatch(PROGRAM_ORBITAL, 'LLM_EXTRACT', {
    text: buildGradingPrompt(input.userPrompt, input.study),
    schema,
    systemPrompt: `You return only JSON that satisfies this JSON Schema, with no prose and no code fence:\n${schema}`,
    model,
    temperature: 0,
    maxTokens: input.study === undefined ? 1024 : 4096,
    images: images.map((image) => ({ mediaType: image.mediaType, data: image.base64 })),
  });
  const done = run.emits.find((emit) => emit.event === 'LLM_EXTRACT_RESULT');
  if (done?.payload !== undefined && typeof done.payload.json === 'string') return JSON.parse(done.payload.json);
  const failed = run.emits.find((emit) => emit.event === 'LLM_FAILED');
  const message = failed?.payload?.message;
  throw new Error(typeof message === 'string' ? message : 'the vision call failed');
}

async function gradeWithProgram(
  program: KernelProgram,
  input: { userPrompt: string; study?: StudyQualityInput },
  images: VisionImagePart[],
  model: string,
): Promise<VisionQualityReport> {

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await extractJson(program, input, images, model);
      if (input.study !== undefined) {
        const report = studyVisionSchema.parse(data);
        return { dimensions: report.dimensions, study: validateStudyQuality(report.study, input.study), model };
      }
      return { dimensions: dimensionsSchema.parse(data), model };
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
