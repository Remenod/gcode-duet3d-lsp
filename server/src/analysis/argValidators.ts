// analysis/argValidators.ts
//
// Extensible argument-validation framework for G/M/T command parameters.
//
// The validator is deliberately conservative: it only warns for static path
// literals whose command/parameter is known to be a filesystem path in RRF.
// Dynamic expressions (`P{var.path}`), variables, incomplete strings and
// unknown command shapes are ignored rather than guessed.

import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';
import { findSdRoot } from './pathCompletion';
import { ArgCheckConfig, isPathIgnored } from './argCheckConfig';

// ── Public API ────────────────────────────────────────────────────────────────

/** Diagnostic code used by the path validator (consumed by the code-action provider). */
export const PATH_NOT_FOUND_CODE = 'rrf-path-not-found';

/**
 * Per-argument context handed to each validator.
 */
export interface ArgContext {
    letter: string;
    letterTok: Token;
    valueTok: Token;
    valueTokens: Token[];
    /** All parsed arguments on the same G/M/T command line. */
    allArgs: ExtractedArg[];
    commandName: string;
    docUri: string;
    sdRoot: string | null;
    config: ArgCheckConfig;
}

export interface ExtractedArg {
    letterTok: Token;
    valueTokens: Token[];
}

export type ArgValidator = (a: ArgContext) => Diagnostic[] | Diagnostic | null;

/** How a static path should be checked. */
export type PathCheckMode = 'exists' | 'directory-exists' | 'parent-exists';

export interface PathResolveOptions {
    /**
     * RRF command-specific default directory for relative paths, without leading slash.
     * Example: M98 P"foo.g" and M98 P"led/red.g" both resolve under /sys.
     */
    defaultRelativeDir?: string;

    /** Backward-compatible alias. Used only when defaultRelativeDir is absent. */
    defaultBareDir?: string;
}

export interface PathArgRule {
    mode: PathCheckMode;
    validator: ArgValidator;
    resolve?: PathResolveOptions;
}

// Legacy/simple dispatch table used by older call sites and by pathDefinition
// for fast “does this command-letter accept a path?” checks.
export const COMMAND_ARG_RULES = new Map<string, Map<string, ArgValidator>>();

// Rich path-rule tables used by diagnostics and go-to-definition.
const COMMAND_PATH_ARG_RULES = new Map<string, Map<string, PathArgRule>>();
const TAIL_PATH_RULES = new Map<string, PathArgRule>();

export function getCommandPathArgRule(commandName: string, letter: string): PathArgRule | undefined {
    return COMMAND_PATH_ARG_RULES.get(commandName.toUpperCase())?.get(letter.toUpperCase());
}

export function getTailPathRule(commandName: string): PathArgRule | undefined {
    return TAIL_PATH_RULES.get(commandName.toUpperCase());
}

// ── Concrete path validators ─────────────────────────────────────────────────

export const filePathValidator: ArgValidator = makePathValidator('exists');
export const directoryPathValidator: ArgValidator = makePathValidator('directory-exists');
export const parentPathValidator: ArgValidator = makePathValidator('parent-exists');

function makePathValidator(mode: PathCheckMode, resolve?: PathResolveOptions): ArgValidator {
    return (a): Diagnostic | null => {
        if (!a.config.paths.enabled) return null;
        const literal = literalPathFromTokens(a.valueTokens);
        if (!literal) return null;
        return validateStaticPath(literal.text, a.valueTok.line, literal.start, literal.end, a, mode, resolve);
    };
}

/** G29 P changes meaning depending on S: S1/S4 load, S3 saves. */
const g29PathValidator: ArgValidator = (a): Diagnostic | null => {
    if (!a.config.paths.enabled) return null;
    const literal = literalPathFromTokens(a.valueTokens);
    if (!literal) return null;

    const s = numericArgValue(a.allArgs, 'S');
    const mode: PathCheckMode = s === 3 ? 'parent-exists' : 'exists';
    return validateStaticPath(literal.text, a.valueTok.line, literal.start, literal.end, a, mode, { defaultRelativeDir: 'sys' });
};

