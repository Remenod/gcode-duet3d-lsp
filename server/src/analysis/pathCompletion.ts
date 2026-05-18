// analysis/pathCompletion.ts
//
// File-path completion for string literals in RRF G-code, mirroring the
// behaviour of `#include "..."` in C/C++ editors.
//
// RepRapFirmware addresses files on the SD card using either:
//   • Volume-prefixed absolute path:  "0:/sys/config.g"   (volume 0 = main SD)
//   • Plain absolute path:            "/sys/config.g"     (defaults to vol. 0)
//   • Bare filename:                  "config.g"          (resolved in /sys/)
//
// On the user's workstation the SD-card root is mirrored as a project
// directory containing the standard top-level folders (sys, macros, gcodes,
// www, menu, firmware).  This module:
//
//   1. Detects whether the cursor is inside a string-literal token that
//      appears as the value of a G-code word (M98 P"…", M28 "…", etc.).
//   2. Locates the SD-card root on disk by walking up from the active file
//      until a directory that looks like an RRF SD root is found.
//   3. Resolves the typed prefix to a directory and lists its contents,
//      returning them as CompletionItems.

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';

// ── SD-root detection ─────────────────────────────────────────────────────────

/**
 * Top-level directory names a real RRF SD card always contains some subset of.
 * If at least one of these exists as a child directory, we treat the parent
 * as the SD root.
 *
 * Reference: docs.duet3d.com/User_manual/RepRapFirmware/SD_card
 */
const SD_ROOT_MARKERS = new Set(['sys', 'macros', 'gcodes', 'www', 'menu', 'firmware']);

/**
 * Walk upward from `startDir` until a directory containing at least one
 * SD_ROOT_MARKERS child is found.  Returns `null` if none found before the
 * filesystem root.
 */
export function findSdRoot(startDir: string): string | null {
    let dir = startDir;
    let prev = '';
    while (dir !== prev) {
        if (hasAnySdMarker(dir)) return dir;
        prev = dir;
        dir = path.dirname(dir);
    }
    return null;
}

function hasAnySdMarker(dir: string): boolean {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    for (const e of entries) {
        if (e.isDirectory() && SD_ROOT_MARKERS.has(e.name.toLowerCase())) return true;
    }
    return false;
}

// ── String-literal context detection ──────────────────────────────────────────

export interface StringContext {
    /** The StringLit token the cursor is inside. */
    tok: Token;
    /** Substring between the opening `"` and the cursor (the path so far). */
    typedPrefix: string;
}

/**
 * Returns the StringLit token whose interior contains `character`, plus the
 * already-typed prefix (everything between the opening quote and the cursor).
 * Returns null if the cursor is not inside a string literal value, or if the
 * string is not in a position where path completion makes sense.
 *
 * Position rules:
 *   • Cursor MUST be strictly inside the quotes (not on a quote character),
 *     UNLESS the string is unclosed — then cursor == end is also valid (the
 *     user is in the middle of typing the literal).
 *   • The string MUST be the value of a G-code parameter word — i.e. the
 *     previous non-whitespace token is a GCodeWord.  This prevents path
 *     completion from triggering inside `echo "hello"`, `var s = "x"`, etc.
 */
export function findPathStringContext(
    tokens: Token[],
    character: number,
): StringContext | null {
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.type !== TokenType.StringLit) continue;

        // Inside the quotes: strictly between for closed strings; up to and
        // including end-of-token for unclosed strings (still being typed).
        const inside = tok.unclosed
            ? (character > tok.start && character <= tok.end)
            : (character > tok.start && character < tok.end);
        if (!inside) continue;

        // Must follow a G-code parameter letter (M98 P"…", M28 "…", …)
        const prev = i > 0 ? tokens[i - 1] : null;
        if (prev?.type !== TokenType.GCodeWord) return null;

        // typedPrefix is everything from after the opening " up to the cursor.
        // The opening " is at tok.start; the actual text content starts at start+1.
        const beforeCursor = character - tok.start;
        const typedPrefix = tok.value.slice(1, Math.max(1, beforeCursor));

        return { tok, typedPrefix };
    }
    return null;
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Convert an RRF path string into a filesystem path under `sdRoot`.
 *
 * RRF accepts:
 *   "0:/sys/config.g"    → <sdRoot>/sys/config.g  (volume 0)
 *   "/sys/config.g"      → <sdRoot>/sys/config.g  (implicit volume 0)
 *   "sys/config.g"       → <sdRoot>/sys/config.g  (also implicit; some boards)
 *   "config.g"           → <sdRoot>/sys/config.g  (RRF resolves bare names in /sys/)
 *
 * For COMPLETION we resolve only the directory part of `rrfPath` and ignore
 * the basename — the basename is the filter the user is typing.  The caller
 * passes the typed prefix; we return:
 *   • dir  — absolute filesystem directory to list
 *   • baseFilter — what the user has typed for the basename (used to filter)
 *
 * Returns null only when sdRoot is missing.
 */
export interface ResolvedDir {
    dir: string;
    baseFilter: string;
}

export function resolvePathPrefix(rrfPath: string, sdRoot: string): ResolvedDir | null {
    if (!sdRoot) return null;

    // Strip volume prefix:  "N:/..."  →  "/..."  (any digit accepted)
    let rest = rrfPath;
    const volMatch = /^\d+:\/?/.exec(rest);
    if (volMatch) rest = rest.slice(volMatch[0].length);

    // Strip leading "/" if present
    rest = rest.replace(/^\/+/, '');

    // Split into directory part and the basename the user is typing.
    // If the prefix ends with "/", the user has just opened a directory and
    // baseFilter is empty.
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

    const dir = dirPart ? path.join(sdRoot, dirPart) : sdRoot;
    return { dir, baseFilter };
}

// ── Listing → CompletionItems ─────────────────────────────────────────────────

/**
 * List entries in `dir` and emit completion items.  Filenames are returned
 * as-is; directories get a trailing "/" appended to insertText so the user
 * can keep typing.  Hidden files and node_modules are skipped.
 *
 * The LSP client filters by `filterText`, so we set it to the basename only;
 * the editor will match it against the basename the user is currently typing.
 */
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
            // Sort directories first by prefixing their sort key with "0_".
            sortText: (isDir ? '0_' : '1_') + e.name.toLowerCase(),
        });
    }
    return items;
}

// ── Top-level entry point ─────────────────────────────────────────────────────

/**
 * Resolve `typedPrefix` to disk under the SD root of `currentFileUri`, and
 * return a completion list.  Returns null when no SD root can be located —
 * the caller should fall through to normal completions.
 */
export function buildPathCompletions(
    typedPrefix: string,
    currentFileUri: string,
): CompletionItem[] | null {
    let fsPath: string;
    try {
        fsPath = URI.parse(currentFileUri).fsPath;
    } catch {
        return null;
    }
    const sdRoot = findSdRoot(path.dirname(fsPath));
    if (!sdRoot) return null;

    const resolved = resolvePathPrefix(typedPrefix, sdRoot);
    if (!resolved) return null;

    return listDirAsCompletions(resolved.dir);
}
