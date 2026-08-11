// Finds every span in a document where a scoped variable is referenced or declared.
// Used by both rename (to build TextEdits) and references (to build Locations).

import { Location, Range } from 'vscode-languageserver/node';
import { Lexer } from '../parser/lexer';
import { TokenType } from '../parser/types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OccurrenceSpan {
    line: number;
    start: number;
    end: number;
    /**
     * True  → bare name in a keyword line:
     *   • `var foo = …` / `global foo = …`  — actual declarations
     *   • `param Z = …` / `param Z`         — default-value setter (NOT a true
     *     declaration; the value comes from the M98 call site)
     * False → qualified usage: `var.foo`, `global.foo`, `param.Z`
     *
     * Used by:
     *   • rename   — to know which token form to rewrite (bare name vs qualified)
     *   • references — to honour the LSP `includeDeclaration` flag
     */
    isDeclaration: boolean;
}

// ── Core ───────────────────────────────────────────────────────────────────────

/**
 * Return every occurrence of `scope.baseName` in `docText`.
 *
 * Two token forms are matched:
 *   1. Qualified identifier:  `var.foo` / `global.foo` / `param.Z`
 *   2. Keyword form:          `var foo = …` / `global foo = …` / `param Z [= …]`
 *      For `param`, this is the default-value setter line, not a true declaration.
 */
export function findOccurrencesInDoc(
    docText: string,
    scope: string,
    baseName: string,
): OccurrenceSpan[] {
    const results: OccurrenceSpan[] = [];
    const qualifiedName = `${scope}.${baseName}`;
    const lines = docText.split(/\r?\n/);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const lineTokens = new Lexer(lines[lineIdx], lineIdx).tokenize();

        for (let j = 0; j < lineTokens.length; j++) {
            const t = lineTokens[j];
            if (t.type !== TokenType.Identifier) continue;

            if (t.value === qualifiedName) {
                // Qualified usage: `var.foo`
                results.push({ line: lineIdx, start: t.start, end: t.end, isDeclaration: false });
            } else if (t.value === baseName) {
                // Declaration form: keyword immediately before bare name
                const prev = j > 0 ? lineTokens[j - 1] : null;
                if (
                    prev &&
                    prev.value.toLowerCase() === scope &&
                    (prev.type === TokenType.Var ||
                        prev.type === TokenType.Global)
                ) {
                    results.push({ line: lineIdx, start: t.start, end: t.end, isDeclaration: true });
                }
            }
        }
    }

    return results;
}

// ── Scope-aware filtering for `var` symbols ────────────────────────────────────
//
// Two `var foo` declarations in sibling blocks are DIFFERENT variables (each
// dies at its block's end), so rename/references must not lump them together.
// Every usage is resolved to its declaration with the same indentation rules
// the symbol table uses (deepest still-open declaration at or above the usage
// line), and only the group containing the cursor's symbol is kept.

/**
 * Restrict `spans` (all occurrences of one var name in a document) to the
 * single variable the cursor position refers to.
 */
export function filterVarOccurrencesByScope(
    spans: OccurrenceSpan[],
    docText: string,
    cursorLine: number,
    cursorCharacter: number,
): OccurrenceSpan[] {
    const lines = docText.split(/\r?\n/);
    const indentOf = (l: number): number => {
        const text = lines[l] ?? '';
        let i = 0;
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
        return i;
    };

    const decls = spans.filter(s => s.isDeclaration);

    // True while no line between declLine and refLine closes the decl's block.
    const blockStillOpen = (declLine: number, declIndent: number, refLine: number): boolean => {
        for (let k = declLine + 1; k < refLine; k++) {
            const raw = lines[k] ?? '';
            const trimmed = raw.trimStart();
            if (trimmed === '' || trimmed.startsWith(';')) continue;
            if (indentOf(k) < declIndent) return false;
        }
        return true;
    };

    const resolveDecl = (s: OccurrenceSpan): OccurrenceSpan | undefined => {
        if (s.isDeclaration) return s;
        const refIndent = indentOf(s.line);
        let best: OccurrenceSpan | undefined;
        let bestIndent = -1;
        for (const d of decls) {
            if (d.line > s.line) continue;
            const dIndent = indentOf(d.line);
            if (dIndent > refIndent) continue;
            if (!blockStillOpen(d.line, dIndent, s.line)) continue;
            if (!best || dIndent > bestIndent || (dIndent === bestIndent && d.line > best.line)) {
                best = d;
                bestIndent = dIndent;
            }
        }
        return best;
    };

    const cursorSpan = spans.find(
        s => s.line === cursorLine && s.start <= cursorCharacter && cursorCharacter <= s.end,
    );
    if (!cursorSpan) return spans;

    const target = resolveDecl(cursorSpan);
    return spans.filter(s => resolveDecl(s) === target);
}

// ── Conversion helpers ─────────────────────────────────────────────────────────

/** Convert OccurrenceSpans to LSP Location objects. */
export function occurrencesToLocations(spans: OccurrenceSpan[], uri: string): Location[] {
    return spans.map(s =>
        Location.create(uri, Range.create(s.line, s.start, s.line, s.end)),
    );
}
