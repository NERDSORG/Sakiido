/**
 * Step v0 → v1: Mutsumi 0.0.8 sessions → formatVersion 1.
 *
 * Input: a parsed v0 `{ metadata, context }` document (untrusted).
 * Output: a v1 AgentContext (the pipeline validates it against
 * formats/v1.ts before anything else touches it).
 *
 * Conversion rules (see docs/format-v0-v1.md for the full comparison):
 *
 * - metadata keeps its fields; model/provider become a complete pair or are
 *   dropped; provider IDs are remapped ("kimi-for-coding" → "kimi-coding").
 * - user: content parts converted (image_url data URIs → image blocks, plain
 *   URLs → markdown text); msg.metadata.last_ghost_block moves to
 *   mutsumi.ghostBlock after structural validation.
 * - assistant: reasoning_content → thinking block; content → text block;
 *   tool_calls → toolCall blocks (function.arguments JSON parsed). Every
 *   assistant gets api/provider/model (from metadata, remapped, with safe
 *   fallbacks).
 * - tool: → toolResult with toolCallId/toolName, array content, and isError
 *   derived from the 0.0.8 "Error: ..." string convention.
 * - system: → notebook note ("**System**: …"); v1 has no system role and
 *   0.0.8 never sent persisted system messages to the model either.
 * - assistant/tool messages before the first user message (orphans, which v1
 *   rejects): flattened to a markdown note, replicating the 0.0.8 notebook
 *   rendering.
 * - consecutive assistant messages (v1 rejects): merged into one.
 * - tool calls without a result (interrupted sessions, v1 rejects): a
 *   synthetic isError toolResult is appended.
 *
 * This step is complete and frozen once a v1 → v2 step exists; do not edit
 * it (see AGENTS.md, "step freeze rule").
 */

import { MigrationInputError, type MigrationStep } from '../core/step.ts';
import type {
    V0Message,
    V0ContentPart,
    V0MessageContent,
} from '../formats/v0.ts';
import { decodeGhostBlock, MTM_FORMAT_VERSION, parseAgentContext } from '../formats/v1.ts';
import type {
    V1AgentContext,
    V1ImageContent,
    V1Message,
    V1NotebookNote,
    V1TextContent,
    V1ToolResultMessage,
    V1ToolCall,
} from '../formats/v1.ts';
import { inferApi, remapProvider } from '../providers.ts';

const MISSING_RESULT_TEXT = '[Migration] No tool result was recorded in the 0.0.8 file (the session was likely interrupted). A placeholder result was inserted.';

export interface MigrationOutcome {
    context: V1AgentContext;
    warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warn(warnings: string[], message: string): void {
    warnings.push(message);
}

/** Convert one v0 message content value to v1 user-visible parts. */
function convertUserContent(
    content: V0MessageContent,
    warnings: string[],
): string | (V1TextContent | V1ImageContent)[] {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    const parts: (V1TextContent | V1ImageContent)[] = [];
    for (const part of content as V0ContentPart[]) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
            const url = part.image_url.url;
            const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(url);
            if (dataUri) {
                parts.push({ type: 'image', mimeType: dataUri[1] ?? '', data: dataUri[2] ?? '' });
            } else {
                warn(warnings, `A user image referenced by URL instead of inline data was kept as markdown text: ${url.slice(0, 80)}`);
                parts.push({ type: 'text', text: `![image](${url})` });
            }
        }
    }
    return parts;
}

/** Flatten assistant content (string or parts) to plain text. */
function contentToText(content: V0MessageContent): string {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    return content.map(part => part?.type === 'text' ? part.text : '').join('');
}

/** Build the ordered content blocks of one v1 assistant message. */
function buildAssistantBlocks(
    message: V0Message,
    warnings: string[],
): (V1TextContent | { type: 'thinking'; thinking: string } | V1ToolCall)[] {
    const blocks: (V1TextContent | { type: 'thinking'; thinking: string } | V1ToolCall)[] = [];
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        blocks.push({ type: 'thinking', thinking: message.reasoning_content });
    }
    const text = contentToText(message.content);
    if (text.length > 0) {
        blocks.push({ type: 'text', text });
    }
    for (const call of message.tool_calls ?? []) {
        if (!call?.id || !call.function?.name) {
            warn(warnings, 'Dropped a malformed tool call without id or name.');
            continue;
        }
        let args: Record<string, unknown> = {};
        if (typeof call.function.arguments === 'string' && call.function.arguments.length > 0) {
            try {
                const parsed = JSON.parse(call.function.arguments);
                if (isRecord(parsed)) args = parsed;
            } catch {
                warn(warnings, `Tool call "${call.function.name}" had non-JSON arguments; stored as {}.`);
            }
        }
        blocks.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
    }
    return blocks;
}