function validateStaticPath(
    rrfPath: string,
    line: number,
    start: number,
    end: number,
    a: Pick<ArgContext, 'sdRoot' | 'config'>,
    mode: PathCheckMode,
    resolve?: PathResolveOptions,
): Diagnostic | null {
    if (rrfPath.trim() === '') return null;
    if (!a.sdRoot) return null;

    const resolved = resolveRrfPathToDisk(rrfPath, a.sdRoot, resolve);
    if (!resolved) return null;

    const checkPath = mode === 'parent-exists' ? path.dirname(resolved) : resolved;
    const relative = path.relative(a.sdRoot, resolved).split(path.sep).join('/');
    const checkRelative = path.relative(a.sdRoot, checkPath).split(path.sep).join('/') || '.';

    // Ignore patterns are matched against the user-written target.  For create
    // operations this means ignoring `sys/generated.g` suppresses the warning
    // even though the actual filesystem check is on `sys/`.
    if (isPathIgnored(relative, a.config.paths.ignore)) return null;

    let ok = false;
    const existingCheckPath = resolveExistingPathCaseInsensitive(checkPath);
    if (existingCheckPath) {
        try {
            const st = fs.statSync(existingCheckPath);
            ok = mode === 'directory-exists' ? st.isDirectory() : true;
        } catch {
            ok = false;
        }
    }
    if (ok) return null;

    const message = mode === 'parent-exists'
        ? `Parent directory not found for '${rrfPath}' (expected '${checkRelative}')`
        : mode === 'directory-exists'
            ? `Directory not found: '${rrfPath}' (expected at '${relative}')`
            : `File or directory not found: '${rrfPath}' (expected at '${relative}')`;

    return {
        severity: DiagnosticSeverity.Warning,
        message,
        range: {
            start: { line, character: start },
            end: { line, character: end },
        },
        source: 'rrf-gcode',
        code: PATH_NOT_FOUND_CODE,
        data: { relative, absolute: resolved, sdRoot: a.sdRoot },
    };
}

// ── Path-resolution helper ────────────────────────────────────────────────────

/**
 * Convert an RRF path string into a filesystem path under `sdRoot`.
 *
 * Common RRF resolution:
 *   0:/sys/config.g  → <sdRoot>/sys/config.g
 *   /sys/config.g    → <sdRoot>/sys/config.g
 *
 * Some commands define a default directory for relative paths. For M98 the
 * default is /sys, so both `M98 P"foo.g"` and `M98 P"led/red.g"` resolve
 * under `<sdRoot>/sys`. To address the SD root explicitly, use `/...` or `0:/...`.
 */
export function resolveRrfPathToDisk(
    rrfPath: string,
    sdRoot: string,
    options: PathResolveOptions = {},
): string | null {
    if (!sdRoot) return null;
    if (/\0|\r|\n/.test(rrfPath)) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rrfPath)) return null; // URL, not an RRF path
    if (rrfPath.includes('\\')) return null;                    // RRF paths use '/'

    let rest = rrfPath;
    const volMatch = /^\d+:\/?/.exec(rest);
    const hasVolume = !!volMatch;
    if (volMatch) rest = rest.slice(volMatch[0].length);

    const isAbsolute = hasVolume || rest.startsWith('/');
    rest = rest.replace(/^\/+/, '');

    const defaultRelativeDir = options.defaultRelativeDir ?? options.defaultBareDir;
    const baseDir = !isAbsolute && defaultRelativeDir
        ? path.resolve(sdRoot, defaultRelativeDir)
        : path.resolve(sdRoot);

    const abs = path.resolve(baseDir, rest);

    const root = path.resolve(sdRoot);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;

    // Workstation mirrors are often case-sensitive, while typical Duet SD-card
    // filesystems are case-insensitive. If the path already exists with different
    // casing, return the actual on-disk casing so diagnostics and F12 do not
    // produce false negatives for paths that the printer accepts.
    return resolveExistingPathCaseInsensitive(abs) ?? abs;
}

