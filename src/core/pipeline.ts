/**
 * The migration pipeline: detect the format version, then walk the step
 * chain from core/registry.ts up to LATEST_FORMAT_VERSION, validating the
 * document after every hop.
 *
 * This module is version-agnostic — it only knows about steps through the
 * registry — so new Mutsumi format versions require no changes here.
 */

import { detectFormatVersion } from './detect.ts';
import { LATEST_FORMAT_VERSION, STEPS } from './registry.ts';

export type PipelineOutcome =
    | { status: 'up-to-date'; version: number }
    | {
        status: 'migrated';
        fromVersion: number;
        toVersion: number;
        output: string;
        warnings: string[];
    }
    | { status: 'too-new'; version: number }
    | { status: 'failed'; detail: string };

/**
 * Migrate a parsed .mtm document to the latest supported format.
 *
 * - up-to-date: the document is already the latest format and passes its
 *   strict validation (nothing to do).
 * - migrated: `output` holds the serialized latest-format document; every
 *   intermediate version passed its validator before the next step ran.
 * - too-new: the document's formatVersion exceeds LATEST_FORMAT_VERSION —
 *   the user's extension is newer than this tool; they should update.
 * - failed: unusable input (see detail).
 */
export function migrateDocumentToLatest(root: unknown): PipelineOutcome {
    const detection = detectFormatVersion(root);
    if (detection.kind === 'unrecognized') {
        return { status: 'failed', detail: 'not a recognizable Mutsumi .mtm document' };
    }
    if (detection.version > LATEST_FORMAT_VERSION) {
        return { status: 'too-new', version: detection.version };
    }
    if (detection.version === LATEST_FORMAT_VERSION) {
        const latest = STEPS[STEPS.length - 1]!;
        try {
            latest.validateTarget(root);
        } catch (error) {
            return { status: 'failed', detail: `already format v${LATEST_FORMAT_VERSION} but fails validation: ${errorMessage(error)}` };
        }
        return { status: 'up-to-date', version: detection.version };
    }

    const warnings: string[] = [];
    let current = root;
    let version = detection.version;
    for (const step of STEPS) {
        if (step.from < version) continue;
        try {
            const result = step.migrate(current);
            current = step.validateTarget(result.root);
            warnings.push(...result.warnings);
        } catch (error) {
            return { status: 'failed', detail: errorMessage(error) };
        }
        version = step.to;
    }
    return {
        status: 'migrated',
        fromVersion: detection.version,
        toVersion: version,
        output: JSON.stringify(current, null, 2),
        warnings,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
