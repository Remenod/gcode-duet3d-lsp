// analysis/symbolTable.ts
// Tracks var., global., and param. variable declarations across open documents.

import { Token, TokenType } from '../parser/types';
import { Lexer } from '../parser/lexer';

export type VarScope = 'var' | 'global' | 'param';

export interface VariableDecl {
    name: string;
    scope: VarScope;
    uri: string;
    line: number;
    col: number;
    indent: number;
    inferredType?: string;   // 'int' | 'float' | 'bool' | 'string' | 'array' | 'unknown'
}

export class SymbolTable {
    // global. vars: name → all declarations across all files (for duplicate detection)
    private globals = new Map<string, VariableDecl[]>();

    // var. locals: uri → name → list of all declarations (one per block scope)
    private locals = new Map<string, Map<string, VariableDecl[]>>();

    // param. declarations (per file): uri → name → decl
    private params = new Map<string, Map<string, VariableDecl>>();

    // ── Scan a whole document ─────────────────────────────────────────────────
    indexDocument(uri: string, text: string): void {
        // Clear old entries for this document
        this.locals.set(uri, new Map());
        this.params.set(uri, new Map());

        // Remove globals that came from this document
        for (const [name, decls] of this.globals) {
            const filtered = decls.filter(d => d.uri !== uri);
            if (filtered.length === 0) {
                this.globals.delete(name);
            } else {
                this.globals.set(name, filtered);
            }
        }

        const localMap = this.locals.get(uri)!;
        const paramMap = this.params.get(uri)!;

        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const indent = lineIndent(line);
            const tokens = new Lexer(line, i).tokenize();
            if (!tokens.length) continue;

            const first = tokens[0];

            // var <name> = ...
            if (first.type === TokenType.Var && tokens[1]?.type === TokenType.Identifier) {
                const nameTok = tokens[1];
                const decl: VariableDecl = {
                    name: nameTok.value,
                    scope: 'var',
                    uri,
                    line: i,
                    col: nameTok.start,
                    indent,
                    inferredType: inferTypeFromTokens(tokens, 3),
                };
                const list = localMap.get(nameTok.value) ?? [];
                list.push(decl);
                localMap.set(nameTok.value, list);
            }

            // global <name> = ...
            else if (first.type === TokenType.Global && tokens[1]?.type === TokenType.Identifier) {
                const nameTok = tokens[1];
                const decl: VariableDecl = {
                    name: nameTok.value,
                    scope: 'global',
                    uri,
                    line: i,
                    col: nameTok.start,
                    indent,
                    inferredType: inferTypeFromTokens(tokens, 3),
                };
                const existing = this.globals.get(nameTok.value) ?? [];
                existing.push(decl);
                this.globals.set(nameTok.value, existing);
            }

            // param <name> = ...
            else if (first.type === TokenType.Param && tokens[1]?.type === TokenType.Identifier) {
                const nameTok = tokens[1];
                const decl: VariableDecl = {
                    name: nameTok.value,
                    scope: 'param',
                    uri,
                    line: i,
                    col: nameTok.start,
                    indent,
                    inferredType: inferTypeFromTokens(tokens, 3),
                };
                paramMap.set(nameTok.value, decl);
            }
        }
    }

    // ── Remove document ───────────────────────────────────────────────────────
    removeDocument(uri: string): void {
        this.locals.delete(uri);
        this.params.delete(uri);
        for (const [name, decls] of this.globals) {
            const filtered = decls.filter(d => d.uri !== uri);
            if (filtered.length === 0) {
                this.globals.delete(name);
            } else {
                this.globals.set(name, filtered);
            }
        }
    }

    // ── Scope-aware var lookup ────────────────────────────────────────────────
    lookupVarAtLine(name: string, uri: string, refLine: number, refIndent: number): VariableDecl | undefined {
        const decls = this.locals.get(uri)?.get(name) ?? [];
        let best: VariableDecl | undefined;
        for (const d of decls) {
            if (d.line <= refLine && d.indent <= refIndent) {
                if (
                    !best ||
                    d.indent > best.indent ||
                    (d.indent === best.indent && d.line > best.line)
                ) {
                    best = d;
                }
            }
        }
        return best;
    }

    // ── Global lookup ─────────────────────────────────────────────────────────

    /** Returns the first (canonical) declaration across all files, or undefined. */
    lookupGlobal(name: string): VariableDecl | undefined {
        const decls = this.globals.get(name);
        return decls && decls.length > 0 ? decls[0] : undefined;
    }

    /** Returns ALL declarations of a global across all files (for duplicate detection). */
    getAllGlobalDecls(name: string): VariableDecl[] {
        return this.globals.get(name) ?? [];
    }

    /** Returns all global declarations from a specific file. */
    getGlobalDeclsInFile(name: string, uri: string): VariableDecl[] {
        return (this.globals.get(name) ?? []).filter(d => d.uri === uri);
    }

    // ── Completions ───────────────────────────────────────────────────────────
    getLocalCompletions(uri: string): VariableDecl[] {
        const out: VariableDecl[] = [];
        for (const list of (this.locals.get(uri)?.values() ?? [])) {
            if (list.length > 0) out.push(list[list.length - 1]);
        }
        return out;
    }

    getGlobalCompletions(): VariableDecl[] {
        // Return the first decl for each global name
        return [...this.globals.values()].map(decls => decls[0]).filter(Boolean);
    }

    getParamCompletions(uri: string): VariableDecl[] {
        return [...(this.params.get(uri)?.values() ?? [])];
    }

    getAllCompletions(uri: string): VariableDecl[] {
        return [
            ...this.getLocalCompletions(uri),
            ...this.getGlobalCompletions(),
            ...this.getParamCompletions(uri),
        ];
    }

    // ── Point lookups ─────────────────────────────────────────────────────────

    lookupVar(name: string, uri: string): VariableDecl | undefined {
        const decls = this.locals.get(uri)?.get(name) ?? [];
        let best: VariableDecl | undefined;
        for (const d of decls) {
            if (!best || d.indent < best.indent || (d.indent === best.indent && d.line > best.line)) {
                best = d;
            }
        }
        return best;
    }

    lookupParam(name: string, uri: string): VariableDecl | undefined {
        return this.params.get(uri)?.get(name);
    }

    resolveQualified(qualified: string, uri: string): VariableDecl | undefined {
        if (qualified.startsWith('var.')) return this.lookupVar(qualified.slice(4), uri);
        if (qualified.startsWith('global.')) return this.lookupGlobal(qualified.slice(7));
        if (qualified.startsWith('param.')) return this.lookupParam(qualified.slice(6), uri);
        return undefined;
    }

    resolveQualifiedAtLine(qualified: string, uri: string, refLine: number, refIndent: number): VariableDecl | undefined {
        if (qualified.startsWith('var.')) return this.lookupVarAtLine(qualified.slice(4), uri, refLine, refIndent);
        if (qualified.startsWith('global.')) return this.lookupGlobal(qualified.slice(7));
        if (qualified.startsWith('param.')) return this.lookupParam(qualified.slice(6), uri);
        return undefined;
    }

    isKnownVar(qualified: string, uri: string): boolean {
        return this.resolveQualified(qualified, uri) !== undefined;
    }

    isKnownVarAtLine(qualified: string, uri: string, refLine: number, refIndent: number): boolean {
        return this.resolveQualifiedAtLine(qualified, uri, refLine, refIndent) !== undefined;
    }

    /** Returns all declarations of a var name in a file (for duplicate detection). */
    getAllDeclsForName(name: string, uri: string): VariableDecl[] {
        return this.locals.get(uri)?.get(name) ?? [];
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lineIndent(line: string): number {
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    return i;
}

function inferTypeFromTokens(tokens: Token[], startIdx: number): string {
    const t = tokens[startIdx];
    if (!t || t.type === TokenType.EOF) return 'unknown';

    switch (t.type) {
        case TokenType.Integer:
        case TokenType.HexInteger:
        case TokenType.BinInteger: return 'int';
        case TokenType.Float: return 'float';
        case TokenType.StringLit: return 'string';
        case TokenType.CharLit: return 'char';
        case TokenType.True:
        case TokenType.False: return 'bool';
        case TokenType.LBracket:
        case TokenType.LBrace: return 'array';
        default: return 'unknown';
    }
}
