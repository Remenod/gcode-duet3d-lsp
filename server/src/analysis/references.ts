// Implements "Find All References" (textDocument/references, triggered by Shift+F12).
//
// • var / param  → occurrences in the current file only.
// • global       → occurrences across all known files.

import { ReferenceParams, Location } from 'vscode-languageserver/node';
import { Lexer } from '../parser/lexer';
import { findTokenAtChar, resolveVariableToken } from './utils';
import {
    findOccurrencesInDoc, filterVarOccurrencesByScope, occurrencesToLocations,
} from './occurrences';

/**
 * @param params       Standard LSP ReferenceParams.
 * @param currentText  Text of the active document.
 * @param currentUri   URI of the active document.
 * @param allDocs      All documents known to the server (uri → text).
 */
export function buildReferences(
    params: ReferenceParams,
    currentText: string,
    currentUri: string,
    allDocs: Map<string, string>,
): Location[] {
    // ── 1. Identify the symbol under the cursor ────────────────────────────────
    const lines = currentText.split(/\r?\n/);
    const lineText = lines[params.position.line] ?? '';
    const tokens = new Lexer(lineText, params.position.line).tokenize();

    const found = findTokenAtChar(tokens, params.position.character);
    if (!found) return [];

    const resolved = resolveVariableToken(tokens, found.idx);
    if (!resolved) return [];

    const { scope, baseName } = resolved;

    // ── 2. Decide which files to search ───────────────────────────────────────
    const docsToSearch: Map<string, string> =
        scope === 'global'
            ? allDocs
            : new Map([[currentUri, currentText]]);

    // ── 3. Collect locations ───────────────────────────────────────────────────
    const locations: Location[] = [];

    for (const [uri, text] of docsToSearch) {
        let spans = findOccurrencesInDoc(text, scope, baseName);
        // Same-named vars in sibling blocks are different variables — list
        // only occurrences of the one under the cursor.
        if (scope === 'var') {
            spans = filterVarOccurrencesByScope(
                spans, text, params.position.line, params.position.character,
            );
        }

        // LSP spec: includeDeclaration controls whether the declaration site is returned.
        const filtered = params.context.includeDeclaration
            ? spans
            : spans.filter(s => !s.isDeclaration);

        locations.push(...occurrencesToLocations(filtered, uri));
    }

    return locations;
}
