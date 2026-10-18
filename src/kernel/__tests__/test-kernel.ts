import { loadKernelPlanner } from '../load-node.js';

/** The kernel planner the pipeline tests plan with: the language installed in this package's own `node_modules`. */
export const testKernel = loadKernelPlanner(process.cwd());
