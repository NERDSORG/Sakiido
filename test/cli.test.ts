import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseAgentContext } from '../src/formats/v1.ts';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(projectRoot, 'src', 'cli.ts');
const fixtures = join(projectRoot, 'test', 'fixtures');

async function runCli(args: string[]) {
    return execFileAsync(process.execPath, [cli, ...args], { cwd: projectRoot });
}

async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sakiido-'));
    await cp(fixtures, join(dir, 'sessions'), { recursive: true });
    return dir;
}

test('in-place migration writes latest-format files, keeps backups, skips current files', async () => {
    const dir = await makeWorkspace();
    const sessions = join(dir, 'sessions');
    const { stdout } = await runCli([sessions]);

    assert.match(stdout, /MIGRATED/);
    assert.match(stdout, /SKIPPED .*already-v1/);
    assert.match(stdout, /5 migrated, 1 skipped, 0 failed/);

    const migrated = JSON.parse(await readFile(join(sessions, 'v0', 'tool-round.mtm'), 'utf8'));
    parseAgentContext(migrated); // must pass strict v1 validation
    assert.equal(migrated.metadata.provider, 'kimi-coding');

    const backup = JSON.parse(await readFile(join(sessions, 'v0', 'tool-round.mtm.v0.bak'), 'utf8'));
    assert.equal(backup.metadata.provider, 'kimi-for-coding');

    const v1 = JSON.parse(await readFile(join(sessions, 'v1', 'already-v1.mtm'), 'utf8'));
    assert.equal(v1.formatVersion, 1);
    const entries = await readdir(join(sessions, 'v0'));
    assert.equal(entries.filter(name => name.endsWith('.v0.bak')).length, 5);
    // already-current files must not get a backup
    const v1Entries = await readdir(join(sessions, 'v1'));
    assert.equal(v1Entries.some(name => name.endsWith('.bak')), false);
});

test('--dry-run writes nothing', async () => {
    const dir = await makeWorkspace();
    const sessions = join(dir, 'sessions');
    const before = await readFile(join(sessions, 'v0', 'basic-chat.mtm'), 'utf8');
    const { stdout } = await runCli([sessions, '--dry-run']);

    assert.match(stdout, /MIGRATED/);
    const after = await readFile(join(sessions, 'v0', 'basic-chat.mtm'), 'utf8');
    assert.equal(after, before);
    const entries = await readdir(join(sessions, 'v0'));
    assert.equal(entries.some(name => name.endsWith('.bak')), false);
});

test('--out mirrors the input tree and leaves originals untouched', async () => {
    const dir = await makeWorkspace();
    const sessions = join(dir, 'sessions');
    const out = join(dir, 'migrated');
    await runCli([sessions, '--out', out]);

    const migrated = JSON.parse(await readFile(join(out, 'v0', 'tool-round.mtm'), 'utf8'));
    parseAgentContext(migrated);
    const original = JSON.parse(await readFile(join(sessions, 'v0', 'tool-round.mtm'), 'utf8'));
    assert.equal(original.metadata.provider, 'kimi-for-coding');
    const outEntries = await readdir(join(out, 'v1'));
    assert.equal(outEntries.includes('already-v1.mtm'), true);
});

test('--no-backup skips backup creation', async () => {
    const dir = await makeWorkspace();
    const sessions = join(dir, 'sessions');
    await runCli([sessions, '--no-backup']);
    const entries = await readdir(join(sessions, 'v0'));
    assert.equal(entries.some(name => name.endsWith('.bak')), false);
    parseAgentContext(JSON.parse(await readFile(join(sessions, 'v0', 'basic-chat.mtm'), 'utf8')));
});

test('broken JSON fails with exit code 1 and keeps the file', async () => {
    const dir = await makeWorkspace();
    const sessions = join(dir, 'sessions');
    await writeFile(join(sessions, 'v0', 'broken.mtm'), '{ "metadata": ', 'utf8');
    await assert.rejects(
        () => runCli([sessions]),
        (error: Error & { code?: number; stdout?: string }) => {
            assert.equal(error.code, 1);
            assert.match(error.stdout ?? '', /FAILED .*broken\.mtm/);
            return true;
        },
    );
    assert.equal(await readFile(join(sessions, 'v0', 'broken.mtm'), 'utf8'), '{ "metadata": ');
});

test('nested directories are scanned recursively', async () => {
    const dir = await makeWorkspace();
    const nested = join(dir, 'sessions', 'sub', 'deep');
    await mkdir(nested, { recursive: true });
    await cp(join(fixtures, 'v0', 'basic-chat.mtm'), join(nested, 'nested-agent.mtm'));
    const { stdout } = await runCli([dir]);
    assert.match(stdout, /nested-agent\.mtm/);
    parseAgentContext(JSON.parse(await readFile(join(nested, 'nested-agent.mtm'), 'utf8')));
});

test('--help exits 0 with usage text', async () => {
    const { stdout } = await runCli(['--help']);
    assert.match(stdout, /Usage: sakiido/);
});
