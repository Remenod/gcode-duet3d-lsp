// analysis/codeActions.ts
//
// Code-action provider for the path-not-found diagnostic.
//
// Two quick fixes are offered:
//   1. Ignore this file        — adds `<sd-relative path>` to settings
//   2. Ignore parent directory — adds `<sd-relative dir>/**` to settings
//
// Both produce a `command` that the LSP client executes; the command updates
// the user's `rrfgcode.argCheck.paths.ignore` setting through
// `workspace/configuration` + `workspace/applyEdit`.  Stored values are
// always SD-root-relative so the project remains portable when moved between
// machines.

import {
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    Command,
    Diagnostic,
} from 'vscode-languageserver/node';
import * as path from 'path';
import { PATH_NOT_FOUND_CODE } from './argValidators';
import { makeIgnorePatternForDir, makeIgnorePatternForFile } from './argCheckConfig';

/** Command ID the client must implement / forward to executeCommand. */
export const CMD_ADD_PATH_IGNORE = 'rrfgcode.addPathIgnore';

/** Command ID for changing the `rrfgcode.maxLineLength` setting. */
export const CMD_SET_MAX_LINE_LENGTH = 'rrfgcode.setMaxLineLength';

/** Diagnostic code used by the line-length checker (see server.ts). */
export const LINE_TOO_LONG_CODE = 'rrf-line-too-long';

/**
 * Payload shape attached to the diagnostic by `filePathValidator`.
 * Mirrored here so consumers don't have to import argValidators.
 */
interface PathDiagData {
    relative: string;
    absolute: string;
    sdRoot: string;
}

/** Returns the typed `data` payload for our path diagnostic, or null. */
function readPathData(d: Diagnostic): PathDiagData | null {
    if (d.code !== PATH_NOT_FOUND_CODE) return null;
    const data = (d as any).data;
    if (!data || typeof data !== 'object') return null;
    if (typeof data.relative !== 'string' || typeof data.absolute !== 'string'
        || typeof data.sdRoot !== 'string') return null;
    return data as PathDiagData;
}

/**
 * Payload shape attached to the line-too-long diagnostic by the server.
 */
interface LineLengthDiagData {
    length: number;
    max: number;
}

/** Returns the typed `data` payload for our line-length diagnostic, or null. */
function readLineLengthData(d: Diagnostic): LineLengthDiagData | null {
    if (d.code !== LINE_TOO_LONG_CODE) return null;
    const data = (d as any).data;
    if (!data || typeof data !== 'object') return null;
    if (typeof data.length !== 'number' || typeof data.max !== 'number') return null;
    return data as LineLengthDiagData;
}

/**
 * Build code actions for any matching diagnostics in `params.context`.
 * The LSP server passes `params` through unchanged.
 */
export function buildCodeActions(params: CodeActionParams): CodeAction[] {
    const actions: CodeAction[] = [];

    for (const diag of params.context.diagnostics) {
        const pathData = readPathData(diag);
        if (pathData) {
            actions.push(...pathIgnoreActions(diag, pathData));
            continue;
        }

        const lenData = readLineLengthData(diag);
        if (lenData) {
            actions.push(...lineLengthActions(diag, lenData));
            continue;
        }
    }

    return actions;
}

function pathIgnoreActions(diag: Diagnostic, data: PathDiagData): CodeAction[] {
    const actions: CodeAction[] = [];

    const filePattern = makeIgnorePatternForFile(data.absolute, data.sdRoot);
    const dirPattern = makeIgnorePatternForDir(path.dirname(data.absolute), data.sdRoot);

    actions.push(makeCommandQuickFix(
        `Ignore '${data.relative}' (don't warn about missing path)`,
        CMD_ADD_PATH_IGNORE,
        [filePattern],
        diag,
    ));

    // Don't offer the directory action if it would collapse to "**"
    // (i.e. the file is at the SD root) — that would silence every
    // missing-path warning, which is almost never what the user wants.
    if (dirPattern !== '**') {
        actions.push(makeCommandQuickFix(
            `Ignore directory '${dirPattern}'`,
            CMD_ADD_PATH_IGNORE,
            [dirPattern],
            diag,
            /*preferred*/ false,
        ));
    }

    return actions;
}

function lineLengthActions(diag: Diagnostic, data: LineLengthDiagData): CodeAction[] {
    return [
        makeCommandQuickFix(
            `Increase max line length to ${data.length}`,
            CMD_SET_MAX_LINE_LENGTH,
            [data.length],
            diag,
        ),
        makeCommandQuickFix(
            `Disable line-length check (set max line length to 0)`,
            CMD_SET_MAX_LINE_LENGTH,
            [0],
            diag,
            /*preferred*/ false,
        ),
    ];
}

function makeCommandQuickFix(
    title: string,
    command: string,
    args: unknown[],
    diag: Diagnostic,
    preferred: boolean = true,
): CodeAction {
    const cmd: Command = {
        title,
        command,
        arguments: args,
    };
    return {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        isPreferred: preferred,
        command: cmd,
    };
}
