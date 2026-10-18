import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installKernelEvaluator } from '@almadar/core';
import { readLanguageBundle } from '@almadar/core/language-data';
import * as kernel from '@almadar/kernel';

kernel.initSync({ module: readFileSync(createRequire(import.meta.url).resolve('@almadar/kernel/kernel.wasm')) });
kernel.installLanguage(JSON.stringify(readLanguageBundle(join(dirname(fileURLToPath(import.meta.url)), '../..'))));
installKernelEvaluator(kernel);
