// analysis/rename.ts
// Builds a WorkspaceEdit for renaming a var / global symbol.
//
// • var    → edits in the current file only (file-scoped).
// • global → edits across ALL known files (workspace-scoped).
//
// param variables CANNOT be renamed: their names are G-code parameter letters
// (A–Z) determined by the macro call site (e.g. `M98 P"macro.g" Z10`),
// not by anything written inside the macro itself.

import { RenameParams, WorkspaceEdit, TextEdit } from 'vscode-languageserver/node';
import { Lexer } from '../parser/lexer';
import { findTokenAtChar, resolveVariableToken } from './utils';
import { findOccurrencesInDoc, filterVarOccurrencesByScope } from './occurrences';

/**
 * @param params       Standard LSP RenameParams (position + newName).
 * @param currentText  Text of the document that triggered the rename.
 * @param currentUri   URI of that document.
 * @param allDocs      All documents known to the server (uri → text).
 *                     Only consulted for global renames; ignored for var.
 */
export function buildRenameEdit(
    params: RenameParams,
    currentText: string,
    currentUri: string,
    allDocs: Map<string, string>,
): WorkspaceEdit | null {
    // ── 1. Identify the symbol under the cursor ────────────────────────────────
    const lines = currentText.split(/\r?\n/);
    const lineText = lines[params.position.line] ?? '';
    const tokens = new Lexer(lineText, params.position.line).tokenize();

    const found = findTokenAtChar(tokens, params.position.character);
    if (!found) return null;

    const resolved = resolveVariableToken(tokens, found.idx);
    if (!resolved) return null;

    const { scope, baseName } = resolved;

    // param variables are NOT renameable — their letter is set at the call site.
    // This is also enforced by onPrepareRename in server.ts, but guard here too
    // so buildRenameEdit is safe to call in isolation.
    if (scope === 'param') return null;

    // Strip any accidental scope prefix the user may have typed in the new-name box.
    const newBaseName = params.newName.replace(/^(var|global)\./, '').trim();
    if (!newBaseName) return null;

    // ── 2. Decide which files to search ───────────────────────────────────────
    //  global → workspace-wide (all indexed files)
    //  var    → current file only (lexically scoped)
    const docsToSearch: Map<string, string> =
        scope === 'global'
            ? allDocs
            : new Map([[currentUri, currentText]]);

    // ── 3. Collect edits ───────────────────────────────────────────────────────
    const changes: Record<string, TextEdit[]> = {};

    for (const [uri, text] of docsToSearch) {
        let spans = findOccurrencesInDoc(text, scope, baseName);
        // Same-named vars in sibling blocks are different variables — rename
        // only the one the cursor is on.
        if (scope === 'var') {
            spans = filterVarOccurrencesByScope(
                spans, text, params.position.line, params.position.character,
            );
        }
        if (spans.length === 0) continue;

        changes[uri] = spans.map(s =>
            TextEdit.replace(
                {
                    start: { line: s.line, character: s.start },
                    end: { line: s.line, character: s.end },
                },
                // Declaration token holds only the bare name; usage token is qualified.
                s.isDeclaration ? newBaseName : `${scope}.${newBaseName}`,
            ),
        );
    }

    if (Object.keys(changes).length === 0) return null;
    return { changes };
}
