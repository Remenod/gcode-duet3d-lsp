// analysis/pathDefinition.ts
//
// Resolves Go-to-Definition (F12) on RRF filesystem paths into a Location
// pointing at the referenced SD-card file.  Registered command arguments are
// handled first.  If that fails, a strict fallback allows navigation from a
// standalone path string used in the “wrong” command/parameter position, but
// only when the string looks path-like and resolves to an existing file.

import * as fs from 'fs';
import { Location, Range } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { Token, TokenType } from '../parser/types';
import {
    getCommandPathArgRule,
    getSdRootForUri,
    getTailPathRule,
    resolveRrfPathToDisk,
    stringLiteralText,
    stringLooksLikeRrfPath,
    extractTailPath,
    PathResolveOptions,
} from './argValidators';
import { functionPathRule } from './pathCompletion';

export function pathLocationAtCursor(
    tokens: Token[],
    character: number,
    uri: string,
    lineText = '',
): Location | null {
    const head = tokens[0];
    const commandName = head && (head.type === TokenType.GCode || head.type === TokenType.TCode)
        ? head.value.toUpperCase()
        : null;

    // 1. Registered command-letter path: M98 P"...", M471 S"...", etc.
    const registered = pathFromRegisteredStringArgument(tokens, character, commandName);
    if (registered) {
        const loc = locationForPath(registered.text, uri, registered.resolve);
        if (loc) return loc;
    }

    // 2. Registered legacy tail path: M36 "file.g", M38 gcodes/file.g, etc.
    if (commandName && lineText) {
        const tailRule = getTailPathRule(commandName);
        const tail = tailRule ? extractTailPath(tokens, lineText) : null;
        if (tail && tail.start <= character && character < tail.end) {
            const loc = locationForPath(tail.text, uri, tailRule?.resolve);
            if (loc) return loc;
        }
    }

    // 3. Path-taking function argument: fileexists("..."), fileread("...", …).
    // Uses the same per-function resolve rules as diagnostics and completion,
    // so e.g. fileexists("probe.g") navigates to sys/probe.g.
    const strIdx = tokens.findIndex(
        t => t.type === TokenType.StringLit && t.start <= character && character < t.end,
    );
    if (strIdx !== -1) {
        const fnRule = functionPathRule(tokens, strIdx);
        const text = fnRule ? stringLiteralText(tokens[strIdx]) : null;
        if (text && text.text.trim() !== '') {
            const loc = locationForPath(text.text, uri, fnRule!.resolve);
            if (loc) return loc;
        }
    }

    // 4. Strict fallback: any string literal that is itself a plausible RRF
    // path.  This covers cases such as M291 P"0:/sys/config.g" or echo
    // "macros/foo.g" without treating normal messages as paths.
    const str = stringAtCursor(tokens, character);
    if (str && stringLooksLikeRrfPath(str.text)) {
        return locationForPath(str.text, uri);
    }

    return null;
}

function pathFromRegisteredStringArgument(
    tokens: Token[],
    character: number,
    commandName: string | null,
): { text: string; resolve?: PathResolveOptions } | null {
    if (!commandName) return null;

    const strIdx = tokens.findIndex(
        t => t.type === TokenType.StringLit && t.start <= character && character < t.end,
    );
    if (strIdx === -1) return null;

    const prev = strIdx > 0 ? tokens[strIdx - 1] : null;
    if (prev?.type !== TokenType.GCodeWord) return null;

    const rule = getCommandPathArgRule(commandName, prev.value);
    if (!rule) return null;

    const text = stringLiteralText(tokens[strIdx]);
    if (!text || text.text.trim() === '') return null;
    return { text: text.text, resolve: rule.resolve };
}

function stringAtCursor(tokens: Token[], character: number): { text: string } | null {
    const tok = tokens.find(
        t => t.type === TokenType.StringLit && t.start <= character && character < t.end,
    );
    if (!tok) return null;
    const text = stringLiteralText(tok);
    return text ? { text: text.text } : null;
}

function locationForPath(rrfPath: string, uri: string, resolve?: PathResolveOptions): Location | null {
    const sdRoot = getSdRootForUri(uri);
    if (!sdRoot) return null;

    const abs = resolveRrfPathToDisk(rrfPath, sdRoot, resolve);
    if (!abs) return null;

    try {
        if (!fs.existsSync(abs)) return null;
    } catch {
        return null;
    }

    return Location.create(URI.file(abs).toString(), Range.create(0, 0, 0, 0));
}
