// server.ts — RRF G-code / meta-command LSP server

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  HoverParams,
  Hover,
  MarkupKind,
  CompletionParams,
  CompletionItem,
  CompletionItemKind,
  SignatureHelpParams,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  DiagnosticSeverity,
  Diagnostic,
  SemanticTokensParams,
  SemanticTokens,
  SemanticTokensBuilder,
  TextDocumentChangeEvent,
  DefinitionParams,
  Location,
  Range,
  RenameParams,
  PrepareRenameParams,
  ReferenceParams,
  ResponseError,
  WorkspaceEdit,
  TextEdit,
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  ExecuteCommandParams,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesParams,
  FileChangeType,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import * as jsonc from 'jsonc-parser';

import { Lexer } from './parser/lexer';
import {
  Token, TokenType,
  NAMED_CONSTANTS,
  SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS,
} from './parser/types';
import { validateLine, DiagnosticContext } from './parser/expression';
import { SymbolTable } from './analysis/symbolTable';
import { buildHover } from './analysis/hover';
import { isValidOmPath, isOmIndexAvailable, allOmPaths } from './analysis/objectModelIndex';
import { buildRenameEdit } from './analysis/rename';
import { buildReferences } from './analysis/references';
import { findPathStringContext, buildPathCompletions } from './analysis/pathCompletion';
import {
  validateGCodeArgs, validateFunctionPathArgs, getSdRootForUri, invalidateSdRootCache,
} from './analysis/argValidators';
import {
  ArgCheckConfig, defaultArgCheckConfig, normaliseArgCheckConfig,
} from './analysis/argCheckConfig';
import {
  buildCodeActions, CMD_ADD_PATH_IGNORE, CMD_SET_MAX_LINE_LENGTH, LINE_TOO_LONG_CODE,
} from './analysis/codeActions';
import { pathLocationAtCursor } from './analysis/pathDefinition';
import { lineIndent, findTokenAtChar } from './analysis/utils';

// ── Connection setup ──────────────────────────────────────────────────────────
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);
const symbolTable = new SymbolTable();

// ── Load JSON data files ──────────────────────────────────────────────────────
interface GCodeDoc { title: string; description: string; anchor: string }
type DocDB = Record<string, GCodeDoc>;

// Extended interface for gcode-functions.json entries which may carry
// structured parameter info (used for completion detail and signature help).
interface FunctionParam { name: string; type?: string; doc?: string }
interface FunctionDoc extends GCodeDoc {
  syntax?: string;          // e.g. "abs(value) → numeric"
  returnType?: string;      // e.g. "numeric"
  params?: FunctionParam[];
  minArgs?: number;
  maxArgs?: number;
}

function loadJson<T>(relPath: string, label: string): T {
  const absPath = path.join(__dirname, relPath);
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8')) as T;
  } catch (e) {
    connection.console.error(`Failed to load ${label}: ${e}`);
    return {} as T;
  }
}

const gcodeData: DocDB = loadJson('../data/gcode-commands.json', 'G-code dictionary');
const metaData: DocDB = loadJson('../data/gcode-meta-commands.json', 'meta-commands dictionary');
const operatorsData: DocDB = loadJson('../data/gcode-operators.json', 'operators dictionary');
const functionsData: DocDB = loadJson('../data/gcode-functions.json', 'functions dictionary');

// ── File detection ─────────────────────────────────────────────────────────────
//
// Compared case-insensitively (extensions are lower-cased before lookup) and
// aligned with the language registration in package.json (.g/.gcode/.gc/.gco).
const RRF_EXTENSIONS = new Set(['.g', '.gcode', '.gc', '.gco', '.macro', '.cfg']);

// Extensions that other ecosystems use too (e.g. Klipper's printer.cfg), so a
// file only counts as RRF G-code when its content also looks like it.
const SNIFFED_EXTENSIONS = new Set(['.cfg', '.macro']);

/**
 * Returns true if `text` looks like RRF G-code / meta-command content.
 *
 * Used to classify files without a registered extension (e.g. `homedelta`,
 * `bed.g.bak`, or completely extensionless macros dropped in sys/).
 *
 * Heuristic: sample the first 30 non-blank lines; if ≥ 20 % of them start
 * with a recognisable G-code or meta-command pattern we treat the file as
 * RRF G-code.
 */
function looksLikeGCode(text: string): boolean {
  const checked = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .slice(0, 30);

  if (checked.length === 0) return false;

  let hits = 0;
  for (const line of checked) {
    if (/^;/.test(line)) { hits++; continue; }                         // comment
    if (/^[GMTgmt]\d/.test(line)) { hits++; continue; }                // G/M/T code
    if (/^(var|global|set|if|elif|else|while|break|continue|abort|param|echo|skip)\b/i
      .test(line)) { hits++; continue; }                               // meta command
  }

  return hits >= Math.max(2, Math.floor(checked.length * 0.2));
}

// ── Initialize ────────────────────────────────────────────────────────────────
connection.onInitialize((_params: InitializeParams): InitializeResult => {
  connection.console.log('RRF LSP initializing…');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      completionProvider: {
        resolveProvider: false,
        // '/' and '"' trigger path completion inside string literals;
        // '.', ' ', '(', '{' trigger normal language completions.
        triggerCharacters: ['.', ' ', '(', '{', '"', '/'],
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
      },
      renameProvider: {
        prepareProvider: true
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: SEMANTIC_TOKEN_TYPES,
          tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
        },
        full: true,
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
      executeCommandProvider: {
        commands: [CMD_ADD_PATH_IGNORE, CMD_SET_MAX_LINE_LENGTH],
      },
    },
  };
});

