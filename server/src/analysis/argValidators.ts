// analysis/argValidators.ts
//
// Extensible argument-validation framework for G/M/T command parameters.
//
// ──────────────────────────────────────────────────────────────────────────
// Design
// ──────────────────────────────────────────────────────────────────────────
//
// Each command has a set of one-letter parameters (`M98 P"..."` → letter `P`).
// A *validator* is a small function that receives the value token after a
// known letter and either approves it silently or returns one or more
// diagnostics.  Validators are registered in `COMMAND_ARG_RULES`, keyed by
// command name (e.g. `M98`) and parameter letter (e.g. `P`).
//
// The framework is intentionally tiny: it owns just the dispatch table and a
// `validateGCodeArgs` driver.  Concrete validators live in this same file but
// can be added without touching anything else — register them in
// COMMAND_ARG_RULES and they pick up automatically.
//
// Currently shipped validators:
//   • filePathValidator — warns when a string-literal argument refers to a
//     file that does not exist on the SD card.
//
// Adding a new validator (sketch):
//
//   const myValidator: ArgValidator = (a) => {
//       if (a.valueTok.type !== TokenType.Integer) return null;
//       const n = parseInt(a.valueTok.value, 10);
//       if (n < 0 || n > 255) return mkDiag(a.valueTok, 'must be 0..255');
//       return null;
//   };
//   COMMAND_ARG_RULES.set('M42', new Map([['P', myValidator]]));
//
// Validators must NOT throw — return null when they don't apply to the given
// argument shape (variable, brace-expression, wrong literal type, …).

import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';
import { findSdRoot, resolvePathPrefix } from './pathCompletion';
import { ArgCheckConfig, isPathIgnored } from './argCheckConfig';

// ── Public API ────────────────────────────────────────────────────────────────

/** Diagnostic code used by the path validator (consumed by the code-action provider). */
export const PATH_NOT_FOUND_CODE = 'rrf-path-not-found';

/**
 * Per-argument context handed to each validator.
 *
 *   letter       The parameter letter the user wrote (already upper-cased).
 *   letterTok    The GCodeWord token for that letter (for diagnostic ranges).
 *   valueTok     The token(s) immediately after the letter — see `valueTokens`
 *                for the full slice.
 *   valueTokens  All tokens belonging to the argument value.  For literal
 *                values this is one token; for brace expressions
 *                (`P{var.x + 1}`) it is the LBrace through RBrace.  An empty
 *                array means the letter has no value (rare, e.g. flag args).
 *   commandName  Upper-cased command name (e.g. `M98`).
 *   docUri       URI of the document being validated.
 *   sdRoot       Resolved SD-card root on disk, or null if none was found.
 *                Validators that need filesystem access should bail out when
 *                this is null.
 */
export interface ArgContext {
    letter: string;
    letterTok: Token;
    valueTok: Token;
    valueTokens: Token[];
    commandName: string;
    docUri: string;
    sdRoot: string | null;
    config: ArgCheckConfig;
}

export type ArgValidator = (a: ArgContext) => Diagnostic[] | Diagnostic | null;

// ── Command-letter dispatch table ─────────────────────────────────────────────

/**
 * Map: command-name → letter → validator.
 *
 * Lookup is case-insensitive on the command name (we upper-case before lookup);
 * the letter map keys must already be upper-case.
 */
export const COMMAND_ARG_RULES = new Map<string, Map<string, ArgValidator>>();

// ── filePathValidator ─────────────────────────────────────────────────────────
//
// Warns when a string-literal argument points to a file that does not exist
// on the SD card.  Returns null in every "don't know" case so the user is
// never bothered when the value is dynamic:
//
//   M98 P"sys/mymacro.g"        → check, warn if missing
//   M98 P{var.path}             → ignored (expression)
//   M98 P var.path              → ignored (variable reference)
//   M98 P{...}                  → ignored
//   M98 P"" (empty)             → ignored (still being typed)
//
// The check is suppressed entirely when `config.paths.enabled` is false or
// when the path matches one of the user-configured ignore globs.
export const filePathValidator: ArgValidator = (a): Diagnostic | null => {
    if (!a.config.paths.enabled) return null;
    if (a.valueTok.type !== TokenType.StringLit) return null;

    // Strip the surrounding quotes; collapse escaped "" → "
    const raw = a.valueTok.value;
    if (raw.length < 2) return null;                    // unclosed or empty token
    const inner = raw.slice(1, raw.endsWith('"') ? raw.length - 1 : raw.length)
        .replace(/""/g, '"');
    if (inner.trim() === '') return null;               // blank — nothing to check

    if (!a.sdRoot) return null;                          // can't resolve without root

    const resolved = resolveRrfPathToDisk(inner, a.sdRoot);
    if (!resolved) return null;

    // Ignored by user config?  `inner` is the path the user wrote; `relative`
    // is its workspace-relative form (always portable).
    const relative = path.relative(a.sdRoot, resolved).split(path.sep).join('/');
    if (isPathIgnored(relative, a.config.paths.ignore)) return null;

    if (fs.existsSync(resolved)) return null;

    return {
        severity: DiagnosticSeverity.Warning,
        message: `File not found: '${inner}' (expected at '${relative}')`,
        range: {
            start: { line: a.valueTok.line, character: a.valueTok.start },
            end: { line: a.valueTok.line, character: a.valueTok.end },
        },
        source: 'rrf-gcode',
        code: PATH_NOT_FOUND_CODE,
        // Extra data piggy-backed for the code-action provider — it needs the
        // relative path to write into settings and the absolute one to map
        // back to the workspace root when the user clicks the quick-fix.
        data: { relative, absolute: resolved, sdRoot: a.sdRoot },
    };
};

