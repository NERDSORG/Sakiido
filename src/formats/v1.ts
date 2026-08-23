/**
 * Mutsumi on-disk format v1 (`formatVersion: 1`): structural types plus the
 * strict validator.
 *
 * The validator is a faithful port of guilimao/Mutsumi src/mtmFormat.ts
 * (parseAgentContext and friends, as of the `refactor(mtm): finalize format
 * v1` commit) plus the structural decodeGhostBlock from
 * src/contextManagement/ghostBlocks.ts, stripped of vscode dependencies.
 *
 * The migration pipeline validates every document it produces with this
 * code before writing it, so output is guaranteed to open in the extension
 * release that introduced format v1. When Mutsumi bumps the format version,
 * copy the new validator into formats/v(N).ts — never edit this file in
 * place (see AGENTS.md, "adding a new format version").
 */

export const MTM_FORMAT_VERSION = 1;

export const UNSUPPORTED_MTM_FORMAT = 'UNSUPPORTED_MTM_FORMAT';
export const INVALID_MTM_FILE = 'INVALID_MTM_FILE';

export class MtmFormatError extends Error {
    readonly code: string;
    readonly actualVersion?: unknown;

    constructor(
        code: typeof UNSUPPORTED_MTM_FORMAT | typeof INVALID_MTM_FILE,
        message: string,
        actualVersion?: unknown,
    ) {
        super(message);
        this.name = 'MtmFormatError';
        this.code = code;
        this.actualVersion = actualVersion;
    }
}

// ---------------------------------------------------------------------------
// Structural types (mirroring the PersistedAgentMessage family in
// guilimao/Mutsumi src/types.ts, without the pi-ai / vscode dependency tree)
// ---------------------------------------------------------------------------

export interface V1TextContent {
    type: 'text';
    text: string;
}

export interface V1ImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}

export interface V1ThinkingContent {
    type: 'thinking';
    thinking: string;
}

export interface V1ToolCall {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface V1GhostBlock {
    files: { key: string; version: number; content: string | null }[];
    tools: { key: string; argsText: string; content: string }[];
}

export interface V1UserMessage {
    role: 'user';
    content: string | (V1TextContent | V1ImageContent)[];
    timestamp?: unknown;
    mutsumi?: { ghostBlock?: V1GhostBlock };
}

export interface V1AssistantMessage {
    role: 'assistant';
    content: (V1TextContent | V1ThinkingContent | V1ToolCall)[];
    api: string;
    provider: string;
    model: string;
}

export interface V1ToolResultMessage {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: (V1TextContent | V1ImageContent)[];
    isError: boolean;
}

export type V1Message = V1UserMessage | V1AssistantMessage | V1ToolResultMessage;

export interface V1AgentMetadata {
    uuid: string;
    name: string;
    created_at: string;
    parent_agent_id: string | null;
    allowed_uris: string[];
    is_task_finished?: boolean;
    model?: string;
    provider?: string;
    reasoning_effort?: string;
    contextItems?: unknown[];
    activeRules?: string[];
    activeSkills?: string[];
    agentType?: string;
    sub_agents_list?: string[];
    [key: string]: unknown;
}

export interface V1NotebookNote {
    /** Number of user cells that precede this note. */
    beforeUserIndex: number;
    /** Original Markdown source. */
    markdown: string;
}

export interface V1AgentContext {
    formatVersion: typeof MTM_FORMAT_VERSION;
    metadata: V1AgentMetadata;
    context: V1Message[];
    notes?: V1NotebookNote[];
}

// ---------------------------------------------------------------------------
// Validator (port of Mutsumi mtmFormat.ts)
// ---------------------------------------------------------------------------

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textContent(value: unknown): value is { type: 'text'; text: string } {
    return record(value)
        && value.type === 'text'
        && typeof value.text === 'string';
}

function imageContent(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
    return record(value)
        && value.type === 'image'
        && typeof value.data === 'string'
        && typeof value.mimeType === 'string';
}

function thinkingContent(value: unknown): value is { type: 'thinking'; thinking: string } {
    return record(value)
        && value.type === 'thinking'
        && typeof value.thinking === 'string';
}

function toolCall(value: unknown): value is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } {
    return record(value)
        && value.type === 'toolCall'
        && typeof value.id === 'string'
        && typeof value.name === 'string'
        && record(value.arguments);
}

function stringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Port of contextManagement/ghostBlocks.ts decodeGhostBlock (structural only). */
export function decodeGhostBlock(value: unknown): { files: { key: string; version: number; content: string | null }[]; tools: { key: string; argsText: string; content: string }[] } | null {
    if (!record(value) || !Array.isArray(value.files) || !Array.isArray(value.tools)) {
        return null;
    }
    const files: { key: string; version: number; content: string | null }[] = [];
    for (const item of value.files) {
        if (!record(item)
            || typeof item.key !== 'string'
            || typeof item.version !== 'number' || !Number.isInteger(item.version) || item.version < 1
            || !(item.content === null || typeof item.content === 'string')) {
            return null;
        }
        files.push({ key: item.key, version: item.version, content: item.content });
    }
    const tools: { key: string; argsText: string; content: string }[] = [];
    for (const item of value.tools) {
        if (!record(item)
            || typeof item.key !== 'string'
            || typeof item.argsText !== 'string'
            || typeof item.content !== 'string') {
            return null;
        }
        tools.push({ key: item.key, argsText: item.argsText, content: item.content });
    }
    return { files, tools };
}

function userMessage(value: unknown): value is V1Message & { role: 'user' } {
    if (!record(value)) return false;
    const content = value.content;
    const validContent = typeof content === 'string'
        || (Array.isArray(content) && content.every(part => textContent(part) || imageContent(part)));
    if (!validContent) return false;
    if (value.mutsumi !== undefined) {
        if (!record(value.mutsumi)) return false;
        if (value.mutsumi.ghostBlock !== undefined && !decodeGhostBlock(value.mutsumi.ghostBlock)) return false;
    }
    return true;
}

function assistantMessage(value: unknown): value is V1Message & { role: 'assistant' } {
    if (!record(value)) return false;
    return Array.isArray(value.content)
        && value.content.every(block => textContent(block) || thinkingContent(block) || toolCall(block))
        && typeof value.api === 'string'
        && typeof value.provider === 'string'
        && typeof value.model === 'string'
        && value.mutsumi === undefined;
}

function toolResultMessage(value: unknown): value is V1Message & { role: 'toolResult' } {
    if (!record(value)) return false;
    return typeof value.toolCallId === 'string'
        && typeof value.toolName === 'string'
        && Array.isArray(value.content)
        && value.content.every(part => textContent(part) || imageContent(part))
        && typeof value.isError === 'boolean'
        && value.mutsumi === undefined;
}