connection.onInitialized(async () => {
  connection.console.log('RRF LSP ready.');

  // Subscribe to dynamic configuration changes — the client will push
  // workspace/didChangeConfiguration notifications when the user edits
  // the relevant section of settings.json.
  try {
    await connection.client.register(DidChangeConfigurationNotification.type, undefined);
  } catch {
    // Clients without dynamic registration capability fall back to static
    // defaults — that's fine, validators still run.
  }

  // Load user settings BEFORE the background scan, otherwise diagnostics for
  // up to MAX_BACKGROUND_DIAGNOSTICS closed files are computed from defaults
  // and contradict the user's configuration until each file is reopened.
  await refreshConfig();

  try {
    const folders = await connection.workspace.getWorkspaceFolders();
    if (folders) {
      for (const folder of folders) {
        scanDirectoryForGlobals(URI.parse(folder.uri).fsPath);
      }
    }
  } catch (e) {
    connection.console.warn(`RRF LSP: workspace scan failed: ${e}`);
  }
});

// ── Configuration ────────────────────────────────────────────────────────────
//
// We cache the latest config so each diagnostic line doesn't trigger a
// configuration round-trip.  The cache is invalidated on
// didChangeConfiguration; we then re-publish diagnostics for every open
// document.

// Maximum G-code command length (in UTF-8 bytes) before a diagnostic is raised.
// RepRapFirmware's input buffer (MaxGCodeLength = 256, including the null
// terminator) holds at most 255 command bytes; longer commands fail with
// "GCode command too long".  Only the command part counts: leading whitespace,
// N line numbers, *checksums and ;-comments are never stored by the firmware.
// A value of 0 disables the check.
const DEFAULT_MAX_LINE_LENGTH = 255;

let argCheckConfig: ArgCheckConfig = defaultArgCheckConfig();
let maxLineLength = DEFAULT_MAX_LINE_LENGTH;
let configLoaded = false;

function normaliseMaxLineLength(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_MAX_LINE_LENGTH;
}

async function refreshConfig(): Promise<void> {
  try {
    const [argRaw, maxRaw] = await Promise.all([
      connection.workspace.getConfiguration('rrfgcode.argCheck'),
      connection.workspace.getConfiguration('rrfgcode.maxLineLength'),
    ]);
    argCheckConfig = normaliseArgCheckConfig(argRaw);
    maxLineLength = normaliseMaxLineLength(maxRaw);
  } catch {
    argCheckConfig = defaultArgCheckConfig();
    maxLineLength = DEFAULT_MAX_LINE_LENGTH;
  }
  configLoaded = true;
}

connection.onDidChangeConfiguration(async () => {
  await refreshConfig();
  // Re-publish diagnostics for every open document so warnings appear /
  // disappear immediately when the user toggles a setting.
  for (const doc of documents.all()) {
    publishDiagnostics(doc);
  }
  // Closed files that got diagnostics from the background scan (or after
  // being closed) must be recomputed too, otherwise the Problems panel keeps
  // entries produced with the old settings until each file is reopened.
  for (const uri of backgroundDiagnosticUris) {
    if (documents.get(uri)) continue;
    try {
      publishDiagnosticsForText(uri, fs.readFileSync(URI.parse(uri).fsPath, 'utf8'));
    } catch {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }
});

// ── Workspace directory scanner ────────────────────────────────────────────────
//
// TWO-PASS APPROACH (fixes stale diagnostics on global references):
//   Pass 1 — index every RRF file so the symbol table knows all globals.
//   Pass 2 — publish diagnostics once all declarations are known.
//
// The old single-pass approach published diagnostics for file A before
// indexing file B which declares global.x, leaving a false warning on A.

// A cap of MAX_BACKGROUND_DIAGNOSTICS prevents the initial scan from taking
// too long on very large repositories.
const MAX_BACKGROUND_DIAGNOSTICS = 1000;
let backgroundDiagnosticsPublished = 0;

// URIs of non-open files whose diagnostics we have published (background scan,
// closed documents, watched-file events).  Config changes re-publish these so
// their diagnostics never go stale relative to the user's settings.
const backgroundDiagnosticUris = new Set<string>();

/** Collect all RRF files under `dir` that are not already open. */
function collectRrfFiles(dir: string): Array<{ uri: string; content: string }> {
  const results: Array<{ uri: string; content: string }> = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRrfFiles(fullPath));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    const noExt = ext === '';

    // Skip files with non-RRF extensions
    if (!noExt && !RRF_EXTENSIONS.has(ext)) continue;

    const fileUri = URI.file(fullPath).toString();

    // Already tracked by the documents manager (file is open) — skip;
    // the open document's diagnostics are handled via onDidOpen / onDidChangeContent.
    if (documents.get(fileUri)) continue;

    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    // Extensionless and shared-extension files (.cfg/.macro) must also LOOK
    // like RRF G-code, so e.g. a Klipper printer.cfg is not indexed.
    if ((noExt || SNIFFED_EXTENSIONS.has(ext)) && !looksLikeGCode(content)) continue;

    results.push({ uri: fileUri, content });
  }
  return results;
}

function scanDirectoryForGlobals(dir: string): void {
  const files = collectRrfFiles(dir);

  // Pass 1: index every file so all globals/vars are in the symbol table.
  for (const { uri, content } of files) {
    symbolTable.indexDocument(uri, content);
  }

  // Pass 2: now that all declarations are known, publish accurate diagnostics.
  for (const { uri, content } of files) {
    if (backgroundDiagnosticsPublished >= MAX_BACKGROUND_DIAGNOSTICS) break;
    backgroundDiagnosticsPublished++;
    backgroundDiagnosticUris.add(uri);
    publishDiagnosticsForText(uri, content);
  }
}

// ── Document lifecycle ────────────────────────────────────────────────────────
documents.onDidOpen(e => onDocumentChange(e.document));
documents.onDidChangeContent(e => onDocumentChange(e.document));
documents.onDidClose((e: TextDocumentChangeEvent<TextDocument>) => {
  const filePath = URI.parse(e.document.uri).fsPath;
  try {
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8');
      symbolTable.indexDocument(e.document.uri, text);
      // Re-publish diagnostics from the saved file so the Problems panel stays
      // accurate even after the editor tab is closed.
      backgroundDiagnosticUris.add(e.document.uri);
      publishDiagnosticsForText(e.document.uri, text);
    } else {
      symbolTable.removeDocument(e.document.uri);
      connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
    }
  } catch {
    symbolTable.removeDocument(e.document.uri);
  }
});