// ── Path-resolution helper ────────────────────────────────────────────────────
//
// Same rules as RRF runtime: volume prefix is optional ("0:/..." == "/..."),
// bare file names resolve in /sys/.  Returns the absolute path on disk.
export function resolveRrfPathToDisk(rrfPath: string, sdRoot: string): string | null {
    if (!sdRoot) return null;

    let rest = rrfPath;
    const volMatch = /^\d+:\/?/.exec(rest);
    if (volMatch) rest = rest.slice(volMatch[0].length);

    // Absolute "/sys/x"  vs  bare "x" (interpreted as sys/x by RRF).
    const isAbsolute = rest.startsWith('/');
    rest = rest.replace(/^\/+/, '');

    // Bare basename → /sys/<name>.  Reproduce the firmware default that
    // shortcut M-codes use (M28, M30, M32 etc.).
    if (!isAbsolute && !rest.includes('/')) {
        return path.join(sdRoot, 'sys', rest);
    }
    return path.join(sdRoot, rest);
}

// ── Argument extraction ───────────────────────────────────────────────────────

/**
 * Slice a token stream into `(letter, value)` pairs starting at index 1 (just
 * after the GCode/TCode token).  Each pair groups one GCodeWord with the
 * tokens that form its value: either a single literal/identifier, or a full
 * `{ … }` expression including the braces.
 *
 * Whitespace is invisible to the lexer so we work purely on token positions.
 * Unknown shapes (e.g. an Operator token where a value is expected) terminate
 * the current argument — we don't try to interpret malformed parameter
 * values, the regular expression validator catches those.
 */
export function extractArgs(tokens: Token[]): Array<{
    letterTok: Token;
    valueTokens: Token[];
}> {
    const out: Array<{ letterTok: Token; valueTokens: Token[] }> = [];

    let i = 1;
    while (i < tokens.length) {
        const t = tokens[i];
        if (t.type === TokenType.EOF || t.type === TokenType.Comment) break;

        // Reset on a nested inline G/M/T command (M42P2S1M42P3S0).
        if (t.type === TokenType.GCode || t.type === TokenType.TCode) { i++; continue; }

        if (t.type !== TokenType.GCodeWord) { i++; continue; }

        const letterTok = t;
        i++;

        // Collect the value tokens that follow.
        const valueTokens: Token[] = [];
        if (i < tokens.length) {
            const vt = tokens[i];

            if (vt.type === TokenType.LBrace) {
                // Brace expression: take everything up to matching `}`.
                let depth = 0;
                while (i < tokens.length) {
                    const cur = tokens[i];
                    if (cur.type === TokenType.EOF) break;
                    valueTokens.push(cur);
                    if (cur.type === TokenType.LBrace) depth++;
                    else if (cur.type === TokenType.RBrace) {
                        depth--;
                        if (depth === 0) { i++; break; }
                    }
                    i++;
                }
            } else if (
                vt.type === TokenType.Integer ||
                vt.type === TokenType.HexInteger ||
                vt.type === TokenType.BinInteger ||
                vt.type === TokenType.Float ||
                vt.type === TokenType.StringLit ||
                vt.type === TokenType.CharLit ||
                vt.type === TokenType.Identifier ||
                vt.type === TokenType.Minus ||      // signed number  X-10
                vt.type === TokenType.Plus
            ) {
                // Plain value: one token (numeric/string) plus optional sign.
                valueTokens.push(vt);
                i++;
                // Allow signed integer after Minus/Plus: take one more numeric token.
                if (
                    (vt.type === TokenType.Minus || vt.type === TokenType.Plus) &&
                    i < tokens.length &&
                    (tokens[i].type === TokenType.Integer ||
                        tokens[i].type === TokenType.Float ||
                        tokens[i].type === TokenType.HexInteger ||
                        tokens[i].type === TokenType.BinInteger)
                ) {
                    valueTokens.push(tokens[i]);
                    i++;
                }
            }
        }

        out.push({ letterTok, valueTokens });
    }

    return out;
}

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Run all registered validators for the command on this line.  No-op when
 * `config.enabled` is false, the line is not a G/M/T command, or there are
 * no rules for this command.
 *
 * `sdRoot` should be precomputed once per document by the caller (cheap, but
 * an fs.readdir on each invocation would add up over a large file).
 */