function parseMessages(value: unknown): V1Message[] {
    if (!Array.isArray(value)) throw invalid('context must be an array');
    const messages: V1Message[] = [];
    let sawUser = false;
    let lastRole: V1Message['role'] | undefined;
    const availableToolCalls = new Map<string, string>();

    for (let index = 0; index < value.length; index++) {
        const raw = value[index];
        if (!record(raw) || typeof raw.role !== 'string') throw invalid(`context[${index}] is not a message`);
        let message: V1Message;
        if (raw.role === 'user' && userMessage(raw)) {
            if (availableToolCalls.size > 0) {
                throw invalid(`context[${index}] has an unexpected user message`);
            }
            sawUser = true;
            message = raw;
        } else if (raw.role === 'assistant' && sawUser && assistantMessage(raw)) {
            if ((lastRole !== 'user' && lastRole !== 'toolResult') || availableToolCalls.size > 0) {
                throw invalid(`context[${index}] has an unexpected assistant message`);
            }
            const assistant = raw as unknown as V1Message & { role: 'assistant'; content: { type: string }[] };
            for (const block of assistant.content) {
                if (block.type === 'toolCall') {
                    const toolCallBlock = block as unknown as { id: string };
                    if (availableToolCalls.has(toolCallBlock.id)) {
                        throw invalid(`context[${index}] contains duplicate tool call ID "${toolCallBlock.id}"`);
                    }
                    const named = block as unknown as { id: string; name: string };
                    availableToolCalls.set(named.id, named.name);
                }
            }
            message = assistant;
        } else if (raw.role === 'toolResult' && sawUser && toolResultMessage(raw)) {
            if (lastRole !== 'assistant' && lastRole !== 'toolResult') {
                throw invalid(`context[${index}] has an unexpected tool result`);
            }
            const toolResult = raw as unknown as V1Message & { role: 'toolResult'; toolCallId: string; toolName: string };
            const expectedName = availableToolCalls.get(toolResult.toolCallId);
            if (expectedName === undefined || expectedName !== toolResult.toolName) {
                throw invalid(`context[${index}] does not match a preceding tool call`);
            }
            availableToolCalls.delete(toolResult.toolCallId);
            message = toolResult;
        } else {
            throw invalid(`context[${index}] is not a valid pi-ai message or violates turn ordering`);
        }
        messages.push(message);
        lastRole = message.role;
    }
    if (availableToolCalls.size > 0) throw invalid('context ends before all tool calls have results');
    return messages;
}

function parseNotes(value: unknown, userCount: number): { beforeUserIndex: number; markdown: string }[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw invalid('notes must be an array');
    const notes: { beforeUserIndex: number; markdown: string }[] = [];
    for (let index = 0; index < value.length; index++) {
        const item = value[index];
        if (!record(item)
            || !Number.isInteger(item.beforeUserIndex)
            || (item.beforeUserIndex as number) < 0
            || (item.beforeUserIndex as number) > userCount
            || typeof item.markdown !== 'string') {
            throw invalid(`notes[${index}] is not a valid notebook note`);
        }
        notes.push({ beforeUserIndex: item.beforeUserIndex as number, markdown: item.markdown });
    }
    return notes.length > 0 ? notes : undefined;
}

function invalid(detail: string): MtmFormatError {
    return new MtmFormatError(INVALID_MTM_FILE, `Invalid .mtm file: ${detail}`);
}

export function parseAgentContext(value: unknown): V1AgentContext {
    if (!record(value)) throw invalid('root must be an object');
    if (value.formatVersion !== MTM_FORMAT_VERSION) {
        throw new MtmFormatError(
            UNSUPPORTED_MTM_FORMAT,
            `Unsupported .mtm format (expected ${MTM_FORMAT_VERSION}, received ${String(value.formatVersion)}). Migrate this file with the standalone migration tool.`,
            value.formatVersion,
        );
    }
    if (!record(value.metadata)) throw invalid('metadata must be an object');
    const metadata = value.metadata as unknown as V1AgentMetadata;
    if (typeof metadata.uuid !== 'string' || typeof metadata.name !== 'string'
        || typeof metadata.created_at !== 'string' || !stringArray(metadata.allowed_uris)
        || (metadata.parent_agent_id !== null && typeof metadata.parent_agent_id !== 'string')) {
        throw invalid('metadata is missing required fields');
    }
    if ((metadata.model === undefined) !== (metadata.provider === undefined)
        || (metadata.model !== undefined && typeof metadata.model !== 'string')
        || (metadata.provider !== undefined && typeof metadata.provider !== 'string')) {
        throw invalid('metadata model and provider must be a complete string pair');
    }
    if (metadata.provider === 'kimi-for-coding') throw invalid('metadata uses the removed provider ID "kimi-for-coding"');
    const context = parseMessages(value.context);
    for (const message of context) {
        if (message.role === 'assistant' && message.provider === 'kimi-for-coding') {
            throw invalid('assistant message uses the removed provider ID "kimi-for-coding"');
        }
    }
    const notes = parseNotes(value.notes, context.filter(message => message.role === 'user').length);
    return { formatVersion: MTM_FORMAT_VERSION, metadata, context, ...(notes ? { notes } : {}) };
}