// ── Watched-file events ───────────────────────────────────────────────────────
//
// The client watches workspace RRF files (see synchronize.fileEvents in
// client/src/extension.ts).  Reacting here keeps three things fresh without a
// server restart:
//   • the symbol table / diagnostics for files edited outside VS Code,
//   • path-existence diagnostics in open documents (a referenced file may have
//     just been created or deleted),
//   • the per-document SD-root cache — e.g. sys/config.g appearing for the
//     first time turns a plain folder into a detectable SD-card mirror.
connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
  for (const change of params.changes) {
    const uri = change.uri;
    // Open documents are authoritative; their buffer already drives the index.
    if (documents.get(uri)) continue;

    if (change.type === FileChangeType.Deleted) {
      symbolTable.removeDocument(uri);
      backgroundDiagnosticUris.delete(uri);
      connection.sendDiagnostics({ uri, diagnostics: [] });
      continue;
    }

    // Created / Changed: (re-)index from disk, with the same content sniffing
    // as the startup scan for shared extensions.
    try {
      const fsPath = URI.parse(uri).fsPath;
      const ext = path.extname(fsPath).toLowerCase();
      const content = fs.readFileSync(fsPath, 'utf8');
      if ((ext === '' || SNIFFED_EXTENSIONS.has(ext)) && !looksLikeGCode(content)) continue;
      symbolTable.indexDocument(uri, content);
      backgroundDiagnosticUris.add(uri);
      publishDiagnosticsForText(uri, content);
    } catch { /* unreadable — skip */ }
  }

  // Any file event can change SD-root detection; the cache repopulates lazily.
  invalidateSdRootCache();

  // Path-existence warnings in open documents may refer to the files that just
  // changed, so refresh what the user is looking at.
  for (const doc of documents.all()) publishDiagnostics(doc);
});

function onDocumentChange(doc: TextDocument): void {
  symbolTable.indexDocument(doc.uri, doc.getText());
  // Lazy first-load of config so diagnostics on the very first opened
  // document reflect user settings, not just defaults.  Subsequent changes
  // are pushed by didChangeConfiguration.
  if (!configLoaded) {
    refreshConfig().then(() => publishDiagnostics(doc));
  } else {
    publishDiagnostics(doc);
  }
}

// ── All-docs helper ───────────────────────────────────────────────────────────
//
// Builds a uri→text map covering every file the server knows about:
//   1. Open documents (in-memory, authoritative).
//   2. Files indexed at startup that are not currently open (read from disk).
//
// Used by rename and references so they can search the whole workspace.

function getAllDocTexts(): Map<string, string> {
  const map = new Map<string, string>();

  // Open documents are most up-to-date.
  for (const doc of documents.all()) {
    map.set(doc.uri, doc.getText());
  }

  // Closed files that were scanned at startup.
  for (const uri of symbolTable.getAllIndexedUris()) {
    if (map.has(uri)) continue;
    try {
      map.set(uri, fs.readFileSync(URI.parse(uri).fsPath, 'utf8'));
    } catch { /* file may have been deleted — skip */ }
  }

  return map;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

interface CommandPart { text: string; start: number; end: number }

/**
 * Extract the part of a line that actually lands in the firmware's G-code
 * buffer: strips leading whitespace, an `N<digits>` line number, a trailing
 * `*<digits>` checksum and everything from an unquoted `;` on.  Returns null
 * for blank and comment-only lines.
 */
function commandPartOfLine(lineText: string): CommandPart | null {
  // Comment start: the first ';' outside a "…" string.  A doubled "" escape
  // toggles the string state twice, so the tracking stays correct.
  let inString = false;
  let end = lineText.length;
  for (let i = 0; i < lineText.length; i++) {
    const c = lineText[i];
    if (c === '"') inString = !inString;
    else if (c === ';' && !inString) { end = i; break; }
  }

  let start = 0;
  while (start < end && (lineText[start] === ' ' || lineText[start] === '\t')) start++;

  const lineNumber = /^[Nn]\d+[ \t]*/.exec(lineText.slice(start, end));
  if (lineNumber) start += lineNumber[0].length;

  while (end > start && (lineText[end - 1] === ' ' || lineText[end - 1] === '\t')) end--;
  const checksum = /\*\d+$/.exec(lineText.slice(start, end));
  if (checksum) {
    end -= checksum[0].length;
    while (end > start && (lineText[end - 1] === ' ' || lineText[end - 1] === '\t')) end--;
  }

  if (end <= start) return null;
  return { text: lineText.slice(start, end), start, end };
}

/** Publish diagnostics for an open TextDocument. */
function publishDiagnostics(doc: TextDocument): void {
  publishDiagnosticsForText(doc.uri, doc.getText());
}

/**
 * Compute and publish diagnostics for any URI + text pair.
 *
 * Factored out of publishDiagnostics so it can be called for background
 * (non-open) files discovered during the workspace scan.
 */
function publishDiagnosticsForText(uri: string, text: string): void {
  const lines = text.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];

  const omChecker = isOmIndexAvailable() ? isValidOmPath : undefined;

  // Resolve the SD root once per document.  validateGCodeArgs reuses this
  // for every G/M/T line so we don't repeatedly walk the filesystem.
  const sdRoot = getSdRootForUri(uri);

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];

    // Line-length check runs before tokenization so it is reported even for
    // lines that also contain lexer errors.  Only the command part is measured
    // (in UTF-8 bytes, matching the firmware buffer) — comments, indentation,
    // N line numbers and *checksums are excluded because the firmware never
    // stores them.
    if (maxLineLength > 0) {
      const part = commandPartOfLine(lineText);
      const bytes = part ? Buffer.byteLength(part.text, 'utf8') : 0;
      if (part && bytes > maxLineLength) {
        // Column where the byte budget runs out (the range is expressed in
        // UTF-16 columns even though the limit is measured in UTF-8 bytes).
        let overflowCol = part.start;
        let used = 0;
        for (const ch of part.text) {
          used += Buffer.byteLength(ch, 'utf8');
          if (used > maxLineLength) break;
          overflowCol += ch.length;
        }
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: mkRange(i, overflowCol, i, part.end),
          message:
            `Command is ${bytes} bytes long, exceeding rrfgcode.maxLineLength (${maxLineLength}). ` +
            `RepRapFirmware rejects commands longer than its input buffer with "GCode command too long".`,
          source: 'rrf-gcode',
          code: LINE_TOO_LONG_CODE,
          data: { length: bytes, max: maxLineLength },
        });
      }
    }

    const indent = lineIndent(lineText);
    const lexer = new Lexer(lineText, i);
    const tokens = lexer.tokenize();

    for (const e of lexer.errors) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: mkRange(e.line, e.start, e.line, e.end),
        message: e.message,
        source: 'rrf-gcode',
      });
    }

    if (lexer.errors.length > 0) continue;

    const ctx: DiagnosticContext = {
      symbolTable, uri, line: i, indent,
      isValidOmPath: omChecker,
      docLines: lines,
    };

    for (const err of validateLine(tokens, lineText, ctx)) {
      const sev = err.severity === 'warning' ? DiagnosticSeverity.Warning
        : err.severity === 'information' ? DiagnosticSeverity.Information
          : DiagnosticSeverity.Error;
      diagnostics.push({
        severity: sev,
        range: mkRange(err.line, err.start, err.line, err.end),
        message: err.message,
        source: 'rrf-gcode',
      });
    }

    diagnostics.push(...validateGCodeArgs(
      tokens,
      lineText,
      uri,
      sdRoot,
      argCheckConfig,
    ));

    // Path-taking functions (fileexists/fileread) can appear on any line, not
    // just G/M/T command lines, so they are validated separately.
    diagnostics.push(...validateFunctionPathArgs(tokens, sdRoot, argCheckConfig));
  }

  connection.sendDiagnostics({ uri, diagnostics });
}

