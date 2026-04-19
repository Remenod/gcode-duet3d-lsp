// analysis/hover.ts

import { Hover, MarkupKind } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';
import { SymbolTable } from './symbolTable';
import { isValidOmPath, getOmPathInfo, isOmIndexAvailable, allOmPaths } from './objectModelIndex';

interface GCodeDoc { title: string; description: string; anchor: string }
type DocDB = Record<string, GCodeDoc>;

export function buildHover(
    tokens: Token[],
    character: number,
    lineNum: number,
    gcodeData: DocDB,
    metaData: DocDB,
    operatorsData: DocDB,
    functionsData: DocDB,
    symbolTable: SymbolTable,
    uri: string,
    lineIndent: number = 0,
): Hover | null {
    const tokIdx = tokens.findIndex(t => t.start <= character && character < t.end);
    if (tokIdx === -1) return null;
    const tok = tokens[tokIdx];

    switch (tok.type) {
        // ── G / M codes ───────────────────────────────────────────────────────
        case TokenType.GCode: {
            const data = gcodeData[tok.value.toUpperCase()];
            if (!data) return mkHover(`**${tok.value}**\n\n*No documentation found.*`);
            const anchor = data.anchor
                ? `\n\n[Documentation](https://docs.duet3d.com/en/User_manual/Reference/Gcodes#${data.anchor})`
                : '';
            return mkHover(`**${tok.value}** — ${data.title}\n\n${data.description}${anchor}`);
        }

        case TokenType.TCode: {
            const n = tok.value.slice(1);
            return mkHover(`**${tok.value}** — Select tool${n ? ` ${n}` : ''}`);
        }

        case TokenType.FunctionName: {
            // Could be a function call OR a field name after [n]. (e.g. "max" in axes[0].max).
            // Check if it is preceded by a Dot to disambiguate.
            if (tokIdx > 0 && tokens[tokIdx - 1]?.type === TokenType.Dot) {
                // Treat as an OM field — reconstruct path
                const fullPath = reconstructOmPath(tokens, tokIdx);
                return buildOmHover(fullPath);
            }
            const data = functionsData[tok.value.toLowerCase()];
            if (!data) return mkHover(`**${tok.value}()**\n\n*No documentation found.*`);
            return mkHover(`**${tok.value}** — ${data.title}\n\n${data.description}`);
        }

        // ── Meta keywords ─────────────────────────────────────────────────────────
        case TokenType.If:
        case TokenType.Elif:
        case TokenType.Else:
        case TokenType.While:
        case TokenType.Break:
        case TokenType.Continue:
        case TokenType.Abort:
        case TokenType.Var:
        case TokenType.Global:
        case TokenType.Set:
        case TokenType.Echo:
        case TokenType.Param:
        case TokenType.Skip: {
            const key = tok.value.toLowerCase();
            const data = metaData[key];
            if (!data) return mkHover(`**${tok.value}** — meta command`);
            return mkHover(`**${tok.value}** — ${data.title}\n\n${data.description}`);
        }

        // ── Identifiers: var.x, global.x, param.x, object model paths ─────────
        case TokenType.Identifier: {
            const val = tok.value;

            if (val.startsWith('var.')) {
                const name = val.slice(4);
                const decl = symbolTable.lookupVarAtLine(name, uri, lineNum, lineIndent);
                if (!decl) {
                    return mkHover(`**${val}**\n\n⚠️ *Undeclared variable — no \`var ${name} = ...\` found in scope.*`);
                }
                return mkHover(
                    `**${val}**\n\nScope: \`var\` · Type: \`${decl.inferredType ?? 'unknown'}\` · Declared at line ${decl.line + 1} (indent ${decl.indent})`
                );
            }

            if (val.startsWith('global.')) {
                const name = val.slice(7);
                const decl = symbolTable.lookupGlobal(name);
                if (!decl) {
                    return mkHover(
                        `**${val}**\n\n*Not declared in any open file — may be declared in a closed macro or created at runtime.*`
                    );
                }
                return mkHover(
                    `**${val}**\n\nScope: \`global\` · Type: \`${decl.inferredType ?? 'unknown'}\` · Declared in \`${shortUri(decl.uri)}\` at line ${decl.line + 1}`
                );
            }

            if (val.startsWith('param.')) {
                const name = val.slice(6);
                const decl = symbolTable.lookupParam(name, uri);
                if (!decl) {
                    return mkHover(`**${val}**\n\n⚠️ *Macro parameter \`${name}\` not declared in this file.*`);
                }
                return mkHover(
                    `**${val}**\n\nScope: \`param\` · Type: \`${decl.inferredType ?? 'unknown'}\` · Declared at line ${decl.line + 1}`
                );
            }

            // Bare identifier — reconstruct the full OM path from token context
            // (handles  sensors.probes[0].value  where the cursor is on "value")
            const fullPath = reconstructOmPath(tokens, tokIdx);
            return buildOmHover(fullPath);
        }

        // ── Named constants ───────────────────────────────────────────────────
        case TokenType.True:
        case TokenType.False:
            return mkHover(`**${tok.value}** — boolean constant`);
        case TokenType.Null:
            return mkHover(`**null** — null / no value`);
        case TokenType.Pi:
            return mkHover(`**pi** — π ≈ 3.14159265358979`);
        case TokenType.Iterations:
            return mkHover(`**iterations** — number of completed iterations of the innermost \`while\` loop`);
        case TokenType.Line:
            return mkHover(`**line** — current line number in the executing file`);
        case TokenType.Result:
            return mkHover(`**result** — result of the last M-code or G-code command (0 = success)`);
        case TokenType.Input:
            return mkHover(`**input** — the value entered by the user in response to an M291 prompt`);

        // ── Operators ─────────────────────────────────────────────────────────
        case TokenType.Plus:
        case TokenType.Minus:
        case TokenType.Star:
        case TokenType.Slash:
        case TokenType.Caret:
        case TokenType.EqEq:
        case TokenType.NEq:
        case TokenType.Lt:
        case TokenType.Gt:
        case TokenType.LtEq:
        case TokenType.GtEq:
        case TokenType.And:
        case TokenType.Or:
        case TokenType.Not:
        case TokenType.Ternary:
        case TokenType.Hash:
        case TokenType.DoubleGt:
        case TokenType.TripleGt: {
            const data = operatorsData[tok.value];
            if (!data) return null;
            return mkHover(`**${tok.value}** — ${data.title}\n\n${data.description}`);
        }

        default:
            return null;
    }
}

