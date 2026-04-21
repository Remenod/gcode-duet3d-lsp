// parser/expression.ts

import { Token, TokenType } from './types';

export interface ParseError {
  message: string;
  start: number;
  end: number;
  line: number;
  severity?: 'error' | 'warning' | 'information';
}

export interface DiagnosticContext {
  symbolTable: {
    lookupVarAtLine(name: string, uri: string, refLine: number, refIndent: number): unknown | undefined;
    lookupGlobal(name: string): unknown | undefined;
    getAllDeclsForName(name: string, uri: string): Array<{ indent: number; line: number }>;
    getAllGlobalDecls(name: string): Array<{ uri: string; line: number }>;
    getGlobalDeclsInFile(name: string, uri: string): Array<{ line: number }>;
  };
  uri: string;
  line: number;
  indent: number;
  isValidOmPath?: (path: string) => boolean;
}

const BINARY_OPS = new Map<TokenType, number>([
  [TokenType.Ternary, 1],      // ?
  [TokenType.Caret, 2],        // ^ (string concat)
  [TokenType.And, 3],          // & / &&
  [TokenType.Or, 3],           // | / ||
  [TokenType.Not, 4],          // ! (parsed as != here)
  [TokenType.NEq, 4],          // !=
  [TokenType.Eq, 4],           // =  / ==
  [TokenType.EqEq, 4],         // ==
  [TokenType.Lt, 4],           // <
  [TokenType.Gt, 4],           // >
  [TokenType.LtEq, 4],         // <=
  [TokenType.GtEq, 4],         // >=
  [TokenType.Plus, 5],         // +
  [TokenType.Minus, 5],        // -
  [TokenType.Star, 6],         // *
  [TokenType.Slash, 6],        // /
]);

// Max args for known functions (undefined = variadic/unknown)
const FUNC_ARG_RANGE: Record<string, [number, number]> = {
  abs: [1, 1],
  acos: [1, 1],
  asin: [1, 1],
  atan: [1, 1],
  atan2: [2, 2],
  ceil: [1, 1],
  cos: [1, 1],
  datetime: [1, 1],
  degrees: [1, 1],
  drop: [2, 2],
  exists: [1, 1],
  exp: [1, 1],
  fileexists: [1, 1],
  fileread: [4, 4],
  find: [2, 2],
  floor: [1, 1],
  isnan: [1, 1],
  log: [1, 1],
  max: [1, 99],
  min: [1, 99],
  mod: [2, 2],
  pow: [2, 2],
  radians: [1, 1],
  random: [1, 1],
  round: [1, 1],
  sin: [1, 1],
  sqrt: [1, 1],
  square: [1, 1],
  take: [2, 2],
  tan: [1, 1],
  vector: [2, 2],
};