// ── Hover ─────────────────────────────────────────────────────────────────────
//
// Token types that have no useful hover (G-code parameter words, structural
// punctuation, comments, EOF) simply fall through to `default` in buildHover
// and return null.  No special suppression logic is needed — the lexer's
// GCodeWord type makes the cases self-evident.
connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const line = lines[params.position.line] ?? '';
  const tokens = new Lexer(line, params.position.line).tokenize();

  return buildHover(
    tokens,
    params.position.character,
    params.position.line,
    gcodeData, metaData, operatorsData, functionsData,
    symbolTable,
    params.textDocument.uri,
    lineIndent(line),
    lines,
  );
});

// ── Rename ────────────────────────────────────────────────────────────────────
connection.onPrepareRename((params: PrepareRenameParams): Range | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const lineText = lines[params.position.line] ?? '';
  const tokens = new Lexer(lineText, params.position.line).tokenize();

  const found = findTokenAtChar(tokens, params.position.character);
  if (!found) throw new ResponseError(0, 'No symbol found.');

  const { tok, idx: tokIdx } = found;
  if (tok.type !== TokenType.Identifier) {
    throw new ResponseError(0, 'You can only rename identifiers.');
  }

  const val = tok.value;

  // param variables cannot be renamed — their letter (A–Z) is determined by
  // the G-code word at the call site (e.g. `M98 P"macro.g" Z10`), not by
  // anything inside the macro. Renaming param.Z here would not affect callers.
  if (val.startsWith('param.')) {
    throw new ResponseError(
      0,
      'Macro parameters cannot be renamed — the letter is determined by the G-code word at the call site (e.g. M98 Z10), not inside the macro.',
    );
  }

  const isUsage = val.startsWith('var.') || val.startsWith('global.');
  const prevTok = tokIdx > 0 ? tokens[tokIdx - 1] : null;
  const isDecl = prevTok && (
    prevTok.type === TokenType.Var ||
    prevTok.type === TokenType.Global
    // TokenType.Param intentionally excluded — see above
  );

  if (!isUsage && !isDecl) {
    throw new ResponseError(0, 'You can only rename var or global variables.');
  }

  return Range.create(params.position.line, tok.start, params.position.line, tok.end);
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  return buildRenameEdit(
    params,
    doc.getText(),
    params.textDocument.uri,
    getAllDocTexts(),          // ← globals now searched across all files
  );
});

// ── Find All References (Shift+F12) ───────────────────────────────────────────
connection.onReferences((params: ReferenceParams): Location[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  return buildReferences(
    params,
    doc.getText(),
    params.textDocument.uri,
    getAllDocTexts(),          // ← globals searched across all files
  );
});

// ── Go to Definition ──────────────────────────────────────────────────────────
connection.onDefinition((params: DefinitionParams): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const lineText = lines[params.position.line] ?? '';
  const tokens = new Lexer(lineText, params.position.line).tokenize();
  const indent = lineIndent(lineText);

  // Path inside a G-code parameter string (e.g. M98 P"sys/foo.g") — open the
  // file it points to.  This runs first so it has priority over var/global
  // resolution (the cursor cannot be on both).
  const pathLoc = pathLocationAtCursor(tokens, params.position.character, params.textDocument.uri, lineText);
  if (pathLoc) return pathLoc;

  const tok = tokens.find(t => t.start <= params.position.character && params.position.character < t.end);
  if (!tok || tok.type !== TokenType.Identifier) return null;

  const val = tok.value;
  let decl: { uri: string; line: number; col: number } | undefined;

  if (val.startsWith('var.'))
    decl = symbolTable.lookupVarAtLine(val.slice(4), params.textDocument.uri, params.position.line, indent, lines) ?? undefined;
  else if (val.startsWith('global.'))
    decl = symbolTable.lookupGlobal(val.slice(7)) ?? undefined;
  // param.x: no go-to-definition — the value comes from the G-code word at the
  // M98 call site in a different file, not from a declaration inside this macro.

  if (!decl) return null;

  return Location.create(
    decl.uri,
    Range.create(decl.line, decl.col, decl.line, decl.col + val.length),
  );
});

// ── Code actions (Quick Fix) ──────────────────────────────────────────────────
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  return buildCodeActions(params);
});

