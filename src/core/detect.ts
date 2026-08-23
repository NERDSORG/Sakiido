/**
 * Format detection for .mtm documents (structural sniffing only; the strict
 * validators in formats/ do the real checking).
 *
 * Documents with a `formatVersion` field identify themselves directly.
 * Format v0 (Mutsumi 0.0.8) predates the discriminator: it is recognized by
 * its `{ metadata, context }` shape with the legacy required metadata fields.
 */

import type { V0AgentContext } from '../formats/v0.ts';

export type Detection =
    | { kind: 'version'; version: number }
    | { kind: 'unrecognized' };

export function detectFormatVersion(root: unknown): Detection {
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
        return { kind: 'unrecognized' };
    }
    const record = root as Record<string, unknown>;
    if ('formatVersion' in record) {
        const version = record.formatVersion;
        if (typeof version === 'number' && Number.isInteger(version) && version >= 0) {
            return { kind: 'version', version };
        }
        return { kind: 'unrecognized' };
    }
    if (looksLikeV0(record as unknown as V0AgentContext)) {
        return { kind: 'version', version: 0 };
    }
    return { kind: 'unrecognized' };
}

function looksLikeV0(root: V0AgentContext): boolean {
    const metadata = root.metadata;
    const context = root.context;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false;
    if (!Array.isArray(context)) return false;
    const required = (metadata as Record<string, unknown>);
    return typeof required.uuid === 'string'
        && typeof required.name === 'string'
        && typeof required.created_at === 'string'
        && (required.parent_agent_id === null || typeof required.parent_agent_id === 'string')
        && Array.isArray(required.allowed_uris)
        && context.every(message =>
            typeof (message as unknown as Record<string, unknown>).role === 'string');
}
