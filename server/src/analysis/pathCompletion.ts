// analysis/pathCompletion.ts
//
// File-path completion for string literals in RRF G-code.
//
// Important RRF behaviour mirrored here:
//   • Volume-prefixed path:  "0:/sys/config.g"  → SD root / sys / config.g
//   • Absolute path:         "/sys/config.g"    → SD root / sys / config.g
//   • Relative macro path:   M98 P"foo.g"       → SD root / sys / foo.g
//   • Relative macro path:   M98 P"led/red.g"   → SD root / sys / led / red.g
//
// The completion provider is deliberately command-aware. It only offers path
// completions in parameters that are known RRF filesystem paths, so ordinary
// strings such as M291 messages, WiFi SSIDs and passwords are not polluted with
// filesystem suggestions.

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';
import { PATH_FUNCTIONS, PathFunctionRule } from './pathFunctions';

// ── SD-root detection ─────────────────────────────────────────────────────────

/**
 * Top-level directory names that may be present on an RRF SD card mirror.
 *
 * Do not treat a directory as the SD root merely because it has one child named
 * "Firmware" or "www". Macro trees often contain folders with those names.
 * A valid SD root must contain a top-level /sys directory and either /sys/config.g
 * or at least one other known SD-root marker.
 */
const SD_ROOT_MARKERS = new Set([
    'sys',
    'macros',
    'gcodes',
    'www',
    'menu',
    'firmware',
    'filaments',
    'user',
]);

/**
 * Walk upward from `startDir` until a directory that looks like an RRF SD-card
 * root is found. Returns `null` if none is found before the filesystem root.
 */
export function findSdRoot(startDir: string): string | null {
    let dir = startDir;
    let prev = '';
    while (dir !== prev) {
        if (isSdRootCandidate(dir)) return dir;
        prev = dir;
        dir = path.dirname(dir);
    }
    return null;
}

function isSdRootCandidate(dir: string): boolean {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }

    const dirs = new Map<string, string>();
    for (const e of entries) {
        if (e.isDirectory()) dirs.set(e.name.toLowerCase(), e.name);
    }

    const sysName = dirs.get('sys');
    if (!sysName) return false;

    if (caseInsensitiveChildExists(path.join(dir, sysName), 'config.g')) return true;

    let markerCount = 0;
    for (const marker of SD_ROOT_MARKERS) {
        if (dirs.has(marker)) markerCount++;
    }
    return markerCount >= 2;
}

function caseInsensitiveChildExists(parent: string, childName: string): boolean {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
        return false;
    }

    const want = childName.toLowerCase();
    return entries.some(e => e.name.toLowerCase() === want);
}

// ── Command-aware string-literal context detection ────────────────────────────

export interface PathResolveOptions {
    /**
     * Directory used for relative paths, without leading slash.
     * Example: M98 P"foo.g" resolves under /sys, so this is "sys".
     */
    defaultRelativeDir?: string;

    /**
     * Backward-compatible alias. Used only when defaultRelativeDir is absent.
     */
    defaultBareDir?: string;
}

export interface StringContext {
    /** The StringLit token the cursor is inside. */
    tok: Token;
    /** Substring between the opening `"` and the cursor. */
    typedPrefix: string;
    /** Command-specific relative path base. */
    resolve?: PathResolveOptions;
}

interface CompletionPathRule {
    resolve?: PathResolveOptions;
}

const ARG_PATH_RULES = new Map<string, Map<string, CompletionPathRule>>();
const TAIL_PATH_RULES = new Map<string, CompletionPathRule>();

function registerArg(cmd: string, letter: string, resolve?: PathResolveOptions): void {
    const C = cmd.toUpperCase();
    const L = letter.toUpperCase();
    let m = ARG_PATH_RULES.get(C);
    if (!m) {
        m = new Map<string, CompletionPathRule>();
        ARG_PATH_RULES.set(C, m);
    }
    m.set(L, { resolve });
}

function registerTail(cmd: string, resolve?: PathResolveOptions): void {
    TAIL_PATH_RULES.set(cmd.toUpperCase(), { resolve });
}