// ── Execute Command — addPathIgnore ──────────────────────────────────────────
//
// Backing implementation for the quick-fix.  Strategy:
//
//   1. In VS Code, the language-client extension is expected to intercept
//      this command client-side and call
//        vscode.workspace.getConfiguration('rrfgcode.argCheck.paths')
//              .update('ignore', [...], ConfigurationTarget.Workspace)
//      That's the cleanest path and the resulting settings.json edit happens
//      atomically through the VS Code settings API.
//
//   2. If the command reaches the server anyway (generic LSP client, or the
//      extension hasn't been updated), we fall back to editing
//      `<workspace>/.vscode/settings.json` directly via workspace/applyEdit.
//      That keeps everything portable across machines because the path lives
//      INSIDE the workspace; checking in `.vscode/settings.json` preserves
//      the ignores when the project moves to another developer.
//
// In both cases we optimistically update the in-memory config so the
// diagnostic disappears immediately, then trust the follow-up
// `workspace/didChangeConfiguration` to reconcile.
connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command === CMD_ADD_PATH_IGNORE) {
    const pattern = params.arguments?.[0];
    if (typeof pattern !== 'string' || pattern.length === 0) return;

    await refreshConfig();
    const next = Array.from(new Set([...argCheckConfig.paths.ignore, pattern]));

    // Optimistic local update — diagnostic vanishes right away.
    argCheckConfig = {
      ...argCheckConfig,
      paths: { ...argCheckConfig.paths, ignore: next },
    };
    for (const doc of documents.all()) publishDiagnostics(doc);

    // Best-effort server-side persistence — only used by clients that don't
    // override the command themselves.
    try {
      await persistWorkspaceSetting('rrfgcode.argCheck.paths.ignore', next);
    } catch (e) {
      connection.console.warn(`RRF LSP: could not persist ignore pattern: ${e}`);
    }
    return;
  }

  if (params.command === CMD_SET_MAX_LINE_LENGTH) {
    const value = params.arguments?.[0];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;

    // Optimistic local update, mirroring CMD_ADD_PATH_IGNORE above.
    maxLineLength = Math.floor(value);
    for (const doc of documents.all()) publishDiagnostics(doc);

    try {
      await persistWorkspaceSetting('rrfgcode.maxLineLength', maxLineLength);
    } catch (e) {
      connection.console.warn(`RRF LSP: could not persist maxLineLength: ${e}`);
    }
    return;
  }
});

/**
 * Write one setting into `<workspace>/.vscode/settings.json`.
 *
 * This is the **fallback path** for clients that don't intercept the quick-fix
 * commands client-side.  A VS Code extension SHOULD intercept them and call
 * `vscode.workspace.getConfiguration(...).update(...)`; when it does, this
 * server-side function is never invoked.
 *
 * An existing settings.json is edited surgically with jsonc-parser (the same
 * library VS Code itself uses), so comments, formatting and unrelated keys
 * survive.  Settings files may spell the key flat ("a.b.c") or nested
 * ("a.b": { "c": … }) — the existing spelling is detected and reused.  Only
 * when the file cannot be parsed do we refuse and tell the user, so the
 * optimistic in-memory change is never silently lost.
 */
async function persistWorkspaceSetting(key: string, value: unknown): Promise<void> {
  const folders = await connection.workspace.getWorkspaceFolders();
  if (!folders || folders.length === 0) return;

  const root = URI.parse(folders[0].uri).fsPath;
  const dotVscode = path.join(root, '.vscode');
  const settingsPath = path.join(dotVscode, 'settings.json');

  const warnManualEdit = () => connection.window.showWarningMessage(
    `RRF G-code: could not update .vscode/settings.json automatically — ` +
    `add "${key}": ${JSON.stringify(value)} to it manually to keep this quick fix.`,
  );

  try {
    if (!fs.existsSync(settingsPath)) {
      if (!fs.existsSync(dotVscode)) fs.mkdirSync(dotVscode, { recursive: true });
      const obj = { [key]: value };
      fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 4) + '\n', 'utf8');
      connection.console.info(`RRF LSP: wrote ${settingsPath}`);
      return;
    }

    const text = fs.readFileSync(settingsPath, 'utf8');
    const parseErrors: jsonc.ParseError[] = [];
    const parsed = jsonc.parse(text, parseErrors, { allowTrailingComma: true });
    if (parseErrors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnManualEdit();
      return;
    }

    const edits = jsonc.modify(text, settingJsonPath(parsed, key), value, {
      formattingOptions: { insertSpaces: true, tabSize: 4, eol: '\n' },
    });
    fs.writeFileSync(settingsPath, jsonc.applyEdits(text, edits), 'utf8');
    connection.console.info(`RRF LSP: updated ${settingsPath}`);
  } catch (e) {
    connection.console.warn(`RRF LSP: failed to write settings.json: ${e}`);
    warnManualEdit();
  }
}

/**
 * Find the JSON path under which a dotted setting key should be written in
 * this particular settings object.  VS Code accepts both the flat spelling
 * ("rrfgcode.argCheck.paths.ignore": …) and partially nested ones
 * ("rrfgcode.argCheck": { "paths": { "ignore": … } }); writing a second
 * spelling alongside an existing one would leave two competing entries, so
 * the file's current shape wins.  Falls back to the flat key.
 */
function settingJsonPath(parsed: Record<string, unknown>, key: string): jsonc.JSONPath {
  const segments = key.split('.');

  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  // Prefer a spelling whose leaf already exists.
  for (let i = segments.length; i >= 1; i--) {
    const head = segments.slice(0, i).join('.');
    if (!(head in parsed)) continue;
    let node: unknown = parsed[head];
    let ok = true;
    for (const seg of segments.slice(i)) {
      if (isObj(node) && seg in node) node = node[seg];
      else { ok = false; break; }
    }
    if (ok) return [head, ...segments.slice(i)];
  }

  // Otherwise nest under the deepest existing prefix object.
  for (let i = segments.length - 1; i >= 1; i--) {
    const head = segments.slice(0, i).join('.');
    if (head in parsed && isObj(parsed[head])) {
      return [head, ...segments.slice(i)];
    }
  }

  return [key];
}

