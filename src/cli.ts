#!/usr/bin/env node
/**
 * sakiido — migrate Mutsumi .mtm session files to the latest on-disk format.
 *
 * Usage:
 *   sakiido <file-or-dir>... [options]
 *
 * Options:
 *   --dry-run       Report what would happen without writing anything.
 *   --out <dir>     Write migrated files under <dir> (mirroring the input
 *                   layout) instead of migrating in place.
 *   --no-backup     Skip creating "<name>.v<N>.bak" backups for in-place
 *                   migrations (ignored with --out).
 *   -h, --help      Show this help.
 *
 * Exit code 0 when every input file was migrated or safely skipped,
 * 1 when any file failed or the arguments were invalid.
 *
 * This file is version-agnostic: which formats are supported is decided
 * entirely by the step registry (src/core/registry.ts).
 */

import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { migrateDocumentToLatest, type PipelineOutcome } from './core/pipeline.ts';
import { LATEST_FORMAT_VERSION } from './core/registry.ts';

interface Options {
    dryRun: boolean;
    out?: string;
    backup: boolean;
}

interface FileOutcome {
    path: string;
    status: 'migrated' | 'skipped' | 'failed';
    detail?: string;
    warnings: string[];
    output?: string;
}

const HELP = [
    'sakiido — migrate Mutsumi .mtm session files to the latest on-disk format',
    `(this build migrates up to format v${LATEST_FORMAT_VERSION})`,
    '',
    'Usage: sakiido <file-or-dir>... [options]',
    '',
    'Options:',
    '  --dry-run        Report what would happen without writing anything.',
    '  --out <dir>      Write migrated files under <dir> instead of in place.',
    '  --no-backup      Skip the "<name>.v<N>.bak" copy for in-place migration.',
    '  -h, --help       Show this help.',
].join('\n');

type ParsedArgs = { paths: string[]; options: Options } | { error: string; code: 0 | 1 };

function parseArgs(argv: string[]): ParsedArgs {
    const paths: string[] = [];
    const options: Options = { dryRun: false, backup: true };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '-h' || arg === '--help') {
            return { error: HELP, code: 0 };
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--no-backup') {
            options.backup = false;
        } else if (arg === '--out') {
            const value = argv[i + 1];
            if (!value) return { error: '--out requires a directory argument', code: 1 };
            options.out = value;
            i++;
        } else if (arg.startsWith('--')) {
            return { error: `Unknown option: ${arg}\n\n${HELP}`, code: 1 };
        } else {
            paths.push(arg);
        }
    }
    if (paths.length === 0) {
        return { error: 'No input files or directories given.\n\n' + HELP, code: 1 };
    }
    return { paths, options };
}

async function collectMtmFiles(input: string): Promise<string[]> {
    const inputStat = await stat(input).catch(() => null);
    if (inputStat === null) throw new Error('file not found');
    if (!inputStat.isDirectory()) return [input];

    const result: string[] = [];
    const visit = async (dir: string): Promise<void> => {
        const entries = await readdir(dir).catch(() => null);
        if (entries === null) return;
        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '.git') continue;
            const full = join(dir, entry);
            const childStat = await stat(full).catch(() => null);
            if (childStat?.isDirectory()) {
                await visit(full);
            } else if (entry.endsWith('.mtm')) {
                result.push(full);
            }
        }
    };
    await visit(input);
    result.sort();
    return result;
}

async function migrateFile(path: string, inputRoot: string, options: Options): Promise<FileOutcome> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        return failed(path, `unreadable: ${String(error)}`);
    }

    let root: unknown;
    try {
        root = JSON.parse(text);
    } catch (error) {
        return failed(path, `invalid JSON: ${String(error)}`);
    }

    const outcome = migrateDocumentToLatest(root);

    if (outcome.status === 'up-to-date') {
        if (!options.dryRun && options.out) {
            // Copy already-current files so --out yields a complete, usable tree.
            const target = outputPath(options.out, inputRoot, path);
            await mkdir(join(target, '..'), { recursive: true });
            await writeFile(target, text, 'utf8');
        }
        return { path, status: 'skipped', detail: `already format v${outcome.version}`, warnings: [] };
    }
    if (outcome.status === 'too-new') {
        return failed(path, `formatVersion ${String(outcome.version)} is newer than the latest format this tool knows (v${LATEST_FORMAT_VERSION}); update sakiido`);
    }
    if (outcome.status === 'failed') {
        return failed(path, outcome.detail);
    }

    let result: FileOutcome = { path, status: 'migrated', warnings: outcome.warnings, output: outcome.output };

    if (options.dryRun) {
        return result;
    }

    if (options.out) {
        const target = outputPath(options.out, inputRoot, path);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, outcome.output + '\n', 'utf8');
        result.detail = `written to ${target}`;
    } else {
        if (options.backup) {
            const backup = `${path}.v${outcome.fromVersion}.bak`;
            await writeFile(backup, text, 'utf8');
            result.detail = `original kept at ${backup}`;
        }
        await writeFile(path, outcome.output + '\n', 'utf8');
    }
    return result;
}

function outputPath(out: string, inputRoot: string, path: string): string {
    const relPath = relative(inputRoot, path);
    return isAbsolute(out) ? join(out, relPath) : resolve(process.cwd(), out, relPath);
}

function failed(path: string, detail: string): FileOutcome {
    return { path, status: 'failed', detail, warnings: [] };
}

async function main(argv: string[]): Promise<number> {
    const parsed = parseArgs(argv);
    if ('error' in parsed) {
        (parsed.code === 0 ? process.stdout : process.stderr).write(parsed.error + '\n');
        return parsed.code;
    }

    let failures = 0;
    const summary = { migrated: 0, skipped: 0, failed: 0 };

    for (const input of parsed.paths) {
        const inputStat = await stat(input).catch(() => null);
        if (inputStat === null) {
            process.stderr.write(`${input}: file not found\n`);
            failures++;
            continue;
        }
        const inputRoot = inputStat.isDirectory() ? resolve(input) : resolve(join(input, '..'));

        let files: string[];
        try {
            files = await collectMtmFiles(input);
        } catch (error) {
            process.stderr.write(`${input}: ${String(error)}\n`);
            failures++;
            continue;
        }
        if (files.length === 0) {
            process.stderr.write(`${input}: no .mtm files found\n`);
            continue;
        }

        for (const file of files) {
            const outcome = await migrateFile(file, inputRoot, parsed.options);
            report(outcome);
            if (outcome.status === 'failed') {
                summary.failed++;
                failures++;
            } else if (outcome.status === 'migrated') {
                summary.migrated++;
            } else {
                summary.skipped++;
            }
        }
    }

    process.stdout.write(`\n${summary.migrated} migrated, ${summary.skipped} skipped, ${summary.failed} failed.\n`);
    return failures > 0 ? 1 : 0;
}

function report(outcome: FileOutcome): void {
    const label = outcome.status === 'migrated' ? 'MIGRATED' : outcome.status === 'skipped' ? 'SKIPPED' : 'FAILED ';
    process.stdout.write(`${label}  ${outcome.path}${outcome.detail ? ` — ${outcome.detail}` : ''}\n`);
    for (const warning of outcome.warnings) {
        process.stdout.write(`         ⚠ ${warning}\n`);
    }
}

main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}, error => {
    process.stderr.write(`sakiido: unexpected failure: ${String(error)}\n`);
    process.exitCode = 1;
});
