import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrateLegacyContext } from '../../src/steps/v0-to-v1.ts';
import { detectFormatVersion } from '../../src/core/detect.ts';
import { parseAgentContext } from '../../src/formats/v1.ts';
import type { V0AgentContext } from '../../src/formats/v0.ts';
import type { V1AssistantMessage, V1ToolResultMessage, V1UserMessage } from '../../src/formats/v1.ts';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v0');

async function loadFixture(name: string): Promise<V0AgentContext> {
    return JSON.parse(await readFile(join(fixturesDir, name), 'utf8')) as V0AgentContext;
}

function expectUser(message: unknown): V1UserMessage {
    const m = message as V1UserMessage;
    assert.equal(m.role, 'user');
    return m;
}

function expectAssistant(message: unknown): V1AssistantMessage {
    const m = message as V1AssistantMessage;
    assert.equal(m.role, 'assistant');
    return m;
}

function expectToolResult(message: unknown): V1ToolResultMessage {
    const m = message as V1ToolResultMessage;
    assert.equal(m.role, 'toolResult');
    return m;
}

test('basic chat: provider remap, metadata passthrough, message conversion', async () => {
    const legacy = await loadFixture('basic-chat.mtm');
    assert.deepEqual(detectFormatVersion(legacy), { kind: 'version', version: 0 });

    const { context, warnings } = migrateLegacyContext(legacy);
    parseAgentContext(context); // must pass strict v1 validation

    assert.equal(context.formatVersion, 1);
    assert.equal(context.metadata.provider, 'kimi-coding');
    assert.equal(context.metadata.model, 'kimi-for-coding');
    assert.equal(context.metadata.agentType, 'chat');
    assert.equal(context.metadata.is_task_finished, true);
    assert.ok(warnings.some(w => w.includes('"kimi-for-coding" remapped to "kimi-coding"')));

    assert.equal(context.context.length, 2);
    const user = expectUser(context.context[0]);
    const assistant = expectAssistant(context.context[1]);
    assert.equal(user.content, '你好，介绍一下你自己');
    assert.deepEqual(assistant.content, [{ type: 'text', text: '我是 Mutsumi，一个多 Agent 笔记本环境。' }]);
    assert.equal(assistant.provider, 'kimi-coding');
    assert.equal(assistant.api, 'anthropic-messages');
    assert.equal(assistant.model, 'kimi-for-coding');
});

test('tool round: reasoning → thinking, tool_calls → toolCall blocks, tool → toolResult', async () => {
    const legacy = await loadFixture('tool-round.mtm');
    const { context } = migrateLegacyContext(legacy);
    parseAgentContext(context);

    assert.equal(context.context.length, 4);
    expectUser(context.context[0]);
    const first = expectAssistant(context.context[1]);
    assert.deepEqual(first.content, [
        { type: 'thinking', thinking: '用户想看目录内容，我调用 list_dir。' },
        { type: 'toolCall', id: 'call_1', name: 'list_dir', arguments: { path: '.' } },
    ]);
    const result = expectToolResult(context.context[2]);
    assert.equal(result.toolCallId, 'call_1');
    assert.equal(result.toolName, 'list_dir');
    assert.deepEqual(result.content, [{ type: 'text', text: 'file1.ts\nfile2.ts' }]);
    assert.equal(result.isError, false);
    expectAssistant(context.context[3]);
});

test('system and orphan messages become notes', async () => {
    const legacy = await loadFixture('system-orphans.mtm');
    const { context, warnings } = migrateLegacyContext(legacy);
    parseAgentContext(context);

    assert.equal(context.context.length, 2); // user + assistant only
    const notes = context.notes ?? [];
    assert.equal(notes.length, 2);
    const orphanNote = notes[0]!;
    const systemNote = notes[1]!;
    assert.equal(orphanNote.beforeUserIndex, 0);
    assert.ok(orphanNote.markdown.includes('一段遗留的思考过程'));
    assert.ok(orphanNote.markdown.includes('**Tool Call: read_file**'));
    assert.ok(orphanNote.markdown.includes('```'));
    assert.ok(orphanNote.markdown.includes('orphan file content'));
    assert.ok(orphanNote.markdown.includes('这是文件开头遗留的助手消息'));
    assert.equal(systemNote.beforeUserIndex, 0);
    assert.equal(systemNote.markdown, '**System**: 用户添加的系统说明：回答保持简洁。');
    assert.ok(warnings.some(w => w.includes('flattened into a notebook note')));
});