export class ExpressionValidator {
  private pos = 0;
  private tokens: Token[];
  readonly errors: ParseError[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ── Entry: validate the whole expression ──────────────────────────────────
  validate(): ParseError[] {
    this.parseInternal(0);
    return this.errors;
  }

  validateCommaList(): ParseError[] {
    if (this.current().type === TokenType.EOF) return this.errors;
    this.parseInternal(0);
    while (this.current().type === TokenType.Comma) {
      this.advance();
      if (this.current().type === TokenType.EOF) break;
      this.parseInternal(0);
    }
    return this.errors;
  }

  // ── ParseInternal: mirrors ExpressionParser::ParseInternal ────────────────
  private parseInternal(priority: number): void {
    this.parseUnaryOrPrimary();
    this.parseBinaryTail(priority);
  }

  // ── Unary prefix + primary ────────────────────────────────────────────────
  private parseUnaryOrPrimary(): void {
    const t = this.current();

    switch (t.type) {
      // Unary operators: -  +  !  #
      case TokenType.Minus:
      case TokenType.Plus:
      case TokenType.Not:
        this.advance();
        this.parseInternal(10); // unary priority = 10 (highest)
        return;

      case TokenType.Hash:
        this.advance();
        if (this.isAlpha(this.current())) {
          this.parseIdentifierExpression();
        } else {
          this.parseInternal(10);
        }
        return;

      // Bracket expressions
      case TokenType.LParen:
        this.advance();
        this.parseInternal(0);
        this.expect(TokenType.RParen, "expected ')'");
        return;

      case TokenType.LBrace:
        this.advance();
        this.parseInternal(0);
        // may be array {a, b, c}
        while (this.current().type === TokenType.Comma) {
          this.advance();
          if (this.current().type === TokenType.RBrace) break;
          this.parseInternal(0);
        }
        this.expect(TokenType.RBrace, "expected '}'");
        return;

      case TokenType.LBracket:
        this.advance();
        if (this.current().type !== TokenType.RBracket) {
          this.parseInternal(0);
          while (this.current().type === TokenType.Comma) {
            this.advance();
            if (this.current().type === TokenType.RBracket) break;
            this.parseInternal(0);
          }
        }
        this.expect(TokenType.RBracket, "expected ']'");
        return;

      // Literals
      case TokenType.Integer:
      case TokenType.HexInteger:
      case TokenType.BinInteger:
      case TokenType.Float:
      case TokenType.StringLit:
      case TokenType.CharLit:
      case TokenType.True:
      case TokenType.False:
      case TokenType.Null:
      case TokenType.Pi:
      case TokenType.Iterations:
      case TokenType.Line:
      case TokenType.Result:
      case TokenType.Input:
        this.advance();
        // Trailing index  expr[N]
        this.parseTrailingIndexes();
        return;

      // Function call or identifier
      case TokenType.FunctionName:
        this.parseFunctionCall(t);
        return;

      case TokenType.Identifier:
        this.parseIdentifierExpression();
        return;

      // EOF / unexpected
      case TokenType.EOF:
        return;

      default:
        if (t.type !== TokenType.Comment) {
          this.addError(`unexpected token '${t.value}'`, t);
        }
        this.advance();
        return;
    }
  }

  // ── Function call ──────────────────────────────────────────────────────────
  private parseFunctionCall(nameTok: Token): void {
    this.advance(); // consume function name
    const funcName = nameTok.value.toLowerCase();

    // Special: exists(expr) — takes an identifier, not a normal expression
    if (funcName === 'exists') {
      this.expect(TokenType.LParen, "expected '(' after 'exists'");
      // optional # prefix
      if (this.current().type === TokenType.Hash) this.advance();
      this.parseIdentifierExpression();
      this.expect(TokenType.RParen, "expected ')' after exists argument");
      return;
    }

    this.expect(TokenType.LParen, `expected '(' after '${nameTok.value}'`);

    const argRange = FUNC_ARG_RANGE[funcName];
    let argCount = 0;

    if (this.current().type !== TokenType.RParen) {
      this.parseInternal(0);
      argCount = 1;

      while (this.current().type === TokenType.Comma) {
        this.advance();
        this.parseInternal(0);
        argCount++;
      }
    }

    if (argRange) {
      const [minA, maxA] = argRange;
      if (argCount < minA) {
        this.addError(`'${funcName}' requires at least ${minA} argument(s), got ${argCount}`, nameTok);
      } else if (argCount > maxA) {
        this.addError(`'${funcName}' takes at most ${maxA} argument(s), got ${argCount}`, nameTok);
      }
    }

    this.expect(TokenType.RParen, `expected ')' after arguments to '${funcName}'`);
    this.parseTrailingIndexes();
  }

  // ── Identifier expression: var.x  global.y  param.z  obj.model.path ───────
  private parseIdentifierExpression(): void {
    const t = this.current();
    if (t.type === TokenType.Identifier) {
      this.advance();
    } else if (this.isKnownWordToken(t)) {
      this.advance();
    }
    this.parseTrailingIndexes();
  }

  // Handles chains like: axes[0].homed  or  probes[0].value[0]
  // Also accepts FunctionName tokens as field names (e.g. "max" in axes[0].max).
  private parseTrailingIndexes(): void {
    for (; ;) {
      if (this.current().type === TokenType.LBracket) {
        this.advance();
        this.parseInternal(0);
        this.expect(TokenType.RBracket, "expected ']'");
      } else if (this.current().type === TokenType.Dot) {
        this.advance();
        const ft = this.current();
        if (
          ft.type === TokenType.Identifier ||
          ft.type === TokenType.FunctionName ||    // e.g. axes[0].max
          this.isKnownWordToken(ft)
        ) {
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  // ── Binary operator tail ───────────────────────────────────────────────────
  private parseBinaryTail(priority: number): void {
    for (; ;) {
      const t = this.current();
      const prio = BINARY_OPS.get(t.type);
      if (prio === undefined || prio <= priority) return;

      this.advance();

      // Ternary: expr ? expr : expr
      if (t.type === TokenType.Ternary) {
        this.parseInternal(prio);
        this.expect(TokenType.Colon, "expected ':' in ternary expression");
        this.parseInternal(prio - 1);
        return;
      }

      this.parseInternal(prio);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private current(): Token { return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0, start: 0, end: 0 }; }
  private advance(): Token { return this.tokens[this.pos++] ?? { type: TokenType.EOF, value: '', line: 0, start: 0, end: 0 }; }

  private expect(type: TokenType, msg: string): boolean {
    const t = this.current();
    if (t.type === type) { this.advance(); return true; }
    if (t.type !== TokenType.EOF) {
      this.addError(msg, t);
    }
    return false;
  }

  private addError(message: string, tok: Token, severity: ParseError['severity'] = 'error'): void {
    this.errors.push({ message, start: tok.start, end: tok.end, line: tok.line, severity });
  }

  private isAlpha(t: Token): boolean {
    return t.type === TokenType.Identifier || t.type === TokenType.FunctionName ||
      (t.type >= TokenType.True && t.type <= TokenType.Input);
  }

  private isKnownWordToken(t: Token): boolean {
    return t.type >= TokenType.True && t.type <= TokenType.Input;
  }
}

// ── Full-line validation ───────────────────────────────────────────────────────
export function validateLine(tokens: Token[], lineText: string, ctx?: DiagnosticContext): ParseError[] {
  const errors: ParseError[] = [];
  if (!tokens.length) return errors;

  const first = tokens[0];
  if (first.type === TokenType.EOF || first.type === TokenType.Comment) return errors;

  checkBracketBalance(tokens, errors);

  // ── echo ─────────────────────────────────────────────────────────────────
  if (first.type === TokenType.Echo) {
    let exprStart = 1;
    const redirectTok = tokens[exprStart];
    if (
      redirectTok?.type === TokenType.Gt ||
      redirectTok?.type === TokenType.DoubleGt ||
      redirectTok?.type === TokenType.TripleGt
    ) {
      exprStart++;
      const filenameTok = tokens[exprStart];

      if (filenameTok?.type === TokenType.StringLit) {
        // Static filename:  echo >"file.txt" ...
        exprStart++;
      } else if (filenameTok?.type === TokenType.LBrace) {
        let depth = 1;
        exprStart++; // skip the opening {
        while (exprStart < tokens.length && depth > 0) {
          const tt = tokens[exprStart].type;
          if (tt === TokenType.EOF || tt === TokenType.Comment) break;
          if (tt === TokenType.LBrace) depth++;
          if (tt === TokenType.RBrace) depth--;
          exprStart++;
        }
        // exprStart now points to the token after the closing }
      } else if (filenameTok && filenameTok.type !== TokenType.EOF) {
        errors.push({
          message: 'expected a quoted filename or {expression} after redirect operator',
          ...span(filenameTok),
        });
        return errors;
      }
    }
    const exprTokens = tokens.slice(exprStart);
    if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
      errors.push(...new ExpressionValidator(exprTokens).validateCommaList());
      if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    }
    return errors;
  }

  // ── if / elif / while / abort ─────────────────────────────────────────────
  if (
    first.type === TokenType.If ||
    first.type === TokenType.Elif ||
    first.type === TokenType.While ||
    first.type === TokenType.Abort
  ) {
    const exprTokens = tokens.slice(1);
    if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
      errors.push(...new ExpressionValidator(exprTokens).validate());
      if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    }
    return errors;
  }

  // ── var <n> = <expr> ──────────────────────────────────────────────────────
  if (first.type === TokenType.Var) {
    const nameTok = tokens[1];
    if (!nameTok || nameTok.type !== TokenType.Identifier) {
      errors.push({ message: "expected a variable name after 'var'", ...span(first) });
      return errors;
    }
    if (ctx) {
      const decls = ctx.symbolTable.getAllDeclsForName(nameTok.value, ctx.uri);
      for (const d of decls) {
        if (d.indent === ctx.indent && d.line < ctx.line) {
          errors.push({
            message: `variable '${nameTok.value}' already declared in this scope (line ${d.line + 1})`,
            ...span(nameTok),
          });
          break;
        }
      }
    }
    let exprStart = 2;
    if (tokens[exprStart]?.type === TokenType.Eq) exprStart++;
    const exprTokens = tokens.slice(exprStart);
    if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
      errors.push(...new ExpressionValidator(exprTokens).validate());
      // Also warn on bare unknown identifiers in the RHS expression
      if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    }
    return errors;
  }

  // ── global <n> = <expr> ───────────────────────────────────────────────────
  // No duplicate detection — the common RRF pattern is:
  //   if !exists(global.x)
  //     global x = value
  // Flagging those would always produce false positives.
  if (first.type === TokenType.Global) {
    const nameTok = tokens[1];
    if (!nameTok || nameTok.type !== TokenType.Identifier) {
      errors.push({ message: "expected a variable name after 'global'", ...span(first) });
      return errors;
    }
    let exprStart = 2;
    if (tokens[exprStart]?.type === TokenType.Eq) exprStart++;
    const exprTokens = tokens.slice(exprStart);
    if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
      errors.push(...new ExpressionValidator(exprTokens).validate());
    }
    return errors;
  }

  // ── param <n> [= <expr>] ──────────────────────────────────────────────────
  //
  // `param` sets a DEFAULT VALUE for a G-code word parameter that the caller
  // passes via M98, e.g. `M98 P"macro.g" Z10` → param.Z = 10 inside macro.g.
  //
  // Syntax:
  //   param Z          — Z is required; error if caller omits it
  //   param Z = 0.5    — Z is optional; defaults to 0.5 if omitted
  //
  // Notes:
  //   • The name is conventionally a single G-code letter (A–Z, case-insensitive)
  //     but the firmware accepts any valid identifier.
  //   • No duplicate detection — the same letter may appear in multiple param
  //     lines in guard patterns like  `if !exists(param.Z)  param Z = 0`.
  //   • `set param.X = ...` is intentionally disallowed by the `set` validator
  //     below; macro parameters are read-only after the call.
  if (first.type === TokenType.Param) {
    const nameTok = tokens[1];
    if (!nameTok || nameTok.type === TokenType.EOF) {
      errors.push({ message: "expected a parameter name after 'param'", ...span(first) });
      return errors;
    }
    if (nameTok.type !== TokenType.Identifier) {
      errors.push({ message: `expected a parameter name after 'param', got '${nameTok.value}'`, ...span(nameTok) });
      return errors;
    }
    // Optional default: `param Z = <expr>`
    // `param Z` with no `=` is valid — means "caller must supply Z".
    let exprStart = 2;
    if (tokens[exprStart]?.type === TokenType.Eq) {
      exprStart++;
      const exprTokens = tokens.slice(exprStart);
      if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
        errors.push(...new ExpressionValidator(exprTokens).validate());
        if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
      } else {
        // `param Z =` with nothing after the `=`
        errors.push({
          message: "expected a default value expression after '='",
          ...span(tokens[exprStart - 1]),
        });
      }
    } else if (tokens[exprStart] && tokens[exprStart].type !== TokenType.EOF && tokens[exprStart].type !== TokenType.Comment) {
      // Something unexpected after the name, e.g. `param Z 42`
      errors.push({
        message: `unexpected token '${tokens[exprStart].value}' — expected '=' or end of line`,
        ...span(tokens[exprStart]),
      });
    }
    return errors;
  }

  // ── set <var.name | global.name> [<index>] = <expr> ──────────────────────
  if (first.type === TokenType.Set) {
    const targetTok = tokens[1];

    if (!targetTok || targetTok.type === TokenType.EOF) {
      errors.push({ message: "expected 'var.<n>' or 'global.<n>' after 'set'", ...span(first) });
      return errors;
    }
    if (targetTok.type !== TokenType.Identifier) {
      errors.push({ message: `'set' can only assign to 'var.<n>' or 'global.<n>'`, ...span(targetTok) });
      return errors;
    }

    const val = targetTok.value;

    // Explicit error for param.X — parameters are read-only after M98 invocation.
    if (val.startsWith('param.')) {
      errors.push({
        severity: 'error',
        message: `macro parameters are read-only — 'set param.<n>' is not allowed`,
        ...span(targetTok),
      });
      return errors;
    }

    if (!val.startsWith('var.') && !val.startsWith('global.')) {
      errors.push({ message: `'set' requires 'var.<n>' or 'global.<n>', got '${val}'`, ...span(targetTok) });
      return errors;
    }

    if (val.startsWith('var.') && ctx) {
      const varName = val.slice(4).split('[')[0];
      const decl = ctx.symbolTable.lookupVarAtLine(varName, ctx.uri, ctx.line, ctx.indent);
      if (!decl) {
        errors.push({
          severity: 'error',
          message: `undefined variable 'var.${varName}' — declare it with 'var ${varName} = ...' first`,
          ...span(targetTok),
        });
      }
    }

    // Undefined global → warning only (may be declared elsewhere or at runtime)
    if (val.startsWith('global.') && ctx) {
      const globalName = val.slice(7).split('[')[0];
      const decl = ctx.symbolTable.lookupGlobal(globalName);
      if (!decl) {
        errors.push({
          severity: 'warning',
          message: `'global.${globalName}' not found in any open file — it may be declared in another macro or created at runtime`,
          ...span(targetTok),
        });
      }
    }

    let exprStart = 2;
    while (tokens[exprStart]?.type === TokenType.LBracket) {
      let depth = 1; exprStart++;
      while (exprStart < tokens.length && depth > 0) {
        const tt = tokens[exprStart].type;
        if (tt === TokenType.LBracket) depth++;
        if (tt === TokenType.RBracket) depth--;
        exprStart++;
      }
    }
    if (tokens[exprStart]?.type === TokenType.Eq) exprStart++;
    const exprTokens = tokens.slice(exprStart);
    if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
      errors.push(...new ExpressionValidator(exprTokens).validate());
      if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    }
    return errors;
  }

