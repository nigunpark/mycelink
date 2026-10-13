/**
 * The isolation the harness's own tests run delivered code in: the real
 * bubblewrap boundary wherever it works (Linux; WSL here), else the
 * explicit, unenforced stand-in — whose verdicts say `enforced: false` and
 * which no benchmark tool ever uses (they fail closed instead).
 */
// @ts-expect-error -- plain ESM module without type declarations
import { bubblewrap, detectSandbox, unconfined } from '../../evals-public-projects/lib/sandbox.mjs';

const detected = detectSandbox();

export const TEST_ISOLATION = detected.available ? bubblewrap(detected) : unconfined(`harness tests on a host without the boundary: ${detected.reason}`);

/** Whether delivered code in these tests runs inside the real boundary. */
export const ISOLATED: boolean = TEST_ISOLATION.enforced;
