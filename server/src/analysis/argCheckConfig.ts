// analysis/argCheckConfig.ts
//
// Configuration model for the argument-validation subsystem and helpers for
// matching ignore globs.
//
// Defaults are returned when the LSP client cannot supply settings (some
// clients don't implement `workspace/configuration`).  The shape mirrors the
// VS Code settings exactly, so reading user config is a one-line spread.
//
// Ignore patterns are stored relative to the SD-card root, never absolute.
// That makes the project portable — a `.vscode/settings.json` checked into
// version control still resolves correctly on another machine.

import * as path from 'path';

/** Top-level config block as the LSP client returns it. */
export interface ArgCheckConfig {
    /** Master switch — false disables ALL argument checking. */
    enabled: boolean;
    /** Sub-checker: file-path existence. */
    paths: {
        enabled: boolean;
        /**
         * Glob patterns (forward slashes) relative to the SD root.  Examples:
         *   "macros/legacy/*.g"     — explicit list of files
         *   "gcodes/**"              — entire directory tree
         *   "sys/generated.g"        — single file
         * A literal path with no glob characters matches exactly that file.
         */
        ignore: string[];
    };
}

/** Default configuration — all checks on, no ignores. */
export function defaultArgCheckConfig(): ArgCheckConfig {
    return { enabled: true, paths: { enabled: true, ignore: [] } };
}

/**
 * Normalise whatever the LSP client returned into a guaranteed-valid
 * ArgCheckConfig.  Missing fields fall back to defaults so a partial config
 * (e.g. user set only `enabled: false`) still produces a sane object.
 */
export function normaliseArgCheckConfig(raw: any): ArgCheckConfig {
    const d = defaultArgCheckConfig();
    if (!raw || typeof raw !== 'object') return d;
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
        paths: {
            enabled: typeof raw.paths?.enabled === 'boolean' ? raw.paths.enabled : d.paths.enabled,
            ignore: Array.isArray(raw.paths?.ignore)
                ? raw.paths.ignore.filter((x: any) => typeof x === 'string')
                : d.paths.ignore,
        },
    };
}

// ── Glob matching ────────────────────────────────────────────────────────────
//
// A minimal portable matcher: enough to support the patterns we generate and
// the kind users will hand-write.  Supports:
//   *       any number of chars except `/`
//   **      any number of path segments (including zero)
//   ?       a single char except `/`
//   [abc]   one of a set of chars
//   {a,b}   alternation
//
// Anything more elaborate (extglobs, negation) is out of scope; users with
// complex needs can list paths explicitly.

/**
 * Convert one glob pattern into an anchored RegExp.  Caches the compiled
 * RegExp per pattern because we may test the same pattern against thousands
 * of paths during a workspace scan.
 */
const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
    const cached = globCache.get(glob);
    if (cached) return cached;

    let re = '';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];

        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**` — any number of path segments, possibly with slashes.
                re += '.*';
                i += 2;
                if (glob[i] === '/') i++;     // consume the slash after `**/`
            } else {
                re += '[^/]*';
                i++;
            }
        } else if (c === '?') {
            re += '[^/]';
            i++;
        } else if (c === '{') {
            // `{a,b,c}` → `(a|b|c)` (no nesting support)
            const end = glob.indexOf('}', i);
            if (end === -1) { re += '\\{'; i++; continue; }
            const parts = glob.slice(i + 1, end).split(',').map(escapeRe);
            re += '(' + parts.join('|') + ')';
            i = end + 1;
        } else if (c === '[') {
            // `[abc]` → `[abc]` (character class — pass through, escape `]`)
            const end = glob.indexOf(']', i);
            if (end === -1) { re += '\\['; i++; continue; }
            re += '[' + glob.slice(i + 1, end) + ']';
            i = end + 1;
        } else {
            re += escapeRe(c);
            i++;
        }
    }
    const compiled = new RegExp('^' + re + '$');
    globCache.set(glob, compiled);
    return compiled;
}

function escapeRe(s: string): string {
    return s.replace(/[.+^$()|\\]/g, '\\$&');
}

/**
 * True if `relativePath` (SD-root-relative, forward slashes, no leading "/")
 * matches at least one glob in `patterns`.
 */
export function isPathIgnored(relativePath: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    for (const p of patterns) {
        if (globToRegExp(p).test(relativePath)) return true;
    }
    return false;
}

// ── Helpers for code actions ─────────────────────────────────────────────────

/**
 * Build a portable ignore pattern for a given file (relative to SD root).
 * Used by the "Ignore this file" quick fix — the result goes into
 * `rrfgcode.argCheck.paths.ignore`.
 *
 * The caller is responsible for ensuring `absPath` lives under `sdRoot`.
 */
export function makeIgnorePatternForFile(absPath: string, sdRoot: string): string {
    return path.relative(sdRoot, absPath).split(path.sep).join('/');
}

/**
 * Build a portable ignore pattern for a directory (relative to SD root, with
 * a trailing `/**` so the whole subtree is covered).
 */
export function makeIgnorePatternForDir(absDir: string, sdRoot: string): string {
    const rel = path.relative(sdRoot, absDir).split(path.sep).join('/');
    return rel ? `${rel}/**` : '**';
}