// ── Completions ───────────────────────────────────────────────────────────────
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  const line = lines[params.position.line] ?? '';
  const prefix = line.slice(0, params.position.character);

  const lineTokens = new Lexer(line, params.position.line).tokenize();

  // ── Path completion inside a G-code parameter string ────────────────────
  //
  // When the cursor sits inside the string literal that follows a G-code
  // word — typically `M98 P"…"`, `M28 "…"`, etc. — offer SD-card filesystem
  // entries instead of normal language completions.  Triggers on any prefix
  // (`"`, `"0`, `"0:/sys/`, `"config.`); the LSP client filters by basename.
  {
    const ctx = findPathStringContext(lineTokens, params.position.character, line);
    if (ctx) {
      const items = buildPathCompletions(ctx.typedPrefix, params.textDocument.uri, ctx.resolve);
      // Return [] (empty list, completion *handled*) rather than fall through —
      // we don't want G-code/keyword completions polluting a path context.
      return items ?? [];
    }
  }

  // ── No completions in prose ──────────────────────────────────────────────
  //
  // Inside a comment or a non-path string literal (M291 messages, WiFi
  // passwords, machine names) every completion below is noise — typing
  // `; TODO check global.` must not pop up the variable list.
  {
    const ch = params.position.character;
    const inProse = lineTokens.some(t => {
      if (t.type === TokenType.Comment) return ch > t.start;
      if (t.type === TokenType.StringLit) {
        return t.unclosed ? ch > t.start : ch > t.start && ch < t.end;
      }
      return false;
    });
    if (inProse) return [];
  }

  // Scoped variable completions — insert only the NAME after the dot
  if (/\bvar\.$/.test(prefix)) {
    return symbolTable.getLocalCompletions(params.textDocument.uri).map(v => ({
      label: v.name,
      filterText: `var.${v.name}`,
      insertText: v.name,
      kind: CompletionItemKind.Variable,
      detail: `var.${v.name} (${v.inferredType ?? 'unknown'})`,
    }));
  }

  // global.<cursor>  →  global variable names
  if (/\bglobal\.$/.test(prefix)) {
    return symbolTable.getGlobalCompletions().map(v => ({
      label: v.name,
      filterText: `global.${v.name}`,
      insertText: v.name,
      kind: CompletionItemKind.Variable,
      detail: `global.${v.name} (${v.inferredType ?? 'unknown'})`,
    }));
  }

  // param.<cursor>  →  parameter names
  if (/\bparam\.$/.test(prefix)) {
    return symbolTable.getParamCompletions(params.textDocument.uri).map(v => ({
      label: v.name,
      filterText: `param.${v.name}`,
      insertText: v.name,
      kind: CompletionItemKind.Variable,
      detail: `param.${v.name} (${v.inferredType ?? 'unknown'})`,
    }));
  }

  // OM completions — triggered after any dotted path.  Subscripts may appear
  // after ANY segment (tools[0].retraction.), not just the last one.
  const omPrefixMatch = /([a-zA-Z_][a-zA-Z0-9_]*(?:\[\d*\])*(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:\[\d*\])*)*)\.$/
    .exec(prefix);
  if (omPrefixMatch && isOmIndexAvailable()) {
    const omPrefix = omPrefixMatch[1].replace(/\[\d+\]/g, '[]');
    const omPrefixWithDot = omPrefix + '.';
    const items: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const info of allOmPaths()) {
      if (!info.path.startsWith(omPrefixWithDot)) continue;
      const rest = info.path.slice(omPrefixWithDot.length);
      const segment = rest.split('.')[0].replace(/\[\]$/, '');
      if (!segment || seen.has(segment)) continue;
      seen.add(segment);
      items.push({
        label: segment,
        insertText: segment,
        kind: info.isArray ? CompletionItemKind.Field : CompletionItemKind.Property,
        detail: `${omPrefixWithDot}${segment}${info.isArray ? '[]' : ''} (${info.type})`,
      });
    }
    if (items.length > 0) return items;
  }

  // General completions
  const items: CompletionItem[] = [];

  for (const code of Object.keys(gcodeData)) {
    items.push({ label: code, kind: CompletionItemKind.Function, detail: gcodeData[code].title });
  }
  for (const [name, info] of Object.entries(metaData)) {
    if (name === '_meta') continue;
    const i = info as GCodeDoc;
    items.push({
      label: name, kind: CompletionItemKind.Keyword, detail: i.title,
      documentation: { kind: MarkupKind.Markdown, value: i.description },
      insertText: metaInsertText(name),
      insertTextFormat: 2,
    });
  }

  // Ensure var and global always have declaration snippets even if META_COMMAND_DOCS
  // is missing them (bug 3: global snippet was absent in some configurations).
  for (const kw of ['var', 'global'] as const) {
    if (!items.some(it => it.label === kw)) {
      items.push({
        label: kw,
        kind: CompletionItemKind.Keyword,
        detail: kw === 'var' ? 'Declare a local variable' : 'Declare a global variable',
        insertText: metaInsertText(kw),
        insertTextFormat: 2,
      });
    }
  }
  for (const [name, rawInfo] of Object.entries(functionsData)) {
    if (name === '_meta') continue;
    const info = rawInfo as FunctionDoc;
    const ps = info.params ?? [];
    const detail = ps.length > 0
      ? `${name}(${ps.map((p: FunctionParam) => p.name).join(', ')}) → ${info.returnType ?? 'any'}`
      : info.title;
    items.push({
      label: name, kind: CompletionItemKind.Function,
      detail,
      documentation: { kind: MarkupKind.Markdown, value: info.description },
      insertText: `${name}($0)`,
      insertTextFormat: 2, // snippet
    });
  }

  // Named constants — only those the meta-commands data file doesn't already
  // provide (it documents true/false/null/pi/…), so nothing shows up twice.
  for (const name of NAMED_CONSTANTS) {
    if (name in metaData) continue;
    items.push({ label: name, kind: CompletionItemKind.Constant });
  }

  // All in-scope variables
  for (const v of symbolTable.getAllCompletions(params.textDocument.uri)) {
    items.push({
      label: `${v.scope}.${v.name}`,
      kind: CompletionItemKind.Variable,
      detail: `${v.scope}.${v.name} (${v.inferredType ?? 'unknown'})`,
    });
  }
  if (isOmIndexAvailable()) {
    const seen = new Set<string>();
    for (const info of allOmPaths()) {
      const top = info.path.split('.')[0];
      if (seen.has(top)) continue;
      seen.add(top);
      items.push({ label: top, kind: CompletionItemKind.Module, detail: `Object Model: ${top}` });
    }
  }

  return items;
});

