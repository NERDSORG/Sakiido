/**
 * The migration step contract: one hop in the version chain, from format
 * `from` to format `to` (e.g. v0 → v1).
 *
 * A step converts an untrusted parsed document of its source format into a
 * document of its target format. Steps must be pure: no I/O, no mutation of
 * the input. Every conversion that loses or approximates information must be
 * reported through `warnings` so the CLI can surface it to the user.
 *
 * Once a newer step exists, an older step is FROZEN — it is never edited
 * again (regressions in frozen steps would silently corrupt users' history).
 * See AGENTS.md, "step freeze rule".
 */

/** Thrown when a step receives input it cannot meaningfully convert. */
export class MigrationInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MigrationInputError';
    }
}

export interface StepResult {
    /** The converted document, in the step's target format (not yet validated). */
    root: unknown;
    /** Human-readable notes about lossy or approximated conversions. */
    warnings: string[];
}

export interface MigrationStep {
    /** Source format version this step consumes. */
    readonly from: number;
    /** Format version this step produces (from + 1 by convention). */
    readonly to: number;
    /**
     * Strictly validate a document of the target format and return the
     * normalized document. Throws on anything the corresponding Mutsumi
     * release would refuse to open. The pipeline runs this after every step,
     * so a bug in one step cannot cascade into the next.
     */
    readonly validateTarget: (root: unknown) => unknown;
    /** Convert a source-format document; throws MigrationInputError on unusable input. */
    readonly migrate: (root: unknown) => StepResult;
}