// ── Object Model path reconstruction ─────────────────────────────────────────
//
// The lexer tokenises  sensors.probes[0].value[0]  as:
//   [Identifier "sensors.probes"] [LBracket] [Integer "0"] [RBracket]
//   [Dot] [Identifier "value"] [LBracket] [Integer "0"] [RBracket]
//
// When the user hovers over "value" (tokIdx=5), we need to walk backwards
// through the token stream and build the normalised OM path.
//
// Result for the example above: "sensors.probes[].value"
// (we include [] for the subscript of the segment BEFORE the dot, not after,
//  since the cursor token is the start of the next segment.)
function reconstructOmPath(tokens: Token[], tokIdx: number): string {
    const curTok = tokens[tokIdx];
    // Start with the current token's value (it may already contain dots: "sensors.probes")
    let segments: string[] = [curTok.value];

    let i = tokIdx - 1;

    while (i >= 0) {
        const t = tokens[i];

        if (t.type === TokenType.Dot) {
            // The segment before this dot may be an identifier possibly followed by [n]
            i--;
            // Walk back past any trailing subscript(s) of the previous segment
            let trailingIndex = '';
            while (i >= 0 && tokens[i].type === TokenType.RBracket) {
                trailingIndex = '[]' + trailingIndex;
                i--; // skip ]
                // skip the index expression
                let depth = 1;
                while (i >= 0 && depth > 0) {
                    if (tokens[i].type === TokenType.RBracket) depth++;
                    else if (tokens[i].type === TokenType.LBracket) depth--;
                    i--;
                }
            }
            // Now tokens[i] should be the identifier for this segment
            if (i >= 0 && (tokens[i].type === TokenType.Identifier || tokens[i].type === TokenType.FunctionName)) {
                segments.unshift(tokens[i].value + trailingIndex);
                i--;
            } else {
                break;
            }
        } else {
            break;
        }
    }

    return segments.join('.');
}

// ── Object Model hover ────────────────────────────────────────────────────────
function buildOmHover(path: string): Hover {
    const omRef = '\n\nSee [Object Model reference](https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Reference).';
    // Normalise [n] → [] for lookup
    const normPath = path.replace(/\[\d+\]/g, '[]');

    if (!isOmIndexAvailable()) {
        return mkHover(`**${path}**\n\nObject Model path — resolved at runtime by RepRapFirmware.${omRef}`);
    }

    if (isValidOmPath(normPath)) {
        const info = getOmPathInfo(normPath);
        const typeStr = info ? ` · Type: \`${info.type}${info.isArray ? '[]' : ''}\`` : '';
        return mkHover(`**${path}**\n\nObject Model path${typeStr}${omRef}`);
    }

    return mkHover(
        `**${path}**\n\n⚠️ *Unknown Object Model path — not found in the static schema.*\n\nIf this is a plugin-provided property it will be resolved at runtime.${omRef}`
    );
}

function mkHover(md: string): Hover {
    return { contents: { kind: MarkupKind.Markdown, value: md } };
}

function shortUri(uri: string): string {
    return uri.split('/').slice(-2).join('/');
}