/**
 * Node host for the kernel planner: initialise the wasm once and install the language bundle read from
 * `languageRoot` (the directory the installed `@almadar/core`, `@almadar/std` and language packs resolve from),
 * so the event-contract table is available to contract planning.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readLanguageBundle } from '@almadar/core/language-data';
import * as kernel from '@almadar/kernel';
import { createKernelPlanner, type KernelExports, type KernelPlanner } from './kernel-planner.js';

let initialised = false;

/** The initialised wasm kernel with the language bundle installed; the first install in a process wins. */
export function loadKernelExports(languageRoot: string): KernelExports {
  if (!initialised) {
    kernel.initSync({ module: readFileSync(createRequire(import.meta.url).resolve('@almadar/kernel/kernel.wasm')) });
    kernel.installLanguage(JSON.stringify(readLanguageBundle(languageRoot)));
    initialised = true;
  }
  return kernel;
}

/** The kernel planner over {@link loadKernelExports}. */
export function loadKernelPlanner(languageRoot: string): KernelPlanner {
  return createKernelPlanner(loadKernelExports(languageRoot));
}
