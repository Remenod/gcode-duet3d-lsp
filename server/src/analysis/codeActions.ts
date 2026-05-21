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
 * Build code actions for any matching diagnostics in `params.context`.
 * The LSP server passes `params` through unchanged.
 */
export function buildCodeActions(params: CodeActionParams): CodeAction[] {
    const actions: CodeAction[] = [];

    for (const diag of params.context.diagnostics) {
        const data = readPathData(diag);
        if (!data) continue;

        const filePattern = makeIgnorePatternForFile(data.absolute, data.sdRoot);
        const dirPattern = makeIgnorePatternForDir(path.dirname(data.absolute), data.sdRoot);

        actions.push(makeQuickFix(
            `Ignore '${data.relative}' (don't warn about missing path)`,
            filePattern,
            diag,
        ));

        // Don't offer the directory action if it would collapse to "**"
        // (i.e. the file is at the SD root) — that would silence every
        // missing-path warning, which is almost never what the user wants.
        if (dirPattern !== '**') {
            actions.push(makeQuickFix(
                `Ignore directory '${dirPattern}'`,
                dirPattern,
                diag,
                /*preferred*/ false,
            ));
        }
    }

    return actions;
}

function makeQuickFix(
    title: string,
    pattern: string,
    diag: Diagnostic,
    preferred: boolean = true,
): CodeAction {
    const cmd: Command = {
        title,
        command: CMD_ADD_PATH_IGNORE,
        arguments: [pattern],
    };
    return {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        isPreferred: preferred,
        command: cmd,
    };
}