  // ── G/M/T code line ───────────────────────────────────────────────────────
  if (first.type === TokenType.GCode || first.type === TokenType.TCode) {
    checkAdjacentNumberString(tokens, errors);
    return errors;
  }

  // ── Valid no-op line-starts ───────────────────────────────────────────────
  const noopStarts = new Set([
    TokenType.Else, TokenType.Break, TokenType.Continue,
    TokenType.Skip, TokenType.Param,
  ]);
  if (noopStarts.has(first.type)) return errors;

  // ── Unknown command ───────────────────────────────────────────────────────
  if (first.type === TokenType.Identifier || first.type === TokenType.Unknown) {
    errors.push({ message: `unknown command '${first.value}'`, ...span(first) });
    return errors;
  }

  return errors;
}

// ── Bare identifier OM check ─────────────────────────────────────────────────
//
// Warns when an expression contains a bare identifier that is:
//   1. Not a qualified name (var./global./param.)
//   2. Not an OM-known path
//   3. NOT immediately after a Dot token in the token stream
//
// Rule (3) is crucial: in `move.axes[0].homed` the lexer produces:
//   Identifier("move.axes"), LBracket, Integer, RBracket, Dot, Identifier("homed")
// "homed" follows a Dot so it is a member name, not a standalone identifier.
// Similarly `boards[0].vIn.current` → Identifier("boards"), [...], Dot, Identifier("vIn.current")
// "vIn.current" follows a Dot — skip it.
//
// The OM path checking is done on the START of the expression: the first
// Identifier token before any brackets. The full path check including member
// access is done in hover.ts (reconstructOmPath). Here we only warn for
// identifiers that stand alone (not preceded by Dot).
function checkBareIdentifiers(tokens: Token[], ctx: DiagnosticContext): ParseError[] {
  const errors: ParseError[] = [];
  if (!ctx.isValidOmPath) return errors;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== TokenType.Identifier) continue;
    const v = t.value;
    // Skip qualified names — handled separately
    if (v.startsWith('var.') || v.startsWith('global.') || v.startsWith('param.')) continue;
    // Skip member names that follow a Dot (they are fields of an OM path, not roots)
    if (i > 0 && tokens[i - 1]?.type === TokenType.Dot) continue;
    // Normalise and check the root segment of the path
    const normalised = v.replace(/\[\d+\]/g, '[]');
    if (!ctx.isValidOmPath(normalised)) {
      errors.push({
        severity: 'warning',
        message: `'${v}' is not a known Object Model path — did you mean 'var.${v}'?`,
        ...span(t),
      });
    }
  }
  return errors;
}

