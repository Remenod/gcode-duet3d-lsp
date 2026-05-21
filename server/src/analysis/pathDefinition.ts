// analysis/pathDefinition.ts
//
// Resolves Go-to-Definition (F12) on a string-literal argument of a G-code
// command into a Location pointing at the referenced SD-card file.
//
// Returns null when the cursor is not on such a string, when the command is
// not in the file-path registry, or when the file does not exist on disk.
// The latter is consistent with LSP convention — F12 has no destination so
// the client simply leaves the cursor where it is.

import * as fs from 'fs';
import { Location, Range } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { Token, TokenType } from '../parser/types';
import { COMMAND_ARG_RULES, getSdRootForUri, resolveRrfPathToDisk } from './argValidators';

/**
 * @param tokens     Tokens of the current line.
 * @param character  0-based column the cursor sits in.
 * @param uri        Document URI (needed to locate the SD root).
 *
 * The matching algorithm:
 *   1. Find the StringLit the cursor is inside.
 *   2. The previous token must be a GCodeWord.
 *   3. The line must start with a G/M/T code that has a path validator
 *      registered for the GCodeWord letter — only then do we treat the
 *      string as a path.  Validating by registry membership keeps the
 *      go-to-definition behaviour consistent with the warning produced by
 *      `filePathValidator`.
 */
export function pathLocationAtCursor(
    tokens: Token[],
    character: number,
    uri: string,
): Location | null {
    // 1. cursor inside a StringLit
    const strIdx = tokens.findIndex(
        t => t.type === TokenType.StringLit && t.start <= character && character < t.end,
    );
    if (strIdx === -1) return null;

    // 2. previous token must be a GCodeWord
    const prev = strIdx > 0 ? tokens[strIdx - 1] : null;
    if (prev?.type !== TokenType.GCodeWord) return null;

    // 3. the command on this line must have a path rule for that letter
    const head = tokens[0];
    if (!head || (head.type !== TokenType.GCode && head.type !== TokenType.TCode)) return null;
    const rules = COMMAND_ARG_RULES.get(head.value.toUpperCase());
    if (!rules || !rules.has(prev.value.toUpperCase())) return null;

    // Extract the path text (strip quotes; collapse "" → ")
    const strTok = tokens[strIdx];
    const raw = strTok.value;
    if (raw.length < 2) return null;
    const inner = raw
        .slice(1, raw.endsWith('"') ? raw.length - 1 : raw.length)
        .replace(/""/g, '"');
    if (inner.trim() === '') return null;

    const sdRoot = getSdRootForUri(uri);
    if (!sdRoot) return null;

    const abs = resolveRrfPathToDisk(inner, sdRoot);
    if (!abs || !fs.existsSync(abs)) return null;

    return Location.create(URI.file(abs).toString(), Range.create(0, 0, 0, 0));
}