/** Build one v1 toolResult message for a pending tool call. */
function buildToolResult(
    toolCallId: string,
    toolName: string,
    content: V0MessageContent,
): V1ToolResultMessage {
    const text = contentToText(content);
    const parts: V1TextContent[] = text.length > 0 ? [{ type: 'text', text }] : [];
    return {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: parts,
        isError: /^Error\b/.test(text.trimStart()),
    };
}

function synthesizeToolResult(toolCallId: string, toolName: string): V1ToolResultMessage {
    return {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text: MISSING_RESULT_TEXT }],
        isError: true,
    };
}

/**
 * Flatten an orphan group (assistant/tool messages with no preceding user
 * message) to markdown, replicating the 0.0.8 serializer rendering for
 * orphan notebook cells.
 */
function flattenOrphanGroup(group: V0Message[]): string {
    const parts: string[] = [];
    const toolCallMap = new Map<string, { name: string; argsText: string }>();
    for (const message of group) {
        if (message.role !== 'assistant') continue;
        for (const call of message.tool_calls ?? []) {
            if (call?.id && call.function?.name) {
                toolCallMap.set(call.id, { name: call.function.name, argsText: call.function.arguments ?? '{}' });
            }
        }
    }
    for (const message of group) {
        if (message.role === 'assistant') {
            const reasoning = message.reasoning_content ?? '';
            if (reasoning) {
                parts.push(`> **Reasoning**\n>\n> ${reasoning.split('\n').join('\n> ')}`);
            }
            const text = contentToText(message.content);
            if (text) parts.push(text);
            for (const call of message.tool_calls ?? []) {
                if (call?.id && call.function?.name) {
                    parts.push(`**Tool Call: ${call.function.name}**`);
                }
            }
        } else if (message.role === 'tool') {
            const mapped = message.tool_call_id ? toolCallMap.get(message.tool_call_id) : undefined;
            const name = mapped?.name ?? message.name ?? 'unknown';
            const result = contentToText(message.content);
            parts.push(`**Tool Call: ${name}**${result ? `\n\n\`\`\`\n${result}\n\`\`\`` : ''}`);
        }
    }
    return parts.join('\n\n');
}

function migrateMetadata(
    raw: unknown,
    warnings: string[],
): V1AgentContext['metadata'] {
    if (!isRecord(raw)) throw new MigrationInputError('metadata must be an object');
    const metadata = raw as V1AgentContext['metadata'];
    if (typeof metadata.uuid !== 'string' || typeof metadata.name !== 'string'
        || typeof metadata.created_at !== 'string'
        || !Array.isArray(metadata.allowed_uris) || !metadata.allowed_uris.every(item => typeof item === 'string')
        || (metadata.parent_agent_id !== null && typeof metadata.parent_agent_id !== 'string')) {
        throw new MigrationInputError('metadata is missing required fields (uuid, name, created_at, allowed_uris, parent_agent_id)');
    }

    let model: string | undefined = typeof metadata.model === 'string' ? metadata.model : undefined;
    let provider: string | undefined = typeof metadata.provider === 'string' ? metadata.provider : undefined;

    if (model !== undefined && provider === undefined) {
        warn(warnings, `metadata.model "${model}" had no provider; dropped so the agent falls back to the global default model.`);
        model = undefined;
    } else if (provider !== undefined && model === undefined) {
        warn(warnings, `metadata.provider "${provider}" had no model; both dropped so the agent falls back to the global default model.`);
        provider = undefined;
    } else if (provider !== undefined) {
        const result = remapProvider(provider);
        if (result.remapped) {
            warn(warnings, `metadata.provider "${provider}" remapped to "${result.provider}" (the old provider ID was removed in format v1).`);
        }
        provider = result.provider;
    }

    const migrated: V1AgentContext['metadata'] = { ...metadata };
    if (model === undefined) {
        delete migrated.model;
        delete migrated.provider;
    } else {
        migrated.model = model;
        migrated.provider = provider;
    }
    return migrated;
}

export function migrateLegacyContext(root: unknown): MigrationOutcome {
    if (!isRecord(root)) throw new MigrationInputError('root must be an object');
    if (!Array.isArray(root.context)) throw new MigrationInputError('context must be an array');

    const warnings: string[] = [];
    const metadata = migrateMetadata(root.metadata, warnings);

    const sessionProvider = metadata.provider ?? 'unknown';
    const sessionModel = metadata.model ?? 'unknown';
    if (sessionProvider === 'unknown' && (root.context as V0Message[]).some(m => m?.role === 'assistant')) {
        warn(warnings, 'The file has assistant messages but no usable model/provider pair; they were persisted with provider/model "unknown".');
    }
    const api = inferApi(sessionProvider);

    const messages = root.context as V0Message[];

    const out: V1Message[] = [];
    const notes: V1NotebookNote[] = [];
    const pending = new Map<string, string>();
    let sawUser = false;
    let userCount = 0;
    let orphanBuffer: V0Message[] = [];

    const flushOrphans = (): void => {
        if (orphanBuffer.length === 0) return;
        notes.push({ beforeUserIndex: userCount, markdown: flattenOrphanGroup(orphanBuffer) });
        warn(warnings, `${orphanBuffer.length} assistant/tool message(s) before the first user message (not representable in v1) were flattened into a notebook note.`);
        orphanBuffer = [];
    };

    const flushPending = (): void => {
        for (const [id, name] of pending) {
            out.push(synthesizeToolResult(id, name));
            warn(warnings, `Tool call "${name}" (${id}) had no result in the source file; a placeholder error result was inserted.`);
        }
        pending.clear();
    };

    for (const message of messages) {
        if (!isRecord(message) || typeof message.role !== 'string') {
            throw new MigrationInputError('context contains a non-message entry');
        }
        const legacy = message as unknown as V0Message;

        if (legacy.role === 'system') {
            flushOrphans();
            const text = contentToText(legacy.content);
            notes.push({ beforeUserIndex: userCount, markdown: `**System**: ${text}` });
            continue;
        }

        if (!sawUser && (legacy.role === 'assistant' || legacy.role === 'tool')) {
            orphanBuffer.push(legacy);
            continue;
        }

        if (legacy.role === 'user') {
            flushOrphans();
            if (pending.size > 0) {
                flushPending();
            }

            const migrated: V1Message & { role: 'user' } = {
                role: 'user',
                content: convertUserContent(legacy.content, warnings),
            };

            if (isRecord(legacy.metadata)) {
                const { last_ghost_block: ghostBlockRaw, ...rest } = legacy.metadata;
                if (ghostBlockRaw !== undefined) {
                    const ghostBlock = decodeGhostBlock(ghostBlockRaw);
                    if (ghostBlock) {
                        migrated.mutsumi = { ghostBlock };
                    } else {
                        warn(warnings, 'A user message carried a structurally invalid ghost block; it was dropped.');
                    }
                }
                const dropped = Object.keys(rest).filter(key => key !== 'mutsumi_interaction' && key !== 'role');
                if (dropped.length > 0) {
                    warn(warnings, `A user message carried unsupported metadata fields (${dropped.join(', ')}); they were dropped.`);
                }
            }

            out.push(migrated);
            sawUser = true;
            userCount++;
            continue;
        }

        if (legacy.role === 'assistant') {
            // v1 rejects an assistant while tool calls are still unanswered
            // (a lost-result round in 0.0.8): answer them first.
            if (pending.size > 0) flushPending();
            const blocks = buildAssistantBlocks(legacy, warnings);
            const last = out[out.length - 1];
            if (last?.role === 'assistant') {
                // v1 forbids consecutive assistant messages: merge into one.
                last.content.push(...blocks);
                warn(warnings, 'Two consecutive assistant messages were merged (v1 allows only one assistant message per turn).');
            } else {
                out.push({
                    role: 'assistant',
                    content: blocks,
                    api,
                    provider: sessionProvider,
                    model: sessionModel,
                });
            }
            for (const block of blocks) {
                if (block.type === 'toolCall') pending.set(block.id, block.name);
            }
            continue;
        }

        if (legacy.role === 'tool') {
            const id = legacy.tool_call_id;
            const registeredName = id !== undefined ? pending.get(id) : undefined;
            if (id === undefined || registeredName === undefined) {
                warn(warnings, `A tool result (id ${JSON.stringify(id)}, name ${JSON.stringify(legacy.name ?? null)}) matched no preceding tool call and was dropped.`);
                continue;
            }
            if (legacy.name !== undefined && legacy.name !== registeredName) {
                warn(warnings, `Tool result "${id}" reported name "${legacy.name}" but the call was to "${registeredName}"; the registered name was kept.`);
            }
            pending.delete(id);
            out.push(buildToolResult(id, registeredName, legacy.content));
            continue;
        }

        throw new MigrationInputError(`context contains a message with unknown role "${legacy.role}"`);
    }

    flushOrphans();
    flushPending();

    const result: V1AgentContext = {
        formatVersion: MTM_FORMAT_VERSION,
        metadata,
        context: out,
        ...(notes.length > 0 ? { notes } : {}),
    };
    return { context: result, warnings };
}

export const v0ToV1: MigrationStep = {
    from: 0,
    to: 1,
    validateTarget: parseAgentContext,
    migrate(root: unknown) {
        const { context, warnings } = migrateLegacyContext(root);
        return { root: context, warnings };
    },
};