// ── Signature Help ─────────────────────────────────────────────────────────────
connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const lineText = lines[params.position.line] ?? '';

  // Tokenize so string literals and comments can be excluded: a '(' typed
  // inside `M291 P"Press min("` or a `; use max(` comment is text, not a call,
  // and commas inside string arguments must not advance activeParameter.
  const sigTokens = new Lexer(lineText, params.position.line).tokenize();
  const cursorCh = params.position.character;
  const cursorInProse = sigTokens.some(t => {
    if (t.type === TokenType.Comment) return cursorCh > t.start;
    if (t.type === TokenType.StringLit) {
      return t.unclosed ? cursorCh > t.start : cursorCh > t.start && cursorCh < t.end;
    }
    return false;
  });
  if (cursorInProse) return null;

  // Mask string/char literal contents with spaces before the character walk.
  const maskedChars = lineText.slice(0, cursorCh).split('');
  for (const t of sigTokens) {
    if (t.type !== TokenType.StringLit && t.type !== TokenType.CharLit) continue;
    for (let k = t.start; k < Math.min(t.end, maskedChars.length); k++) maskedChars[k] = ' ';
  }
  const upToCursor = maskedChars.join('');

  // Walk backwards to find the innermost open function call
  let depth = 0;
  let funcStart = -1;
  for (let i = upToCursor.length - 1; i >= 0; i--) {
    const c = upToCursor[i];
    if (c === ')') { depth++; continue; }
    if (c === '(') {
      if (depth > 0) { depth--; continue; }
      funcStart = i;
      break;
    }
  }

  if (funcStart < 0) return null;

  const nameMatch = /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(upToCursor.slice(0, funcStart).trimEnd());
  if (!nameMatch) return null;
  const funcName = nameMatch[1].toLowerCase();

  if (funcName === '_meta') return null;
  const funcInfo = functionsData[funcName] as FunctionDoc | undefined;
  if (!funcInfo) return null;

  const inside = upToCursor.slice(funcStart + 1);
  let activeParam = 0, d = 0;
  for (const c of inside) {
    if (c === '(' || c === '[' || c === '{') { d++; continue; }
    if (c === ')' || c === ']' || c === '}') { d--; continue; }
    if (c === ',' && d === 0) activeParam++;
  }

  const funcParams = funcInfo.params ?? [];
  activeParam = Math.min(activeParam, Math.max(0, funcParams.length - 1));

  const sigLabel = funcInfo.syntax
    ?? `${funcName}(${funcParams.map((p: FunctionParam) => p.name).join(', ')})`;

  return {
    signatures: [{
      label: sigLabel,
      documentation: { kind: MarkupKind.Markdown, value: funcInfo.description },
      parameters: funcParams.map((p: FunctionParam) => ({
        label: p.name,
        documentation: p.doc
          ? { kind: MarkupKind.Markdown, value: `*${p.type ?? 'any'}* — ${p.doc}` }
          : undefined,
      })) as ParameterInformation[],
    } as SignatureInformation],
    activeSignature: 0,
    activeParameter: activeParam,
  };
});

// ── Semantic Tokens ────────────────────────────────────────────────────────────
//
// Highlighting design (all values are LSP standard token types / modifiers,
// so any colour theme picks them up without per-language theme work):
//
//   ┌─────────────┬───────────────────────────────────────────────────────────┐
//   │  Token type │  Used for                                                 │
//   ├─────────────┼───────────────────────────────────────────────────────────┤
//   │  keyword    │  if, elif, else, while, break, continue, abort,           │
//   │             │  var, global, set, echo, param, skip                      │
//   │  function   │  built-in functions (abs, sin, max, vector, exists, …)    │
//   │  variable   │  var.x  global.x  param.x                                 │
//   │  number     │  numeric literals (Integer, Float, Hex, Bin)              │
//   │  string     │  string and char literals                                 │
//   │  operator   │  + - * / ^ == != < > = , : ? # >> >>>                     │
//   │  parameter  │  G-code parameter letters (P, S, R, X, Y, Z, F, K, …)     │
//   │  macro      │  G/M/T command codes (G1, M291, T0)                       │
//   │  comment    │  ; comments                                               │
//   │  enumMember │  named constants (true, false, null, pi, iterations,      │
//   │             │                   line, result, input)                    │
//   │  regexp     │  escape sequences inside string literals (`""` → single `"`) │
//   └─────────────┴───────────────────────────────────────────────────────────┘
//
//   ┌──────────────┬──────────────────────────────────────────────────────────┐
//   │  Modifier    │  Applied to                                              │
//   ├──────────────┼──────────────────────────────────────────────────────────┤
//   │  declaration │  the defining name in `var x = …` or `global x = …`     │
//   │  readonly    │  named constants (pi, true, …) and `param.X` references  │
//   │  deprecated  │  (reserved — currently unused)                           │
//   └──────────────┴──────────────────────────────────────────────────────────┘
//
// The token-type and modifier indices below MUST match the order in
// SEMANTIC_TOKEN_TYPES / SEMANTIC_TOKEN_MODIFIERS in parser/types.ts.

const ST = {
  keyword: 0,
  function: 1,
  variable: 2,
  number: 3,
  string: 4,
  operator: 5,
  parameter: 6,
  macro: 7,
  comment: 8,
  enumMember: 9,
  regexp: 10,
};

