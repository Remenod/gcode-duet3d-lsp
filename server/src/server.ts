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

const RRF_EXTENSIONS = new Set(['.g', '.G', '.gcode', '.macro', '.cfg']);

// ── Initialize ────────────────────────────────────────────────────────────────
connection.onInitialize((_params: InitializeParams): InitializeResult => {
  connection.console.log('RRF LSP initializing…');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['.', ' ', '(', '{'],
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
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

function scanDirectoryForGlobals(dir: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectoryForGlobals(fullPath);
    } else if (RRF_EXTENSIONS.has(path.extname(entry.name))) {
      const fileUri = URI.file(fullPath).toString();
      if (documents.get(fileUri)) continue;
      try {
        symbolTable.indexDocument(fileUri, fs.readFileSync(fullPath, 'utf8'));
      } catch { /* skip */ }
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
      symbolTable.indexDocument(e.document.uri, fs.readFileSync(filePath, 'utf8'));
    } else {
      symbolTable.removeDocument(e.document.uri);
    }
  } catch {
    symbolTable.removeDocument(e.document.uri);
  }
});

function onDocumentChange(doc: TextDocument): void {
  symbolTable.indexDocument(doc.uri, doc.getText());
  publishDiagnostics(doc);
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
function publishDiagnostics(doc: TextDocument): void {
  const text = doc.getText();
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
      symbolTable, uri: doc.uri, line: i, indent,
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

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
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
  else if (val.startsWith('param.'))
    decl = symbolTable.lookupParam(val.slice(6), params.textDocument.uri) ?? undefined;

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
function lineIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

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
