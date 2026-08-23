/**
 * Structural types for Mutsumi format v0 — the .mtm layout written by the
 * 0.0.8 release (untrusted migration input).
 *
 * Shapes mirror src/types.ts and src/notebook/serializer.ts of the
 * NERDSORG/Mutsumi v0.0.8 tag: an OpenAI-style message array under a
 * `{ metadata, context }` root with no format discriminator.
 *
 * v0 is never the target of a migration step, so this module has no
 * validator; core/detect.ts sniffs its shape structurally.
 */

export interface V0AgentMetadata {
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

export interface V0ContentPartText {
    type: 'text';
    text: string;
}

export interface V0ContentPartImage {
    type: 'image_url';
    image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type V0ContentPart = V0ContentPartText | V0ContentPartImage;

export type V0MessageContent = string | V0ContentPart[] | null;

export interface V0ToolCall {
    id: string;
    type?: string;
    function: { name: string; arguments?: string };
}

export interface V0Message {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: V0MessageContent;
    tool_calls?: V0ToolCall[];
    tool_call_id?: string;
    name?: string;
    reasoning_content?: string;
    metadata?: Record<string, unknown>;
}

export interface V0AgentContext {
    metadata: V0AgentMetadata;
    context: V0Message[];
}