// Path parameters mirrored from argValidators.ts. Keep this list narrow: only
// parameters that are actually filesystem paths should trigger path completion.
registerArg('G29', 'P', { defaultRelativeDir: 'sys' });
registerArg('M20', 'P', { defaultRelativeDir: 'gcodes' });
registerArg('M36.1', 'P', { defaultRelativeDir: 'gcodes' });
registerArg('M36.2', 'P', { defaultRelativeDir: 'sys' });
registerArg('M37', 'P', { defaultRelativeDir: 'gcodes' });
registerArg('M98', 'P', { defaultRelativeDir: 'sys' });
registerArg('M374', 'P', { defaultRelativeDir: 'sys' });
registerArg('M375', 'P', { defaultRelativeDir: 'sys' });
registerArg('M470', 'P');
registerArg('M471', 'S');
registerArg('M471', 'T');
registerArg('M472', 'P');
registerArg('M505', 'P', { defaultRelativeDir: 'sys' });
registerArg('M505.1', 'P', { defaultRelativeDir: 'www' });
registerArg('M929', 'P');
registerArg('M956', 'F', { defaultRelativeDir: 'sys/accelerometer' });
registerArg('M997', 'P', { defaultRelativeDir: 'firmware' });

registerTail('M23', { defaultRelativeDir: 'gcodes' });
registerTail('M28', { defaultRelativeDir: 'gcodes' });
registerTail('M30', { defaultRelativeDir: 'gcodes' });
registerTail('M32', { defaultRelativeDir: 'gcodes' });
registerTail('M36', { defaultRelativeDir: 'gcodes' });
registerTail('M38', { defaultRelativeDir: 'gcodes' });

// Built-in expression functions whose FIRST string argument is a filesystem
// path: fileexists("path") and fileread("path", skip, count, sep).  Unlike the
// command tables above, these can appear anywhere an expression is valid —
// `echo`, `if`, `var … = …`, `set`, or inside a `{ … }` block on a G-code line
// — so they are matched independently of any leading G/M/T command.  The
// per-function resolve rules (fileexists → /sys, fileread → SD root) live in
// pathFunctions.ts, shared with argValidators and pathDefinition.

/**
 * Returns the StringLit token whose interior contains `character`, plus the
 * already-typed prefix. Returns null unless the string is in a known RRF path
 * position.
 */
export function findPathStringContext(
    tokens: Token[],
    character: number,
    lineText = '',
): StringContext | null {
    const commandName = commandNameFromTokens(tokens);

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.type !== TokenType.StringLit) continue;
        if (!isInsideString(tok, character)) continue;

        const typedPrefix = typedPrefixAt(tok, character);

        // Function path argument: fileexists("..."), fileread("...", ...).
        // Works on any line, so it is checked before the command-only rules.
        const fnRule = functionPathRule(tokens, i);
        if (fnRule) {
            return { tok, typedPrefix, resolve: fnRule.resolve };
        }

        // Everything below requires a leading G/M/T command.
        if (!commandName) return null;

        // Lettered path argument: M98 P"...", M471 S"...", etc.
        const prev = i > 0 ? tokens[i - 1] : null;
        if (prev?.type === TokenType.GCodeWord) {
            const rule = ARG_PATH_RULES.get(commandName)?.get(prev.value.toUpperCase());
            if (!rule) return null;
            return { tok, typedPrefix, resolve: rule.resolve };
        }

        // Quoted legacy tail path: M36 "...", M32 "...", etc.
        const tailRule = TAIL_PATH_RULES.get(commandName);
        if (tailRule && lineText) {
            const tail = quotedTailStringRange(tokens, lineText);
            if (tail && tail.start <= character && character <= tail.end && tail.start === tok.start) {
                return { tok, typedPrefix, resolve: tailRule.resolve };
            }
        }

        return null;
    }
    return null;
}

/**
 * Returns the path rule when the StringLit at `strIdx` is the first argument
 * of a path-taking function call, i.e. the token sequence is `FunctionName ( "…"`
 * where the function is `fileread`/`fileexists`.  Only the first argument is a
 * path, so this deliberately checks that the string immediately follows the `(`.
 */
export function functionPathRule(tokens: Token[], strIdx: number): PathFunctionRule | null {
    const lparen = strIdx >= 1 ? tokens[strIdx - 1] : null;
    const fn = strIdx >= 2 ? tokens[strIdx - 2] : null;
    if (!lparen || lparen.type !== TokenType.LParen) return null;
    if (!fn || fn.type !== TokenType.FunctionName) return null;
    return PATH_FUNCTIONS.get(fn.value.toLowerCase()) ?? null;
}

