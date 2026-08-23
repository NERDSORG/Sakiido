/**
 * The step registry — the single place that enumerates the version chain.
 *
 * STEPS must stay sorted and contiguous: v0 → v1 → … → LATEST_FORMAT_VERSION
 * with no gaps (test/core/pipeline.test.ts enforces this). Adding support
 * for a new Mutsumi format version means appending one entry here, plus the
 * new formats/v(N).ts and steps/v(N-1)-to-v(N).ts modules — nothing else in
 * the tool is version-aware. See AGENTS.md for the full checklist.
 */

import { v0ToV1 } from '../steps/v0-to-v1.ts';
import type { MigrationStep } from './step.ts';

/** All migration steps, oldest first. */
export const STEPS: readonly MigrationStep[] = [
    v0ToV1,
];

/** The newest format version this tool can produce. */
export const LATEST_FORMAT_VERSION: number = STEPS[STEPS.length - 1]!.to;