const MOD = {
  declaration: 1 << 0,
  readonly: 1 << 1,
  deprecated: 1 << 2,
};

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };

  const builder = new SemanticTokensBuilder();
  const lines = doc.getText().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const tokens = new Lexer(lines[i], i).tokenize();

    for (let j = 0; j < tokens.length; j++) {
      const tok = tokens[j];

      // String literals with embedded `""` escapes are emitted as several
      // ranges so the escapes can be coloured distinctly from the content.
      if (tok.type === TokenType.StringLit && tok.escapes && tok.escapes.length > 0) {
        emitStringWithEscapes(builder, i, tok);
        continue;
      }

      const styled = styleFor(tok, tokens, j);
      if (styled !== null) {
        builder.push(i, tok.start, tok.end - tok.start, styled.type, styled.mod);
      }
    }
  }

  return builder.build();
});

/**
 * Emit a StringLit as a sequence of `string` ranges interspersed with
 * `regexp` ranges for each `""` escape.  Themes typically render `regexp` in
 * a contrasting hue, making escapes pop out from the surrounding text.
 *
 * Example for the literal  "test ""test"""  spanning columns 0..15:
 *
 *   "test "      → string  (0..6)
 *   ""           → regexp  (6..8)
 *   test         → string  (8..12)
 *   ""           → regexp  (12..14)
 *   "            → string  (14..15)
 */
function emitStringWithEscapes(builder: SemanticTokensBuilder, line: number, tok: Token): void {
  const escapes = tok.escapes!;          // non-empty by caller guarantee
  let cursor = tok.start;

  for (const esc of escapes) {
    if (esc.start > cursor) {
      builder.push(line, cursor, esc.start - cursor, ST.string, 0);
    }
    builder.push(line, esc.start, esc.end - esc.start, ST.regexp, 0);
    cursor = esc.end;
  }

  // Trailing content after the last escape (includes the closing quote).
  if (cursor < tok.end) {
    builder.push(line, cursor, tok.end - cursor, ST.string, 0);
  }
}

/**
 * Returns the semantic token type + modifier bitmask for `tok`, or null if
 * the token should not be highlighted at all (whitespace, structural braces,
 * EOF, …).
 *
 * Context-sensitive cases:
 *   • Identifier "var.x" / "global.x" / "param.x" → variable
 *       — `param.X` gets the `readonly` modifier
 *   • Bare identifier (an Object Model path like `move.axes`) → variable
 *   • Identifier directly after a `var`/`global` keyword → variable+declaration
 *   • `>>>` → operator+deprecated
 */
function styleFor(
  tok: Token,
  tokens: Token[],
  idx: number,
): { type: number; mod: number } | null {
  switch (tok.type) {
    // ── Meta keywords ─────────────────────────────────────────────────────
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
    case TokenType.Skip:
      return { type: ST.keyword, mod: 0 };

    // ── Built-in functions ────────────────────────────────────────────────
    case TokenType.FunctionName:
      return { type: ST.function, mod: 0 };

    // ── Identifiers: variables, declarations, OM paths ────────────────────
    case TokenType.Identifier: {
      const v = tok.value;

      // Qualified variable references
      if (v.startsWith('var.') || v.startsWith('global.')) {
        return { type: ST.variable, mod: 0 };
      }
      if (v.startsWith('param.')) {
        // param.X is set by the macro caller; it is read-only inside the macro.
        return { type: ST.variable, mod: MOD.readonly };
      }

      // Declaration form:  `var <name>`  /  `global <name>`
      // The bare name token is preceded by Var/Global; mark with `declaration`.
      const prev = idx > 0 ? tokens[idx - 1] : null;
      if (prev?.type === TokenType.Var || prev?.type === TokenType.Global) {
        return { type: ST.variable, mod: MOD.declaration };
      }

      // Object Model path or other bare identifier — still a "variable" kind
      // of name from the highlighter's point of view.
      return { type: ST.variable, mod: 0 };
    }

    // ── Named constants  → enumMember + readonly ──────────────────────────
    case TokenType.True:
    case TokenType.False:
    case TokenType.Null:
    case TokenType.Pi:
    case TokenType.Iterations:
    case TokenType.Line:
    case TokenType.Result:
    case TokenType.Input:
      return { type: ST.enumMember, mod: MOD.readonly };

    // ── Numeric literals ──────────────────────────────────────────────────
    case TokenType.Integer:
    case TokenType.HexInteger:
    case TokenType.BinInteger:
    case TokenType.Float:
      return { type: ST.number, mod: 0 };

    // ── String / char literals ────────────────────────────────────────────
    case TokenType.StringLit:
    case TokenType.CharLit:
      return { type: ST.string, mod: 0 };

    // ── Operators ─────────────────────────────────────────────────────────
    case TokenType.Plus:
    case TokenType.Minus:
    case TokenType.Star:
    case TokenType.Slash:
    case TokenType.Caret:
    case TokenType.Eq:
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
    case TokenType.Colon:
    case TokenType.Comma:
    case TokenType.DoubleGt:
    case TokenType.TripleGt:
      // `>>>` (append without newline) is the NEWEST echo redirect form,
      // added in RRF 3.5beta2 — it must not carry the `deprecated` modifier.
      return { type: ST.operator, mod: 0 };

    // ── G-code parameter words (P, S, R, X, …) ────────────────────────────
    case TokenType.GCodeWord:
      return { type: ST.parameter, mod: 0 };

    // ── G/M/T command codes ───────────────────────────────────────────────
    case TokenType.GCode:
    case TokenType.TCode:
      return { type: ST.macro, mod: 0 };

    // ── Comments ──────────────────────────────────────────────────────────
    case TokenType.Comment:
      return { type: ST.comment, mod: 0 };

    // ── Structural tokens (braces, parens, brackets, dot, EOF, unknown) ───
    default:
      return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function mkRange(sl: number, sc: number, el: number, ec: number): Range {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

function metaInsertText(name: string): string {
  switch (name) {
    case 'if': return 'if $1';
    case 'elif': return 'elif $1';
    case 'while': return 'while $1';
    case 'var': return 'var $1 = $2';
    case 'global': return 'global $1 = $2';
    case 'set': return 'set $1 = $2';
    case 'echo': return 'echo $1';
    case 'abort': return 'abort "$1"';
    default: return name;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
documents.listen(connection);
connection.listen();
