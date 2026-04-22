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

// ── Binary operators (priority table) ────────────────────────────────────────
//
// NOTE: TokenType.Not is intentionally ABSENT from this map.
// '!' is a UNARY-ONLY operator in RRF expressions. Writing it in binary
// position (e.g. `a ! b`) is a syntax error and will be reported by
// validateFull() as an unexpected token.  '!=' is the NEq token.
const BINARY_OPS = new Map<TokenType, number>([
  [TokenType.Ternary, 1],      // ?
  [TokenType.Caret, 2],        // ^ (string concat)
  [TokenType.And, 3],          // & / &&
  [TokenType.Or, 3],           // | / ||
  [TokenType.NEq, 4],          // !=
  [TokenType.Eq, 4],           // =  (comparison in expressions) / ==
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

// More than this many consecutive identical unary sign operators is an error.
// `--1` is suspicious but `------1` is definitely wrong.
const MAX_CONSECUTIVE_UNARY = 2;

// Token types that are pure numeric literals — '#' cannot be applied to these.
const NUMERIC_LITERAL_TYPES = new Set([
  TokenType.Integer,
  TokenType.Float,
  TokenType.HexInteger,
  TokenType.BinInteger,
]);

// Max args for known built-in functions
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

// ── ExpressionValidator ───────────────────────────────────────────────────────

export class ExpressionValidator {
  private pos = 0;
  private readonly tokens: Token[];
  readonly errors: ParseError[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ── Public entry points ────────────────────────────────────────────────────

  /**
   * Validate a single expression.
   * Does NOT check for trailing tokens — use validateFull() for that.
   */
  validate(): ParseError[] {
    this.parseInternal(0);
    return this.errors;
  }

  /**
   * Validate a single expression AND report any unexpected tokens that remain
   * after it.  This catches:
   *   • Binary operators in unary position:  `a ! b`  (! not in BINARY_OPS)
   *   • Two adjacent values:                 `1 2`    (missing operator)
   *   • Stray tokens:                        `a + b c`
   */
  validateFull(): ParseError[] {
    if (this.current().type === TokenType.EOF) return this.errors;
    this.parseInternal(0);
    const leftover = this.current();
    if (leftover.type !== TokenType.EOF && leftover.type !== TokenType.Comment) {
      const hint = this.isValueLike(leftover)
        ? ' — did you forget an operator between these two expressions?'
        : '';
      this.addError(`unexpected '${leftover.value}'${hint}`, leftover);
    }
    return this.errors;
  }

  /**
   * Validate a comma-separated list of expressions (for echo).
   */
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

  // ── Core recursive-descent parser ─────────────────────────────────────────

  private parseInternal(priority: number): void {
    this.parseUnaryOrPrimary();
    this.parseBinaryTail(priority);
  }

  // ── Unary prefix + primary ────────────────────────────────────────────────
  private parseUnaryOrPrimary(): void {
    const t = this.current();

    switch (t.type) {
      // ── Unary arithmetic sign  +  - ─────────────────────────────────────
      case TokenType.Minus:
      case TokenType.Plus: {
        // Count consecutive sign operators to catch `------1` style mistakes.
        let count = 0;
        let scan = this.pos;
        while (
          scan < this.tokens.length &&
          (this.tokens[scan].type === TokenType.Minus ||
            this.tokens[scan].type === TokenType.Plus)
        ) {
          count++;
          scan++;
        }

        if (count > MAX_CONSECUTIVE_UNARY) {
          this.addError(
            `${count} consecutive unary '${t.value}' operators — this is almost certainly a mistake; ` +
            `use a single '-' or parentheses, e.g. -(expression)`,
            t,
          );
          // Skip all the duplicates so the rest of the line can still be parsed.
          for (let i = 0; i < count; i++) this.advance();
          this.parseUnaryOrPrimary();
          return;
        }

        this.advance();
        const posBefore = this.pos;
        this.parseInternal(10);
        if (this.pos === posBefore) {
          // Position didn't advance → we hit EOF with nothing to parse.
          this.addError(`expected an expression after unary '${t.value}'`, t);
        }
        return;
      }

      // ── Logical NOT  ! ────────────────────────────────────────────────────
      case TokenType.Not: {
        this.advance();
        const posBefore = this.pos;
        this.parseInternal(10);
        if (this.pos === posBefore) {
          this.addError(`expected an expression after '!'`, t);
        }
        return;
      }

      // ── Length / string-size operator  # ─────────────────────────────────
      //
      // '#' is only valid before:
      //   • An identifier  (#var.x, #global.arr, #sensors.probes)
      //   • A string literal  (#"hello")
      //   • A parenthesised expression  (#(expr))
      //   • An array literal  (#[a,b])
      //
      // It is NOT valid before a bare numeric literal like #10 or #3.14.
      case TokenType.Hash: {
        this.advance();
        const operand = this.current();

        if (operand.type === TokenType.EOF || operand.type === TokenType.Comment) {
          this.addError(
            `expected an identifier, string, or array after '#' — e.g. '#var.myArray'`,
            t,
          );
          return;
        }

        if (NUMERIC_LITERAL_TYPES.has(operand.type)) {
          this.addError(
            `'#' (length operator) cannot be applied to a numeric literal '${operand.value}' — ` +
            `use it with a string variable, array identifier, or string literal`,
            t,
          );
          this.advance(); // consume the bad operand so parsing continues
          return;
        }

        if (!this.isValidHashOperand(operand)) {
          this.addError(
            `'#' requires a string, array identifier, or parenthesised expression — ` +
            `got unexpected '${operand.value}'`,
            t,
          );
          return;
        }

        if (this.isAlpha(operand)) {
          this.parseIdentifierExpression();
        } else {
          // String literal, '(', '[', or '{'
          this.parseInternal(10);
        }
        return;
      }

      // ── Parenthesised expression  ( expr ) ───────────────────────────────
      case TokenType.LParen:
        this.advance();
        this.parseInternal(0);
        this.expect(TokenType.RParen, "expected ')'");
        return;

      // ── Array / object literal  { a, b, c } ──────────────────────────────
      case TokenType.LBrace:
        this.advance();
        this.parseInternal(0);
        while (this.current().type === TokenType.Comma) {
          this.advance();
          if (this.current().type === TokenType.RBrace) break;
          this.parseInternal(0);
        }
        this.expect(TokenType.RBrace, "expected '}'");
        return;

      // ── Array subscript  [ expr ] ─────────────────────────────────────────
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

      // ── Literals ──────────────────────────────────────────────────────────
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
        this.parseTrailingIndexes();
        return;

      // ── Function call ──────────────────────────────────────────────────────
      case TokenType.FunctionName:
        this.parseFunctionCall(t);
        return;

      // ── Qualified / OM identifiers  var.x  global.y  move.axes… ──────────
      case TokenType.Identifier:
        this.parseIdentifierExpression();
        return;

      // ── EOF: no-op — callers are responsible for reporting context errors ──
      case TokenType.EOF:
        return;

      default:
        if (t.type !== TokenType.Comment) {
          this.addError(`unexpected token '${t.value}'`, t);
          this.advance();
        }
        return;
    }
  }

  // ── Function call ──────────────────────────────────────────────────────────
  private parseFunctionCall(nameTok: Token): void {
    this.advance(); // consume function name
    const funcName = nameTok.value.toLowerCase();

    // Special: exists(expr) accepts an identifier, not a generic expression
    if (funcName === 'exists') {
      this.expect(TokenType.LParen, "expected '(' after 'exists'");
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

  // ── Identifier expression: var.x  global.y  param.z  move.axes… ──────────
  private parseIdentifierExpression(): void {
    const t = this.current();
    if (t.type === TokenType.Identifier || this.isKnownWordToken(t)) {
      this.advance();
    }
    this.parseTrailingIndexes();
  }

  // Handles postfix chains:  axes[0].homed   probes[0].value[0]
  // Also accepts FunctionName tokens as field names after '.' (e.g. axes[0].max).
  private parseTrailingIndexes(): void {
    for (; ;) {
      if (this.current().type === TokenType.LBracket) {
        this.advance();
        this.parseInternal(0);
        this.expect(TokenType.RBracket, "expected ']'");
      } else if (this.current().type === TokenType.Dot) {
        const dotTok = this.current();
        this.advance();
        const ft = this.current();
        if (
          ft.type === TokenType.Identifier ||
          ft.type === TokenType.FunctionName ||
          this.isKnownWordToken(ft)
        ) {
          this.advance();
        } else if (ft.type === TokenType.EOF || ft.type === TokenType.Comment) {
          // Trailing dot with nothing after: `var.x.`
          this.addError(
            `incomplete member access — expected a field name after '.'`,
            dotTok,
          );
          break;
        } else {
          // Dot followed by something unexpected: `var.x.123`
          this.addError(`expected a field name after '.', got '${ft.value}'`, dotTok);
          break;
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

      this.advance(); // consume the binary operator

      // Guard: dangling operator — nothing on the right-hand side.
      const next = this.current();
      if (next.type === TokenType.EOF || next.type === TokenType.Comment) {
        this.addError(
          `dangling '${t.value}' — expected an expression after the operator`,
          t,
        );
        return;
      }

      // Ternary  expr ? consequent : alternative
      if (t.type === TokenType.Ternary) {
        this.parseInternal(prio); // consequent
        if (this.current().type === TokenType.EOF) {
          this.addError(
            `incomplete ternary expression — expected ':' followed by the alternative value`,
            t,
          );
          return;
        }
        this.expect(TokenType.Colon, "expected ':' in ternary expression");
        if (this.current().type === TokenType.EOF) {
          this.addError(
            `incomplete ternary expression — expected an expression after ':'`,
            t,
          );
          return;
        }
        this.parseInternal(prio - 1); // alternative
        return;
      }

      this.parseInternal(prio);
    }
  }

  // ── Low-level helpers ──────────────────────────────────────────────────────

  private current(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0, start: 0, end: 0 };
  }

  private advance(): Token {
    return this.tokens[this.pos++] ?? { type: TokenType.EOF, value: '', line: 0, start: 0, end: 0 };
  }

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

  /** True if the token starts with a letter (identifier, function name, named constant). */
  private isAlpha(t: Token): boolean {
    return (
      t.type === TokenType.Identifier ||
      t.type === TokenType.FunctionName ||
      (t.type >= TokenType.True && t.type <= TokenType.Input)
    );
  }

  private isKnownWordToken(t: Token): boolean {
    return t.type >= TokenType.True && t.type <= TokenType.Input;
  }

  /**
   * True if this token looks like it begins a value (i.e. an expression operand).
   * Used to produce a better hint when two adjacent values are found without an operator.
   */
  private isValueLike(t: Token): boolean {
    return (
      t.type === TokenType.Identifier ||
      t.type === TokenType.FunctionName ||
      t.type === TokenType.Integer ||
      t.type === TokenType.Float ||
      t.type === TokenType.HexInteger ||
      t.type === TokenType.BinInteger ||
      t.type === TokenType.StringLit ||
      t.type === TokenType.CharLit ||
      t.type === TokenType.True ||
      t.type === TokenType.False ||
      t.type === TokenType.Null ||
      t.type === TokenType.Pi ||
      t.type === TokenType.Iterations ||
      t.type === TokenType.Line ||
      t.type === TokenType.Result ||
      t.type === TokenType.Input
    );
  }

  /**
   * Returns true if the given token is a valid operand for '#'.
   * '#' is defined only for strings, arrays (identifiers), and parenthesised expressions.
   */
  private isValidHashOperand(t: Token): boolean {
    return (
      this.isAlpha(t) ||
      t.type === TokenType.StringLit ||
      t.type === TokenType.LParen ||
      t.type === TokenType.LBracket ||
      t.type === TokenType.LBrace
    );
  }
}

// ── Full-line validation ───────────────────────────────────────────────────────
//
// Dispatches to the correct sub-validator based on the first meaningful token.

export function validateLine(
  tokens: Token[],
  lineText: string,
  ctx?: DiagnosticContext,
): ParseError[] {
  const errors: ParseError[] = [];
  if (!tokens.length) return errors;

  const first = tokens[0];
  if (first.type === TokenType.EOF || first.type === TokenType.Comment) return errors;

  // Bracket balance is checked unconditionally — mismatched brackets produce
  // errors regardless of which command the line represents.
  checkBracketBalance(tokens, errors);

  // ── echo [> file] expr, expr, … ─────────────────────────────────────────
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
        exprStart++;
      } else if (filenameTok?.type === TokenType.LBrace) {
        let depth = 1;
        exprStart++;
        while (exprStart < tokens.length && depth > 0) {
          const tt = tokens[exprStart].type;
          if (tt === TokenType.EOF || tt === TokenType.Comment) break;
          if (tt === TokenType.LBrace) depth++;
          if (tt === TokenType.RBrace) depth--;
          exprStart++;
        }
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

  // ── if / elif / while — condition is MANDATORY ────────────────────────────
  if (
    first.type === TokenType.If ||
    first.type === TokenType.Elif ||
    first.type === TokenType.While
  ) {
    const exprTokens = tokens.slice(1);
    if (
      exprTokens.length === 0 ||
      exprTokens[0].type === TokenType.EOF ||
      exprTokens[0].type === TokenType.Comment
    ) {
      errors.push({
        message: `'${first.value}' requires a condition expression`,
        ...span(first),
      });
      return errors;
    }
    errors.push(...new ExpressionValidator(exprTokens).validateFull());
    if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    return errors;
  }

  // ── else — must stand alone, never takes a condition ──────────────────────
  if (first.type === TokenType.Else) {
    const nextTok = tokens[1];
    if (nextTok && nextTok.type !== TokenType.EOF && nextTok.type !== TokenType.Comment) {
      errors.push({
        message: `'else' does not take a condition — did you mean 'elif ${nextTok.value}…'?`,
        ...span(nextTok),
      });
    }
    return errors;
  }

  // ── abort [message] — message is optional ─────────────────────────────────
  if (first.type === TokenType.Abort) {
    const exprTokens = tokens.slice(1);
    if (
      exprTokens.length > 0 &&
      exprTokens[0].type !== TokenType.EOF &&
      exprTokens[0].type !== TokenType.Comment
    ) {
      errors.push(...new ExpressionValidator(exprTokens).validateFull());
      if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    }
    return errors;
  }

  // ── var <name> = <expr> ───────────────────────────────────────────────────
  //
  // '=' and a right-hand value are BOTH mandatory.
  // `var foo` or `var foo =` are syntax errors.
  if (first.type === TokenType.Var) {
    const nameTok = tokens[1];
    if (!nameTok || nameTok.type !== TokenType.Identifier) {
      errors.push({ message: "expected a variable name after 'var'", ...span(first) });
      return errors;
    }

    // Duplicate detection within the same lexical scope
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

    // '=' is mandatory
    const eqTok = tokens[2];
    if (!eqTok || eqTok.type === TokenType.EOF) {
      errors.push({
        message:
          `'var' declaration requires an initial value — ` +
          `use 'var ${nameTok.value} = <expression>'`,
        ...span(nameTok),
      });
      return errors;
    }
    if (eqTok.type !== TokenType.Eq) {
      errors.push({
        message: `expected '=' after '${nameTok.value}', got '${eqTok.value}'`,
        ...span(eqTok),
      });
      return errors;
    }

    // Expression after '=' is mandatory
    const exprTokens = tokens.slice(3);
    if (exprTokens.length === 0 || exprTokens[0].type === TokenType.EOF) {
      errors.push({ message: `expected an expression after '='`, ...span(eqTok) });
      return errors;
    }

    errors.push(...new ExpressionValidator(exprTokens).validateFull());
    if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    return errors;
  }

  // ── global <name> = <expr> ────────────────────────────────────────────────
  //
  // Same rules as 'var': '=' and a value are mandatory.
  // Duplicate detection is intentionally omitted — the common RRF pattern is:
  //   if !exists(global.x)
  //     global x = value
  if (first.type === TokenType.Global) {
    const nameTok = tokens[1];
    if (!nameTok || nameTok.type !== TokenType.Identifier) {
      errors.push({ message: "expected a variable name after 'global'", ...span(first) });
      return errors;
    }

    // '=' is mandatory
    const eqTok = tokens[2];
    if (!eqTok || eqTok.type === TokenType.EOF) {
      errors.push({
        message:
          `'global' declaration requires an initial value — ` +
          `use 'global ${nameTok.value} = <expression>'`,
        ...span(nameTok),
      });
      return errors;
    }
    if (eqTok.type !== TokenType.Eq) {
      errors.push({
        message: `expected '=' after '${nameTok.value}', got '${eqTok.value}'`,
        ...span(eqTok),
      });
      return errors;
    }

    // Expression is mandatory
    const exprTokens = tokens.slice(3);
    if (exprTokens.length === 0 || exprTokens[0].type === TokenType.EOF) {
      errors.push({ message: `expected an expression after '='`, ...span(eqTok) });
      return errors;
    }

    errors.push(...new ExpressionValidator(exprTokens).validateFull());
    if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    return errors;
  }

  // ── param <LETTER> [= <expr>] ──────────────────────────────────────────────
  //
  // G-code parameter names are a SINGLE UPPERCASE LETTER (A–Z).
  // These correspond to G-code word letters at the M98 call site.
  // Examples:
  //   param Z          — caller must supply Z; error if omitted
  //   param Z = 0.5    — Z optional; defaults to 0.5
  //
  // `param a = 10` is an error — lowercase, should be 'A'.
  // `param abc = 0`  is an error — multi-character name.
  if (first.type === TokenType.Param) {
    const nameTok = tokens[1];
    if (!nameTok || nameTok.type === TokenType.EOF) {
      errors.push({ message: "expected a parameter name after 'param'", ...span(first) });
      return errors;
    }
    if (nameTok.type !== TokenType.Identifier) {
      errors.push({
        message: `expected a parameter name after 'param', got '${nameTok.value}'`,
        ...span(nameTok),
      });
      return errors;
    }

    // Validate: must be exactly one uppercase letter A–Z
    if (!/^[A-Z]$/.test(nameTok.value)) {
      const hint = nameTok.value.length === 1
        ? `did you mean 'param ${nameTok.value.toUpperCase()}'?`
        : `G-code parameter names must be a single uppercase letter (A–Z), e.g. 'param Z = 0'`;
      errors.push({
        message: `invalid param name '${nameTok.value}' — ${hint}`,
        ...span(nameTok),
      });
      return errors;
    }

    // Optional default value
    let exprStart = 2;
    if (tokens[exprStart]?.type === TokenType.Eq) {
      exprStart++;
      const exprTokens = tokens.slice(exprStart);
      if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
        errors.push(...new ExpressionValidator(exprTokens).validateFull());
        if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
      } else {
        // `param Z =` with nothing after '='
        errors.push({
          message: "expected a default value expression after '='",
          ...span(tokens[exprStart - 1]),
        });
      }
    } else if (
      tokens[exprStart] &&
      tokens[exprStart].type !== TokenType.EOF &&
      tokens[exprStart].type !== TokenType.Comment
    ) {
      // Something unexpected after the name: `param Z 42`
      errors.push({
        message: `unexpected '${tokens[exprStart].value}' — expected '=' or end of line`,
        ...span(tokens[exprStart]),
      });
    }
    return errors;
  }

  // ── set <var.name | global.name> [index] = <expr> ────────────────────────
  //
  // '=' is MANDATORY. `set var.x` without a value is a syntax error.
  if (first.type === TokenType.Set) {
    const targetTok = tokens[1];

    if (!targetTok || targetTok.type === TokenType.EOF) {
      errors.push({
        message: "expected 'var.<name>' or 'global.<name>' after 'set'",
        ...span(first),
      });
      return errors;
    }
    if (targetTok.type !== TokenType.Identifier) {
      errors.push({
        message: `'set' can only assign to 'var.<name>' or 'global.<name>'`,
        ...span(targetTok),
      });
      return errors;
    }

    const val = targetTok.value;

    // param.X is read-only
    if (val.startsWith('param.')) {
      errors.push({
        severity: 'error',
        message: `macro parameters are read-only — 'set param.<name>' is not allowed`,
        ...span(targetTok),
      });
      return errors;
    }

    if (!val.startsWith('var.') && !val.startsWith('global.')) {
      errors.push({
        message: `'set' requires 'var.<name>' or 'global.<name>', got '${val}'`,
        ...span(targetTok),
      });
      return errors;
    }

    // Undefined var → hard error
    if (val.startsWith('var.') && ctx) {
      const varName = val.slice(4).split('[')[0];
      if (!ctx.symbolTable.lookupVarAtLine(varName, ctx.uri, ctx.line, ctx.indent)) {
        errors.push({
          severity: 'error',
          message: `undefined variable 'var.${varName}' — declare it with 'var ${varName} = ...' first`,
          ...span(targetTok),
        });
      }
    }

    // Undefined global → warning only (may be declared elsewhere / at runtime)
    if (val.startsWith('global.') && ctx) {
      const globalName = val.slice(7).split('[')[0];
      if (!ctx.symbolTable.lookupGlobal(globalName)) {
        errors.push({
          severity: 'warning',
          message:
            `'global.${globalName}' not found in any open file — ` +
            `it may be declared in another macro or created at runtime`,
          ...span(targetTok),
        });
      }
    }

    // Consume optional subscript(s):  set var.arr[0] = …
    let exprStart = 2;
    while (tokens[exprStart]?.type === TokenType.LBracket) {
      let depth = 1;
      exprStart++;
      while (exprStart < tokens.length && depth > 0) {
        const tt = tokens[exprStart].type;
        if (tt === TokenType.LBracket) depth++;
        if (tt === TokenType.RBracket) depth--;
        exprStart++;
      }
    }

    // '=' is mandatory
    const eqTok = tokens[exprStart];
    if (!eqTok || eqTok.type === TokenType.EOF) {
      errors.push({
        message: `'set' requires an assignment — use 'set ${val} = <expression>'`,
        ...span(targetTok),
      });
      return errors;
    }
    if (eqTok.type !== TokenType.Eq) {
      errors.push({
        message: `expected '=' after '${val}', got '${eqTok.value}'`,
        ...span(eqTok),
      });
      return errors;
    }
    exprStart++; // consume '='

    // Expression after '=' is mandatory
    const exprTokens = tokens.slice(exprStart);
    if (exprTokens.length === 0 || exprTokens[0].type === TokenType.EOF) {
      errors.push({ message: `expected an expression after '='`, ...span(eqTok) });
      return errors;
    }

    errors.push(...new ExpressionValidator(exprTokens).validateFull());
    if (ctx?.isValidOmPath) errors.push(...checkBareIdentifiers(exprTokens, ctx));
    return errors;
  }

  // ── G/M/T code line ───────────────────────────────────────────────────────
  if (first.type === TokenType.GCode || first.type === TokenType.TCode) {
    checkAdjacentNumberString(tokens, errors);
    return errors;
  }

  // ── Valid standalone meta keywords (no further validation needed) ─────────
  if (
    first.type === TokenType.Break ||
    first.type === TokenType.Continue ||
    first.type === TokenType.Skip
  ) {
    return errors;
  }

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
//   3. NOT immediately after a Dot token (i.e. not a member access)
//
// Rule 3 is critical: in `move.axes[0].homed` the lexer produces:
//   Identifier("move.axes") [LBracket] [Integer] [RBracket] [Dot] Identifier("homed")
// "homed" follows a Dot → skip it.
function checkBareIdentifiers(tokens: Token[], ctx: DiagnosticContext): ParseError[] {
  const errors: ParseError[] = [];
  if (!ctx.isValidOmPath) return errors;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== TokenType.Identifier) continue;
    const v = t.value;
    if (v.startsWith('var.') || v.startsWith('global.') || v.startsWith('param.')) continue;
    if (i > 0 && tokens[i - 1]?.type === TokenType.Dot) continue;
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
  const numericTypes = new Set([
    TokenType.Integer, TokenType.Float, TokenType.HexInteger, TokenType.BinInteger,
  ]);
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (
      numericTypes.has(t.type) &&
      (next.type === TokenType.StringLit || next.type === TokenType.CharLit) &&
      t.end === next.start
    ) {
      errors.push({
        message:
          `invalid syntax: number '${t.value}' directly followed by string literal — ` +
          `insert a space or an explicit operator (e.g. '^' for concatenation)`,
        start: t.start,
        end: next.end,
        line: t.line,
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
            message:
              `mismatched bracket: expected '${tokenChar(PAIRS[open.type]!)}' but got '${t.value}'`,
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

// ── Internal utilities ────────────────────────────────────────────────────────

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
