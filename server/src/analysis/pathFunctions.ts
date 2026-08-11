// analysis/pathFunctions.ts
//
// Shared registry of built-in expression functions whose FIRST string argument
// is a filesystem path.  Consumed by argValidators (diagnostics), pathCompletion
// (completion inside the string) and pathDefinition (F12 on the string), so the
// three features can never disagree about how a function resolves its path.
//
// Firmware behaviour mirrored here (RRF ExpressionParser.cpp):
//   • fileexists("name")  → Platform::SysFileExists → relative names resolve
//     under the system directory (0:/sys/).  A missing file is NOT an error —
//     testing for a possibly-absent file is the function's whole purpose — so
//     no existence diagnostic is emitted for it.
//   • fileread("name", skip, count, sep) → MassStorage::CombineName with "0:/"
//     → relative names resolve against the SD-card root.  A missing file makes
//     the containing command fail at runtime, so existence IS checked.

export interface PathFunctionRule {
    /** Command-specific base directory for relative paths (see argValidators). */
    resolve?: { defaultRelativeDir?: string; defaultBareDir?: string };
    /** Whether a missing target should produce a diagnostic. */
    checkExistence: boolean;
}

/** Keyed by lower-case function name. */
export const PATH_FUNCTIONS = new Map<string, PathFunctionRule>([
    ['fileexists', { resolve: { defaultRelativeDir: 'sys' }, checkExistence: false }],
    ['fileread', { checkExistence: true }],
]);