function commandNameFromTokens(tokens: Token[]): string | null {
    const head = tokens[0];
    if (!head) return null;
    if (head.type !== TokenType.GCode && head.type !== TokenType.TCode) return null;
    return head.value.toUpperCase();
}

function isInsideString(tok: Token, character: number): boolean {
    return tok.unclosed
        ? (character > tok.start && character <= tok.end)
        : (character > tok.start && character < tok.end);
}

function typedPrefixAt(tok: Token, character: number): string {
    const beforeCursor = character - tok.start;
    return tok.value.slice(1, Math.max(1, beforeCursor));
}

function quotedTailStringRange(tokens: Token[], lineText: string): { start: number; end: number } | null {
    const head = tokens[0];
    if (!head || head.type !== TokenType.GCode) return null;

    const comment = tokens.find(t => t.type === TokenType.Comment);
    const endLimit = comment ? comment.start : lineText.length;
    const rawTail = lineText.slice(head.end, endLimit);
    const leading = rawTail.match(/^\s*/)?.[0].length ?? 0;
    const start = head.end + leading;
    if (start >= endLimit || lineText[start] !== '"') return null;

    let i = start + 1;
    while (i < endLimit) {
        if (lineText[i] === '"') {
            if (i + 1 < endLimit && lineText[i + 1] === '"') {
                i += 2;
                continue;
            }
            return { start, end: i + 1 };
        }
        i++;
    }

    // Unclosed quoted string: completion should still work at end of line.
    return { start, end: endLimit };
}

// ── Path-prefix resolution ───────────────────────────────────────────────────

export interface ResolvedDir {
    dir: string;
    baseFilter: string;
}

/**
 * Convert a typed RRF path prefix into the filesystem directory to list.
 *
 * Unlike generic filesystem completion, relative paths may have a command-
 * specific base directory. For M98 this is /sys, including relative paths that
 * contain slashes.
 */
export function resolvePathPrefix(
    rrfPath: string,
    sdRoot: string,
    options: PathResolveOptions = {},
): ResolvedDir | null {
    if (!sdRoot) return null;
    if (/\0|\r|\n/.test(rrfPath)) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rrfPath)) return null;
    if (rrfPath.includes('\\')) return null;

    let rest = rrfPath;
    const volMatch = /^\d+:\/?/.exec(rest);
    const hasVolume = !!volMatch;
    if (volMatch) rest = rest.slice(volMatch[0].length);

    const isAbsolute = hasVolume || rest.startsWith('/');
    rest = rest.replace(/^\/+/, '');

    let dirPart: string;
    let baseFilter: string;
    const lastSlash = rest.lastIndexOf('/');
    if (lastSlash === -1) {
        dirPart = '';
        baseFilter = rest;
    } else {
        dirPart = rest.slice(0, lastSlash);
        baseFilter = rest.slice(lastSlash + 1);
    }

    const relativeBase = options.defaultRelativeDir ?? options.defaultBareDir;
    const baseDir = !isAbsolute && relativeBase ? path.join(sdRoot, relativeBase) : sdRoot;
    const dir = dirPart ? path.join(baseDir, dirPart) : baseDir;
    return { dir, baseFilter };
}

// ── Listing → CompletionItems ─────────────────────────────────────────────────

export function listDirAsCompletions(dir: string): CompletionItem[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const items: CompletionItem[] = [];
    for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;

        const isDir = e.isDirectory();
        const label = isDir ? e.name + '/' : e.name;
        items.push({
            label,
            kind: isDir ? CompletionItemKind.Folder : CompletionItemKind.File,
            filterText: label,
            insertText: label,
            sortText: (isDir ? '0_' : '1_') + e.name.toLowerCase(),
        });
    }
    return items;
}

// ── Top-level entry point ─────────────────────────────────────────────────────

export function buildPathCompletions(
    typedPrefix: string,
    currentFileUri: string,
    resolve: PathResolveOptions = {},
): CompletionItem[] | null {
    let fsPath: string;
    try {
        fsPath = URI.parse(currentFileUri).fsPath;
    } catch {
        return null;
    }

    const sdRoot = findSdRoot(path.dirname(fsPath));
    if (!sdRoot) return null;

    const resolved = resolvePathPrefix(typedPrefix, sdRoot, resolve);
    if (!resolved) return null;

    return listDirAsCompletions(resolved.dir);
}
