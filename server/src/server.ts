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
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';

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
import { FUNCTION_SIGNATURES, META_COMMAND_DOCS } from './data/signatures';
import { buildRenameEdit } from './analysis/rename';
import { buildReferences } from './analysis/references';
import { lineIndent, findTokenAtChar } from './analysis/utils';

// ── Connection setup ──────────────────────────────────────────────────────────
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);
const symbolTable = new SymbolTable();

// ── Load JSON data files ──────────────────────────────────────────────────────
interface GCodeDoc { title: string; description: string; anchor: string }
type DocDB = Record<string, GCodeDoc>;

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
const RRF_EXTENSIONS = new Set(['.g', '.G', '.gcode', '.macro', '.cfg']);

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
        triggerCharacters: ['.', ' ', '(', '{'],
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
    },
  };
});

connection.onInitialized(async () => {
  connection.console.log('RRF LSP ready.');
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

// ── Workspace directory scanner ────────────────────────────────────────────────
//
// Indexes every RRF file in the workspace for the symbol table and publishes
// initial diagnostics for all non-open files.
//
// File detection strategy (in order):
//   1. Files with a known RRF extension (.g, .gcode, .macro, .cfg, …) are
//      always indexed regardless of content.
//   2. Files WITHOUT any extension are sniffed with looksLikeGCode().  This
//      covers the common RRF pattern of extensionless macros in sys/ or macros/.
//   3. All other extensions (e.g. .txt, .json, .md) are ignored.
//
// A cap of MAX_BACKGROUND_DIAGNOSTICS prevents the initial scan from taking
// too long on very large repositories.
const MAX_BACKGROUND_DIAGNOSTICS = 1000;
let backgroundDiagnosticsPublished = 0;

function scanDirectoryForGlobals(dir: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectoryForGlobals(fullPath);
      continue;
    }

    const ext = path.extname(entry.name);
    const hasRrfExt = RRF_EXTENSIONS.has(ext);
    const noExt = ext === '';

    // Skip files with non-RRF extensions
    if (!hasRrfExt && !noExt) continue;

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

    // For extensionless files, apply content sniffing before indexing.
    if (noExt && !looksLikeGCode(content)) continue;

    symbolTable.indexDocument(fileUri, content);

    // Publish diagnostics for background (non-open) files up to the cap.
    if (backgroundDiagnosticsPublished < MAX_BACKGROUND_DIAGNOSTICS) {
      backgroundDiagnosticsPublished++;
      publishDiagnosticsForText(fileUri, content);
    }
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
      publishDiagnosticsForText(e.document.uri, text);
    } else {
      symbolTable.removeDocument(e.document.uri);
      connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
    }
  } catch {
    symbolTable.removeDocument(e.document.uri);
  }
});

