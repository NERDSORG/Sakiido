import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { detectFormatVersion } from '../../src/core/detect.ts';
import { migrateDocumentToLatest } from '../../src/core/pipeline.ts';
import { LATEST_FORMAT_VERSION, STEPS } from '../../src/core/registry.ts';
import { parseAgentContext } from '../../src/formats/v1.ts';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

test('registry is a contiguous chain from v0 to the latest format', () => {
    assert.ok(STEPS.length > 0);
    assert.equal(STEPS[0]!.from, 0);
    for (let i = 1; i < STEPS.length; i++) {
        assert.equal(STEPS[i]!.from, STEPS[i - 1]!.to, `gap before step #${i}`);
    }
    assert.equal(STEPS[STEPS.length - 1]!.to, LATEST_FORMAT_VERSION);
});

test('every v0 fixture migrates through the full chain and validates', async () => {
    const files = (await readdir(join(fixturesRoot, 'v0'))).filter(name => name.endsWith('.mtm'));
    assert.ok(files.length > 0);
    for (const name of files) {
        const root = JSON.parse(await readFile(join(fixturesRoot, 'v0', name), 'utf8'));
        const outcome = migrateDocumentToLatest(root);
        assert.equal(outcome.status, 'migrated', name);
        if (outcome.status !== 'migrated') continue;
        assert.equal(outcome.fromVersion, 0, name);
        assert.equal(outcome.toVersion, LATEST_FORMAT_VERSION, name);
        parseAgentContext(JSON.parse(outcome.output)); // serialized output must validate
    }
});

test('latest-format fixture is detected and reported up-to-date', async () => {
    const root = JSON.parse(await readFile(join(fixturesRoot, 'v1', 'already-v1.mtm'), 'utf8'));
    assert.deepEqual(detectFormatVersion(root), { kind: 'version', version: LATEST_FORMAT_VERSION });
    assert.deepEqual(migrateDocumentToLatest(root), { status: 'up-to-date', version: LATEST_FORMAT_VERSION });
});

test('a latest-format document that fails validation fails with a clear detail', async () => {
    const root = JSON.parse(await readFile(join(fixturesRoot, 'v1', 'already-v1.mtm'), 'utf8'));
    root.context = 'not an array';
    const outcome = migrateDocumentToLatest(root);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
        assert.match(outcome.detail, /already format v1 but fails validation/);
    }
});

test('a format newer than this tool is reported as too-new', () => {
    const outcome = migrateDocumentToLatest({ formatVersion: LATEST_FORMAT_VERSION + 1 });
    assert.deepEqual(outcome, { status: 'too-new', version: LATEST_FORMAT_VERSION + 1 });
});

test('unrecognized documents fail detection and the pipeline', () => {
    assert.equal(detectFormatVersion('not an object').kind, 'unrecognized');
    assert.equal(detectFormatVersion({ nope: true }).kind, 'unrecognized');
    assert.equal(detectFormatVersion({ formatVersion: 'one' }).kind, 'unrecognized');
    const outcome = migrateDocumentToLatest({ nope: true });
    assert.equal(outcome.status, 'failed');
});