export function resolveExistingPathCaseInsensitive(absPath: string): string | null {
    const parsed = path.parse(path.resolve(absPath));
    const root = parsed.root;
    const rel = path.relative(root, path.resolve(absPath));
    const parts = rel.split(path.sep).filter(Boolean);

    let cur = root || path.sep;
    for (const part of parts) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            return null;
        }

        const exact = entries.find(e => e.name === part);
        const match = exact ?? entries.find(e => e.name.toLowerCase() === part.toLowerCase());
        if (!match) return null;
        cur = path.join(cur, match.name);
    }

    return cur;
}

/**
 * Strict heuristic used only for fallback go-to-definition in arbitrary string
 * literals.  Registered command arguments do not use this heuristic.
 */
export function stringLooksLikeRrfPath(s: string): boolean {
    if (s.length === 0 || s !== s.trim()) return false;
    if (/\0|\r|\n/.test(s)) return false;
    if (s.includes('\\')) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;

    if (/^\d+:\//.test(s) || s.startsWith('/')) return true;
    if (s.includes('/')) return true;

    return /\.(g|gcode|csv|txt|json|bin|zip|dat|xml|html|css|js|png|jpe?g|qoi|pem|crt|key|log)$/i.test(s);
}

// ── Argument extraction ───────────────────────────────────────────────────────

export function extractArgs(tokens: Token[]): ExtractedArg[] {
    const out: ExtractedArg[] = [];

    let i = 1;
    while (i < tokens.length) {
        const t = tokens[i];
        if (t.type === TokenType.EOF || t.type === TokenType.Comment) break;

        // Reset on a nested inline G/M/T command (M42P2S1M42P3S0).
        if (t.type === TokenType.GCode || t.type === TokenType.TCode) { i++; continue; }

        if (t.type !== TokenType.GCodeWord) { i++; continue; }

        const letterTok = t;
        i++;

        const valueTokens: Token[] = [];
        if (i < tokens.length) {
            const vt = tokens[i];

            if (vt.type === TokenType.LBrace) {
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
            } else if (isSimpleValueToken(vt)) {
                valueTokens.push(vt);
                i++;
                if (
                    (vt.type === TokenType.Minus || vt.type === TokenType.Plus) &&
                    i < tokens.length &&
                    isNumericToken(tokens[i])
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

function isSimpleValueToken(t: Token): boolean {
    return isNumericToken(t) ||
        t.type === TokenType.StringLit ||
        t.type === TokenType.CharLit ||
        t.type === TokenType.Identifier ||
        t.type === TokenType.Minus ||
        t.type === TokenType.Plus;
}

function isNumericToken(t: Token): boolean {
    return t.type === TokenType.Integer ||
        t.type === TokenType.HexInteger ||
        t.type === TokenType.BinInteger ||
        t.type === TokenType.Float;
}

function literalPathFromTokens(tokens: Token[]): { text: string; start: number; end: number } | null {
    if (tokens.length !== 1) return null;
    const t = tokens[0];
    if (t.type !== TokenType.StringLit) return null;
    return stringLiteralText(t);
}

export function stringLiteralText(t: Token): { text: string; start: number; end: number } | null {
    if (t.type !== TokenType.StringLit) return null;
    const raw = t.value;
    if (raw.length < 2) return null;
    const closed = raw.endsWith('"') && !t.unclosed;
    const text = raw.slice(1, closed ? raw.length - 1 : raw.length).replace(/""/g, '"');
    return { text, start: t.start, end: t.end };
}

function numericArgValue(args: ExtractedArg[], letter: string): number | null {
    const arg = args.find(a => a.letterTok.value.toUpperCase() === letter.toUpperCase());
    if (!arg || arg.valueTokens.length === 0) return null;
    const ts = arg.valueTokens;
    const sign = ts[0].type === TokenType.Minus ? -1 : 1;
    const valueTok = (ts[0].type === TokenType.Minus || ts[0].type === TokenType.Plus) ? ts[1] : ts[0];
    if (!valueTok || !isNumericToken(valueTok)) return null;
    const n = Number(valueTok.value);
    return Number.isFinite(n) ? sign * n : null;
}

// ── Tail-path extraction for legacy commands ─────────────────────────────────

export interface TailPathMatch {
    text: string;
    line: number;
    start: number;
    end: number;
}

export function extractTailPath(tokens: Token[], lineText: string): TailPathMatch | null {
    const head = tokens[0];
    if (!head || head.type !== TokenType.GCode) return null;

    const comment = tokens.find(t => t.type === TokenType.Comment);
    const endLimit = comment ? comment.start : lineText.length;
    const rawTail = lineText.slice(head.end, endLimit);
    const leading = rawTail.match(/^\s*/)?.[0].length ?? 0;
    let start = head.end + leading;
    if (start >= endLimit) return null;

    const first = lineText[start];
    if (first === '{') return null; // dynamic expression, don't guess

    if (first === '"') {
        const parsed = parseQuotedAt(lineText, start, endLimit);
        if (!parsed) return null;
        return { text: parsed.text, line: head.line, start, end: parsed.end };
    }

    const m = /^[^\s;]+/.exec(lineText.slice(start, endLimit));
    if (!m) return null;
    return { text: m[0], line: head.line, start, end: start + m[0].length };
}

function parseQuotedAt(src: string, start: number, endLimit: number): { text: string; end: number } | null {
    let i = start + 1;
    let text = '';
    while (i < endLimit) {
        const c = src[i];
        if (c === '"') {
            if (i + 1 < endLimit && src[i + 1] === '"') {
                text += '"';
                i += 2;
                continue;
            }
            return { text, end: i + 1 };
        }
        text += c;
        i++;
    }
    return null;
}

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Run all registered path validators for the command on this line.
 */
export function validateGCodeArgs(
    tokens: Token[],
    lineText: string,
    docUri: string,
    sdRoot: string | null,
    config: ArgCheckConfig,
): Diagnostic[] {
    if (!config.enabled) return [];
    if (tokens.length === 0) return [];

    const head = tokens[0];
    if (head.type !== TokenType.GCode && head.type !== TokenType.TCode) return [];

    const commandName = head.value.toUpperCase();
    const diagnostics: Diagnostic[] = [];

    const rules = COMMAND_ARG_RULES.get(commandName);
    const args = extractArgs(tokens);
    if (rules) {
        for (const { letterTok, valueTokens } of args) {
            if (valueTokens.length === 0) continue;
            const validator = rules.get(letterTok.value.toUpperCase());
            if (!validator) continue;

            const result = validator({
                letter: letterTok.value.toUpperCase(),
                letterTok,
                valueTok: valueTokens[0],
                valueTokens,
                allArgs: args,
                commandName,
                docUri,
                sdRoot,
                config,
            });

            if (!result) continue;
            if (Array.isArray(result)) diagnostics.push(...result);
            else diagnostics.push(result);
        }
    }

    const tailRule = getTailPathRule(commandName);
    if (tailRule) {
        const tail = extractTailPath(tokens, lineText);
        if (tail) {
            const diag = validateStaticPath(
                tail.text,
                tail.line,
                tail.start,
                tail.end,
                { sdRoot, config },
                tailRule.mode,
                tailRule.resolve,
            );
            if (diag) diagnostics.push(diag);
        }
    }

    return diagnostics;
}

// ── Per-document SD-root cache ────────────────────────────────────────────────

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

function uriToFsPath(uri: string): string | null {
    if (!uri.startsWith('file://')) return null;
    let p = decodeURIComponent(uri.slice('file://'.length));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
}

// ── Registry: which commands take filesystem paths ───────────────────────────

function registerArg(cmd: string, letter: string, mode: PathCheckMode, resolve?: PathResolveOptions): void {
    const validator = makePathValidator(mode, resolve);
    const rule: PathArgRule = { mode, validator, resolve };
    const C = cmd.toUpperCase();
    const L = letter.toUpperCase();

    let rich = COMMAND_PATH_ARG_RULES.get(C);
    if (!rich) {
        rich = new Map<string, PathArgRule>();
        COMMAND_PATH_ARG_RULES.set(C, rich);
    }
    rich.set(L, rule);

    let simple = COMMAND_ARG_RULES.get(C);
    if (!simple) {
        simple = new Map<string, ArgValidator>();
        COMMAND_ARG_RULES.set(C, simple);
    }
    simple.set(L, validator);
}

function registerCustomArg(cmd: string, letter: string, mode: PathCheckMode, validator: ArgValidator, resolve?: PathResolveOptions): void {
    const C = cmd.toUpperCase();
    const L = letter.toUpperCase();
    const rule: PathArgRule = { mode, validator, resolve };

    let rich = COMMAND_PATH_ARG_RULES.get(C);
    if (!rich) {
        rich = new Map<string, PathArgRule>();
        COMMAND_PATH_ARG_RULES.set(C, rich);
    }
    rich.set(L, rule);

    let simple = COMMAND_ARG_RULES.get(C);
    if (!simple) {
        simple = new Map<string, ArgValidator>();
        COMMAND_ARG_RULES.set(C, simple);
    }
    simple.set(L, validator);
}

function registerTail(cmd: string, mode: PathCheckMode, resolve?: PathResolveOptions): void {
    TAIL_PATH_RULES.set(cmd.toUpperCase(), { mode, validator: makePathValidator(mode, resolve), resolve });
}

// G29 P is conditional: S1/S4 load; S3 saves.
registerCustomArg('G29', 'P', 'exists', g29PathValidator, { defaultRelativeDir: 'sys' });

// Modern lettered path parameters.
registerArg('M20', 'P', 'directory-exists');        // list folder
registerArg('M36.1', 'P', 'exists');                // embedded thumbnail data from file
registerArg('M36.2', 'P', 'exists');                // height-map fragment from file
registerArg('M37', 'P', 'exists');                  // simulate file
registerArg('M98', 'P', 'exists', { defaultRelativeDir: 'sys' }); // call macro, relative paths default to /sys
registerArg('M374', 'P', 'parent-exists', { defaultRelativeDir: 'sys' }); // save height map
registerArg('M375', 'P', 'exists', { defaultRelativeDir: 'sys' }); // load height map
registerArg('M470', 'P', 'parent-exists');          // create directory
registerArg('M471', 'S', 'exists');                 // rename/move source
registerArg('M471', 'T', 'parent-exists');          // rename/move target parent; target may not exist
registerArg('M472', 'P', 'exists');                 // delete file/directory
registerArg('M505', 'P', 'directory-exists', { defaultRelativeDir: 'sys' });
registerArg('M505.1', 'P', 'directory-exists', { defaultRelativeDir: 'www' });
registerArg('M929', 'P', 'parent-exists');          // event log file, created/appended
registerArg('M956', 'F', 'parent-exists', { defaultRelativeDir: 'sys/accelerometer' });
registerArg('M997', 'P', 'exists', { defaultRelativeDir: 'firmware' });

// Legacy bare-tail filename commands.  The official examples use the filename
// directly after the command, not a P parameter.
registerTail('M23', 'exists');                      // select SD file
registerTail('M28', 'parent-exists');               // begin write to file
registerTail('M30', 'exists');                      // delete file
registerTail('M32', 'exists');                      // select file and start print
registerTail('M36', 'exists');                      // file information
registerTail('M38', 'exists');                      // CRC32 of file