function onDocumentChange(doc: TextDocument): void {
  symbolTable.indexDocument(doc.uri, doc.getText());
  publishDiagnostics(doc);
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

// ── G-code parameter suppression ─────────────────────────────────────────────
//
// In RRF G-code, everything after the first command token is a parameter.
// However, {expression} blocks embedded in G-code lines are real expressions
// (e.g. `M42 P3 S{var.i}`). Tokens inside { } should NOT be suppressed for
// hover purposes.
//
// Returns a set of token indices that should be suppressed for hover/semantic.
// "Suppressed" means they are G-code parameter noise (letters, numbers, etc.)
// NOT expression tokens inside { } blocks.

interface GCodeParamResult {
  /** All token indices that are in parameter position */
  paramIndices: Set<number>;
  /** Token indices that are INSIDE a { } expression block */
  exprBraceIndices: Set<number>;
}

function getGCodeParamInfo(tokens: Token[]): GCodeParamResult {
  const paramIndices = new Set<number>();
  const exprBraceIndices = new Set<number>();

  const firstType = tokens[0]?.type;
  if (firstType !== TokenType.GCode && firstType !== TokenType.TCode) {
    return { paramIndices, exprBraceIndices };
  }

  let braceDepth = 0;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === TokenType.EOF || tok.type === TokenType.Comment) break;

    if (tok.type === TokenType.LBrace) {
      braceDepth++;
      paramIndices.add(i);    // the { itself is still a param token
      exprBraceIndices.add(i);
    } else if (tok.type === TokenType.RBrace) {
      braceDepth--;
      paramIndices.add(i);
      exprBraceIndices.add(i);
    } else if (braceDepth > 0) {
      // Inside { } — mark as expression token (NOT suppressed for hover)
      exprBraceIndices.add(i);
      // Still add to paramIndices for semantic token purposes, but hover
      // will check exprBraceIndices before suppressing
      paramIndices.add(i);
    } else {
      paramIndices.add(i);
    }
  }

  return { paramIndices, exprBraceIndices };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

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

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
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

    for (const tok of tokens) {
      if (tok.type === TokenType.TripleGt) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: mkRange(i, tok.start, i, tok.end),
          message: '>>> is a deprecated redirect operator. Use echo with > redirection instead.',
          source: 'rrf-gcode',
        });
      }
    }
  }

  connection.sendDiagnostics({ uri, diagnostics });
}

// ── Hover ─────────────────────────────────────────────────────────────────────
connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const line = lines[params.position.line] ?? '';
  const tokens = new Lexer(line, params.position.line).tokenize();

  const { paramIndices, exprBraceIndices } = getGCodeParamInfo(tokens);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.start <= params.position.character && params.position.character < tok.end) {
      if (paramIndices.has(i)) {
        // Inside a { } expression block — always show hover (these are real expressions)
        if (exprBraceIndices.has(i)) break;
        // Pure parameter noise — suppress
        return null;
      }
    }
  }

  return buildHover(
    tokens,
    params.position.character,
    params.position.line,
    gcodeData, metaData, operatorsData, functionsData,
    symbolTable,
    params.textDocument.uri,
    lineIndent(line),
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

  const tok = tokens.find(t => t.start <= params.position.character && params.position.character < t.end);
  if (!tok || tok.type !== TokenType.Identifier) return null;

  const val = tok.value;
  let decl: { uri: string; line: number; col: number } | undefined;

  if (val.startsWith('var.'))
    decl = symbolTable.lookupVarAtLine(val.slice(4), params.textDocument.uri, params.position.line, indent) ?? undefined;
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

// ── Completions ───────────────────────────────────────────────────────────────
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  const line = lines[params.position.line] ?? '';
  const prefix = line.slice(0, params.position.character);

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

  // OM completions — triggered after any dotted path
  const omPrefixMatch = /([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*(?:\[\d*\])*)\.$/
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
  for (const [name, info] of Object.entries(META_COMMAND_DOCS)) {
    const i = info as { title: string; syntax: string; doc: string };
    items.push({
      label: name, kind: CompletionItemKind.Keyword, detail: i.title,
      documentation: { kind: MarkupKind.Markdown, value: `**Syntax:** \`${i.syntax}\`\n\n${i.doc}` },
      insertText: metaInsertText(name),
      insertTextFormat: 2,
    });
  }
  for (const [name, sig] of Object.entries(FUNCTION_SIGNATURES)) {
    const s = sig as { params: { name: string }[]; returnType: string; doc: string };
    items.push({
      label: name, kind: CompletionItemKind.Function,
      detail: `${name}(${s.params.map(p => p.name).join(', ')}) → ${s.returnType}`,
      documentation: { kind: MarkupKind.Markdown, value: s.doc },
      insertText: `${name}($0)`,
      insertTextFormat: 2, // snippet
    });
  }

  // Named constants
  for (const name of NAMED_CONSTANTS) {
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
  const upToCursor = lineText.slice(0, params.position.character);

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
  const sig = FUNCTION_SIGNATURES[funcName] as {
    name: string; params: { name: string; type?: string; doc: string }[];
    returnType: string; doc: string;
  } | undefined;
  if (!sig) return null;

  const inside = upToCursor.slice(funcStart + 1);
  let activeParam = 0, d = 0;
  for (const c of inside) {
    if (c === '(' || c === '[' || c === '{') { d++; continue; }
    if (c === ')' || c === ']' || c === '}') { d--; continue; }
    if (c === ',' && d === 0) activeParam++;
  }
  activeParam = Math.min(activeParam, sig.params.length - 1);

  return {
    signatures: [{
      label: `${sig.name}(${sig.params.map(p => p.name).join(', ')})`,
      documentation: { kind: MarkupKind.Markdown, value: sig.doc },
      parameters: sig.params.map(p => ({
        label: p.name,
        documentation: { kind: MarkupKind.Markdown, value: `*${p.type ?? 'any'}* — ${p.doc}` },
      })) as ParameterInformation[],
    } as SignatureInformation],
    activeSignature: 0,
    activeParameter: activeParam,
  };
});

// ── Semantic Tokens ────────────────────────────────────────────────────────────
// Token type indices (must match SEMANTIC_TOKEN_TYPES order)
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
};

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };

  const builder = new SemanticTokensBuilder();
  const lines = doc.getText().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const tokens = new Lexer(lines[i], i).tokenize();
    const { paramIndices, exprBraceIndices } = getGCodeParamInfo(tokens);

    for (let j = 0; j < tokens.length; j++) {
      const tok = tokens[j];

      if (paramIndices.has(j) && !exprBraceIndices.has(j)) {
        // Pure param noise — only highlight single-letter identifiers and codes
        if (tok.type === TokenType.Identifier && tok.value.length === 1)
          builder.push(i, tok.start, tok.end - tok.start, ST.parameter, 0);
        if (tok.type === TokenType.TCode || tok.type === TokenType.GCode)
          builder.push(i, tok.start, tok.end - tok.start, ST.parameter, 0);
        continue;
      }

      const st = semanticTypeFor(tok);
      if (st !== null) builder.push(i, tok.start, tok.end - tok.start, st, 0);
    }
  }

  return builder.build();
});