test('interrupted round: dangling tool calls get synthesized results', async () => {
    const legacy = await loadFixture('interrupted.mtm');
    const { context, warnings } = migrateLegacyContext(legacy);
    parseAgentContext(context);

    assert.equal(context.context.length, 5);
    const synthesized = expectToolResult(context.context[4]);
    assert.equal(synthesized.toolCallId, 'call_b');
    assert.equal(synthesized.toolName, 'run_tests');
    assert.equal(synthesized.isError, true);
    assert.ok(warnings.some(w => w.includes('"run_tests" (call_b)')));
});

test('images, ghost blocks, model-without-provider, unmatched tool result', async () => {
    const legacy = await loadFixture('images-ghost.mtm');
    const { context, warnings } = migrateLegacyContext(legacy);
    parseAgentContext(context);

    // metadata.model without provider must be dropped entirely
    assert.equal(context.metadata.model, undefined);
    assert.equal(context.metadata.provider, undefined);
    assert.ok(warnings.some(w => w.includes('had no provider; dropped')));

    const user1 = expectUser(context.context[0]);
    const assistant1 = expectAssistant(context.context[1]);
    const user2 = expectUser(context.context[2]);
    expectAssistant(context.context[3]);
    assert.deepEqual(user1.content, [
        { type: 'text', text: '看这两张图：' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'text', text: '![image](https://example.com/cat.png)' },
    ]);
    assert.ok(warnings.some(w => w.includes('referenced by URL')));

    assert.deepEqual(user1.mutsumi?.ghostBlock, {
        files: [{ key: 'src/a.ts', version: 1, content: 'console.log(1);' }],
        tools: [],
    });
    // structurally invalid ghost block is dropped
    assert.equal(user2.mutsumi, undefined);
    assert.ok(warnings.some(w => w.includes('structurally invalid ghost block')));

    // unmatched tool result is dropped; four messages remain
    assert.equal(context.context.length, 4);
    assert.ok(warnings.some(w => w.includes('matched no preceding tool call')));
    // no usable session model → 'unknown' with a warning
    assert.equal(assistant1.provider, 'unknown');
    assert.ok(warnings.some(w => w.includes('provider/model "unknown"')));
});

test('consecutive assistants merge; user arriving mid-round synthesizes results', () => {
    const legacy = {
        metadata: {
            uuid: 'u1', name: 'edge', created_at: '2025-01-01T00:00:00Z',
            parent_agent_id: null, allowed_uris: ['/'],
            model: 'm1', provider: 'kimi-for-coding',
        },
        context: [
            { role: 'user', content: '第一问' },
            { role: 'assistant', content: '回答一（第一段）' },
            { role: 'assistant', content: '回答一（补充段）' },
            {
                role: 'user',
                content: '第二问',
            },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'slow_tool', arguments: '{}' } }],
            },
            { role: 'user', content: '算了，别跑了' },
            { role: 'assistant', content: '好的，已取消。' },
        ],
    };
    const { context, warnings } = migrateLegacyContext(legacy);
    parseAgentContext(context);

    const roles = context.context.map(m => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'toolResult', 'user', 'assistant']);
    const merged = expectAssistant(context.context[1]);
    assert.equal(merged.content.length, 2);
    assert.deepEqual(merged.content.map(b => b.type), ['text', 'text']);
    const synthesized = expectToolResult(context.context[4]);
    assert.equal(synthesized.toolCallId, 'call_x');
    assert.equal(synthesized.isError, true);
    assert.ok(warnings.some(w => w.includes('merged')));
    assert.ok(warnings.some(w => w.includes('"slow_tool" (call_x)')));
});

test('assistant with lost results followed by another assistant synthesizes in between', () => {
    const legacy = {
        metadata: {
            uuid: 'u2', name: 'edge2', created_at: '2025-01-01T00:00:00Z',
            parent_agent_id: null, allowed_uris: ['/'],
            model: 'm1', provider: 'p1',
        },
        context: [
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 't1', arguments: '{}' } }],
            },
            // tool result for c1 was lost; next assistant arrives directly
            { role: 'assistant', content: '结果丢了但我继续说。' },
        ],
    };
    const { context, warnings } = migrateLegacyContext(legacy);
    parseAgentContext(context);
    const roles = context.context.map(m => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(expectToolResult(context.context[2]).toolCallId, 'c1');
    assert.ok(warnings.some(w => w.includes('"t1" (c1)')));
});

test('error-tool-result maps to isError=true', () => {
    const legacy = {
        metadata: {
            uuid: 'u3', name: 'edge3', created_at: '2025-01-01T00:00:00Z',
            parent_agent_id: null, allowed_uris: ['/'], model: 'm1', provider: 'p1',
        },
        context: [
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'e1', type: 'function', function: { name: 't1', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'e1', name: 't1', content: 'Error: something went wrong' },
        ],
    };
    const { context } = migrateLegacyContext(legacy);
    const result = expectToolResult(context.context[2]);
    assert.equal(result.isError, true);
});