// ── Adjacent number+string detection ─────────────────────────────────────────
function checkAdjacentNumberString(tokens: Token[], errors: ParseError[]): void {
  const numericTypes = new Set([TokenType.Integer, TokenType.Float, TokenType.HexInteger, TokenType.BinInteger]);
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (
      numericTypes.has(t.type) &&
      (next.type === TokenType.StringLit || next.type === TokenType.CharLit) &&
      t.end === next.start
    ) {
      errors.push({
        message: `invalid syntax: number '${t.value}' directly followed by string literal — insert a space or operator`,
        start: t.start, end: next.end, line: t.line,
      });
    }
  }
}

// ── Bracket balance checker ───────────────────────────────────────────────────
function checkBracketBalance(tokens: Token[], errors: ParseError[]): void {
  const stack: Token[] = [];
  const PAIRS: Partial<Record<TokenType, TokenType>> = {
    [TokenType.LParen]: TokenType.RParen,
    [TokenType.LBrace]: TokenType.RBrace,
    [TokenType.LBracket]: TokenType.RBracket,
  };
  const CLOSERS = new Set([TokenType.RParen, TokenType.RBrace, TokenType.RBracket]);

  for (const t of tokens) {
    if (t.type === TokenType.EOF || t.type === TokenType.Comment) break;
    if (PAIRS[t.type] !== undefined) {
      stack.push(t);
    } else if (CLOSERS.has(t.type)) {
      if (stack.length === 0) {
        errors.push({ message: `unexpected '${t.value}'`, ...span(t) });
      } else {
        const open = stack[stack.length - 1];
        if (PAIRS[open.type] !== t.type) {
          errors.push({
            message: `mismatched bracket: expected '${tokenChar(PAIRS[open.type]!)}' but got '${t.value}'`,
            ...span(t),
          });
          stack.pop();
        } else {
          stack.pop();
        }
      }
    }
  }

  for (const unclosed of stack) {
    errors.push({ message: `unclosed '${unclosed.value}'`, ...span(unclosed) });
  }
}

function span(t: Token): { start: number; end: number; line: number } {
  return { start: t.start, end: t.end, line: t.line };
}
function tokenChar(tt: TokenType): string {
  switch (tt) {
    case TokenType.RParen: return ')';
    case TokenType.RBrace: return '}';
    case TokenType.RBracket: return ']';
    default: return '?';
  }
}