export function validateGCodeArgs(
    tokens: Token[],
    docUri: string,
    sdRoot: string | null,
    config: ArgCheckConfig,
): Diagnostic[] {
    if (!config.enabled) return [];
    if (tokens.length === 0) return [];

    const head = tokens[0];
    if (head.type !== TokenType.GCode && head.type !== TokenType.TCode) return [];

    const commandName = head.value.toUpperCase();
    const rules = COMMAND_ARG_RULES.get(commandName);
    if (!rules) return [];

    const diagnostics: Diagnostic[] = [];
    for (const { letterTok, valueTokens } of extractArgs(tokens)) {
        if (valueTokens.length === 0) continue;
        const validator = rules.get(letterTok.value.toUpperCase());
        if (!validator) continue;

        const result = validator({
            letter: letterTok.value.toUpperCase(),
            letterTok,
            valueTok: valueTokens[0],
            valueTokens,
            commandName,
            docUri,
            sdRoot,
            config,
        });

        if (!result) continue;
        if (Array.isArray(result)) diagnostics.push(...result);
        else diagnostics.push(result);
    }
    return diagnostics;
}

// ── Per-document SD-root cache ────────────────────────────────────────────────
//
// `findSdRoot` walks up the filesystem and reads directory listings; called
// per line on big files it would dominate the diagnostic pass.  We memoise
// by document URI; entries are invalidated when a document is closed (the
// caller can drop the cache; it's just a Map).
const sdRootCache = new Map<string, string | null>();

export function getSdRootForUri(uri: string): string | null {
    if (sdRootCache.has(uri)) return sdRootCache.get(uri)!;
    let resolved: string | null = null;
    try {
        const fsPath = uriToFsPath(uri);
        if (fsPath) resolved = findSdRoot(path.dirname(fsPath));
    } catch { /* ignore */ }
    sdRootCache.set(uri, resolved);
    return resolved;
}

export function invalidateSdRootCache(uri?: string): void {
    if (uri) sdRootCache.delete(uri);
    else sdRootCache.clear();
}

// Minimal local URI → fs-path conversion to avoid importing vscode-uri here
// (keeps this module easy to unit-test in isolation).
function uriToFsPath(uri: string): string | null {
    if (!uri.startsWith('file://')) return null;
    let p = decodeURIComponent(uri.slice('file://'.length));
    // file:///C:/...
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
}

// ── Registry: which commands take a file-path argument ───────────────────────
//
// Maps the parameter LETTER that carries the path for each command.
// Sources: docs.duet3d.com Gcodes reference (anchor names in comments).
const FILE_PATH_COMMANDS: Array<{ cmd: string; letters: string[] }> = [
    { cmd: 'M20', letters: ['P'] },   // list SD directory
    { cmd: 'M23', letters: ['P'] },   // select SD file
    { cmd: 'M28', letters: ['P'] },   // begin write to file
    { cmd: 'M30', letters: ['P'] },   // delete file
    { cmd: 'M32', letters: ['P'] },   // print file
    { cmd: 'M36', letters: ['P'] },   // file info
    { cmd: 'M37', letters: ['P'] },   // simulation mode (file)
    { cmd: 'M38', letters: ['P'] },   // SHA1 file
    { cmd: 'M39', letters: ['P'] },   // SD info
    { cmd: 'M98', letters: ['P'] },   // call macro
    { cmd: 'M375', letters: ['P'] },   // load heightmap
    { cmd: 'M376', letters: ['P'] },   // save heightmap
    { cmd: 'M471', letters: ['S', 'R'] }, // rename / copy: both are paths
    { cmd: 'M501', letters: ['P'] },   // load config-override
];

for (const { cmd, letters } of FILE_PATH_COMMANDS) {
    const m = new Map<string, ArgValidator>();
    for (const L of letters) m.set(L, filePathValidator);
    COMMAND_ARG_RULES.set(cmd, m);
}