function semanticTypeFor(tok: Token): number | null {
  switch (tok.type) {
    // Meta keywords
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
      return ST.keyword;

    // Functions
    case TokenType.FunctionName:
      return ST.function;

    // Variables
    case TokenType.Identifier: {
      const v = tok.value;
      if (v.startsWith('var.') || v.startsWith('global.') || v.startsWith('param.'))
        return ST.variable;
      return null;
    }

    // Named constants / parameters
    case TokenType.True:
    case TokenType.False:
    case TokenType.Null:
    case TokenType.Pi:
    case TokenType.Iterations:
    case TokenType.Line:
    case TokenType.Result:
    case TokenType.Input:
      return ST.parameter;

    // Numbers
    case TokenType.Integer:
    case TokenType.HexInteger:
    case TokenType.BinInteger:
    case TokenType.Float:
      return ST.number;

    // Strings
    case TokenType.StringLit:
    case TokenType.CharLit:
      return ST.string;

    // Operators
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
      return ST.operator;

    // G/M/T codes
    case TokenType.GCode:
    case TokenType.TCode:
      return ST.macro;

    // Comments
    case TokenType.Comment:
      return ST.comment;

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
    case 'if': return 'if {$1}';
    case 'elif': return 'elif {$1}';
    case 'while': return 'while {$1}';
    case 'var': return 'var $1 = $2';
    case 'global': return 'global $1 = $2';
    case 'set': return 'set $1 = $2';
    case 'echo': return 'echo $1';
    case 'abort': return 'abort "$1"';
    case 'param': return 'param $1 = $2';
    default: return name;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
documents.listen(connection);
connection.listen();
