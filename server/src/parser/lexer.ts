// parser/lexer.ts
// Tokenizes a single line of RRF G-code / meta-command syntax.
// Mirrors the character-level scanning in ExpressionParser.cpp and StringParser.cpp.

import {
    Token, TokenType,
    FUNCTION_NAMES, NAMED_CONSTANTS, META_KEYWORDS,
} from './types';

export interface LexError {
    message: string;
    start: number;
    end: number;
    line: number;
}

export class Lexer {
    private pos = 0;
    private readonly src: string;
    private readonly lineNum: number;
    private readonly _errors: LexError[] = [];

    // ── Meta-context state ─────────────────────────────────────────────────────
    //
    // inMetaContext: set to true when the first meaningful token on the line is a
    //   meta-command keyword (var, global, set, if, while, …).  While true:
    //     • G/M code regexes are NOT tried — letters like g and m are plain chars.
    //     • scanSegmentChars() does NOT stop at G/M + digit.
    //   This fixes false GCode recognition inside identifiers on meta-command lines:
    //     var testg1 = 1      →  testg1 is ONE identifier, not "test" + GCode(G1)
    //     var g1 = 0          →  g1     is ONE identifier, not GCode(G1)
    //     global testm1 = 1   →  testm1 is ONE identifier, not "test" + GCode(M1)
    //
    // expectingVarName: set to true after the first token is var / global / param.
    //   The VERY NEXT word token is forced to TokenType.Identifier regardless of
    //   whether it lexically matches a keyword or named constant.  This makes
    //   the following declarations valid (they ARE valid in RRF firmware):
    //     var iterations = 0   →  "iterations" is the variable name, not a constant
    //     var true = 0         →  "true"  is the variable name
    //     var while = 0        →  "while" is the variable name
    //   Access is still disambiguated at runtime: bare `iterations` → built-in
    //   constant; `var.iterations` → the local variable.
    private inMetaContext = false;
    private expectingVarName = false;

    // ── G-code parameter mode ─────────────────────────────────────────────────
    //
    // True once the first real token on the line is a GCode/TCode token.
    // While true AND braceDepth === 0, each isolated letter is lexed as a
    // standalone GCodeWord parameter token (P, S, R, X, …) and the value that
    // follows is a normal token (Integer, StringLit, LBrace, …).
    //
    //   M291 S4 K{"a","b"} R"text" P{var.x} F1
    //   └─cmd─┘└p┘└n┘└p┘└─expr─┘└p┘└─str─┘└p┘└─expr─┘└p┘└n┘
    //
    // Inside { … } (braceDepth > 0) we are in a real expression and identifiers
    // are scanned by the normal rules.
    private inGCodeParamMode = false;

    // ── Brace-expression context ──────────────────────────────────────────────
    //
    // braceDepth > 0 when the scanner is currently inside one or more `{ … }`
    // expression blocks embedded in a G-code line.  Example:
    //
    //   M291 P{var.msg1 ^ var.msg2} S4
    //          └──── braceDepth = 1 ────┘
    //
    // Inside such a block the content is a real RRF expression (same syntax as
    // `echo`, `if`, `set …`, etc.), not G-code parameters.  Therefore G/M
    // followed by a digit must NOT be treated as an inline G/M command — that
    // would shred ordinary identifiers such as `var.msg1`, `var.warnMsg1`,
    // `cmd2g3` etc. into pieces (`var.ms` + `G1`, `var.warnMs` + `G1`,
    // `cmd2` + `G3`).
    //
    // Effectively, the brace context promotes the scanner to the same
    // "G/M letters are plain letters" mode as `inMetaContext`.
    private braceDepth = 0;

    /** True when G/M + digit must NOT be recognised as inline G/M codes. */
    private get inExprContext(): boolean {
        return this.inMetaContext || this.braceDepth > 0;
    }

    constructor(src: string, lineNum = 0) {
        this.src = src;
        this.lineNum = lineNum;
    }

    get errors(): readonly LexError[] { return this._errors; }

    // ── Public entry point ─────────────────────────────────────────────────────
    tokenize(): Token[] {
        const tokens: Token[] = [];
        let firstRealToken = true;

        while (this.pos < this.src.length) {
            const tok = this.nextToken();
            if (tok) {
                if (firstRealToken && tok.type !== TokenType.Comment) {
                    firstRealToken = false;
                    // Determine meta context from the first real token.
                    this.inMetaContext = isMetaContextType(tok.type);
                    // G/M/T command lines: every isolated letter that follows
                    // is a G-code parameter word (P, S, R, …) until EOL.
                    this.inGCodeParamMode =
                        tok.type === TokenType.GCode || tok.type === TokenType.TCode;
                    // var / global / param introduce a bare variable name next.
                    this.expectingVarName =
                        tok.type === TokenType.Var ||
                        tok.type === TokenType.Global ||
                        tok.type === TokenType.Param;
                } else if (this.expectingVarName) {
                    // The previous token was var/global/param; the name has just
                    // been scanned.  Reset so subsequent tokens are classified normally.
                    this.expectingVarName = false;
                }

                // Track brace-expression depth.  `{` and `}` are single-char tokens
                // whose recognition does not depend on context, so updating after the
                // fact is safe — subsequent tokens scanned from `nextToken()` will see
                // the new depth via `inExprContext`.
                if (tok.type === TokenType.LBrace) this.braceDepth++;
                else if (tok.type === TokenType.RBrace && this.braceDepth > 0) this.braceDepth--;

                tokens.push(tok);
                if (tok.type === TokenType.Comment) break; // nothing after ;
            }
        }
        tokens.push(this.make(TokenType.EOF, '', this.pos, this.pos));
        return tokens;
    }

    // ── Core scanner ──────────────────────────────────────────────────────────
    private nextToken(): Token | null {
        this.skipWhitespace();
        if (this.pos >= this.src.length) return null;

        const start = this.pos;
        const c = this.src[this.pos];

        // Comment
        if (c === ';') {
            const value = this.src.slice(this.pos);
            this.pos = this.src.length;
            return this.make(TokenType.Comment, value, start, this.pos);
        }

        // String literal  "..."  (double-quote escaped as "")
        if (c === '"') return this.scanString(start);

        // Character literal  'X'
        if (c === "'") return this.scanChar(start);

        // Number: hex 0x..., bin 0b..., decimal/float
        if (this.isDigit(c) || (c === '0' && this.peek(1) === 'x') || (c === '0' && this.peek(1) === 'b')) {
            return this.scanNumber(start);
        }

        // ── G-code parameter word ─────────────────────────────────────────────
        // In G-code parameter mode (outside any { … } block) every isolated
        // letter is a standalone parameter word.  This guarantees consistent
        // syntax highlighting: the letter is always `parameter`, the value
        // after it is always its own token (Integer, StringLit, LBrace, …).
        //
        // Inside { … } we fall through to the normal identifier scanner so
        // that expressions like `{var.x + 1}` work as before.
        //
        // EXCEPTIONS (delegate to scanWord instead):
        //   a) Qualified identifiers — `var.x`, `global.y`, `param.z`.  These
        //      can appear unbraced in malformed-but-recoverable expressions
        //      like   `M291 P"foo " ^ var.bar ^ "baz"`   and we want hover /
        //      rename / go-to-definition to keep working on them.
        //   b) Inline G/M command codes — `M42P2S1M42P3S0` is a chain of two
        //      separate commands; the second `M42` must lex as a fresh GCode
        //      token, not as `GCodeWord("M")` + `Integer(42)`.
        //   c) Member-access continuations — a letter directly after a `.` is a
        //      field name in a qualified path, e.g. the `machinePosition` in the
        //      unbraced `move.axes[2].machinePosition`.  The base (`move.axes`)
        //      is recovered by isQualifiedIdentStart, but the segment after an
        //      array subscript begins a fresh token whose `.`-prefix is the only
        //      signal that it continues the path rather than starting a run of
        //      single-letter parameter words (M, A, C, H, I, N, E, …).
        //
        // NOTE: a `T` followed by a digit/`-` is intentionally NOT an exception.
        // Unlike G/M, a mid-command `T` is a parameter letter — the tool number
        // in `M568 T0`, `M104 S200 T1`, the dialog timeout in `M291 … T10`, etc.
        // A command line can never take another G/M command as an argument, but
        // `T` is a valid argument, so here `T<n>` lexes as GCodeWord("T") + value
        // (a `parameter`), not as a `TCode` tool-change command.  A `T` command
        // is still recognised when it is the FIRST token of the line (head),
        // because G-code parameter mode is only entered after the head token.
        if (this.inGCodeParamMode && this.braceDepth === 0 && this.isAlpha(c)) {
            const isInlineGM = (c === 'G' || c === 'g' || c === 'M' || c === 'm')
                && this.pos + 1 < this.src.length
                && /\d/.test(this.src[this.pos + 1]);
            const isMemberContinuation = start > 0 && this.src[start - 1] === '.';

            if (!isInlineGM && !isMemberContinuation && !this.isQualifiedIdentStart(this.pos)) {
                this.pos++;
                return this.make(TokenType.GCodeWord, c.toUpperCase(), start, this.pos);
            }
        }

        // Identifier / keyword / G-code / function / constant
        if (this.isAlpha(c) || c === '_') return this.scanWord(start);

        // Multi-character operators (checked longest-first)
        const op3 = this.src.slice(this.pos, this.pos + 3);
        if (op3 === '>>>') { this.pos += 3; return this.make(TokenType.TripleGt, op3, start, this.pos); }

        const op2 = this.src.slice(this.pos, this.pos + 2);
        switch (op2) {
            case '>>': this.pos += 2; return this.make(TokenType.DoubleGt, op2, start, this.pos);
            case '==': this.pos += 2; return this.make(TokenType.EqEq, op2, start, this.pos);
            case '!=': this.pos += 2; return this.make(TokenType.NEq, op2, start, this.pos);
            case '<=': this.pos += 2; return this.make(TokenType.LtEq, op2, start, this.pos);
            case '>=': this.pos += 2; return this.make(TokenType.GtEq, op2, start, this.pos);
            case '&&': this.pos += 2; return this.make(TokenType.And, op2, start, this.pos);
            case '||': this.pos += 2; return this.make(TokenType.Or, op2, start, this.pos);
        }

        // Single-character operators / brackets
        this.pos++;
        switch (c) {
            case '+': return this.make(TokenType.Plus, c, start, this.pos);
            case '-': return this.make(TokenType.Minus, c, start, this.pos);
            case '*': return this.make(TokenType.Star, c, start, this.pos);
            case '/': return this.make(TokenType.Slash, c, start, this.pos);
            case '^': return this.make(TokenType.Caret, c, start, this.pos);
            case '=': return this.make(TokenType.Eq, c, start, this.pos);
            case '<': return this.make(TokenType.Lt, c, start, this.pos);
            case '>': return this.make(TokenType.Gt, c, start, this.pos);
            case '&': return this.make(TokenType.And, c, start, this.pos);
            case '|': return this.make(TokenType.Or, c, start, this.pos);
            case '!': return this.make(TokenType.Not, c, start, this.pos);
            case '?': return this.make(TokenType.Ternary, c, start, this.pos);
            case ':': return this.make(TokenType.Colon, c, start, this.pos);
            case '#': return this.make(TokenType.Hash, c, start, this.pos);
            case '(': return this.make(TokenType.LParen, c, start, this.pos);
            case ')': return this.make(TokenType.RParen, c, start, this.pos);
            case '{': return this.make(TokenType.LBrace, c, start, this.pos);
            case '}': return this.make(TokenType.RBrace, c, start, this.pos);
            case '[': return this.make(TokenType.LBracket, c, start, this.pos);
            case ']': return this.make(TokenType.RBracket, c, start, this.pos);
            case '.': return this.make(TokenType.Dot, c, start, this.pos);
            case ',': return this.make(TokenType.Comma, c, start, this.pos);
            default: return this.make(TokenType.Unknown, c, start, this.pos);
        }
    }

    // ── String literal ─────────────────────────────────────────────────────────
    //
    // RRF uses doubled quotes for escaping: `"he said ""hi"""` represents the
    // text  he said "hi".  We record each `""` span so the semantic-tokens
    // pass can highlight escapes distinctly from the surrounding content.
    private scanString(start: number): Token {
        this.pos++; // skip opening "
        let closed = false;
        const escapes: Array<{ start: number; end: number }> = [];
        while (this.pos < this.src.length) {
            const charPos = this.pos;
            const c = this.src[this.pos++];
            if (c === '"') {
                if (this.src[this.pos] === '"') {
                    // Escaped "" — record its span (2 chars) and consume the second quote.
                    escapes.push({ start: charPos, end: charPos + 2 });
                    this.pos++;
                } else {
                    closed = true;
                    break; // end of string
                }
            }
        }
        if (!closed) {
            this._errors.push({
                message: 'unclosed string literal',
                start,
                end: this.pos,
                line: this.lineNum,
            });
        }
        const tok = this.make(TokenType.StringLit, this.src.slice(start, this.pos), start, this.pos);
        if (escapes.length > 0) tok.escapes = escapes;
        if (!closed) tok.unclosed = true;
        return tok;
    }

    // ── Character literal  'X' ─────────────────────────────────────────────────
    private scanChar(start: number): Token {
        this.pos++; // skip '
        if (this.pos < this.src.length) this.pos++; // the char itself
        if (this.pos < this.src.length && this.src[this.pos] === "'") this.pos++; // closing '
        return this.make(TokenType.CharLit, this.src.slice(start, this.pos), start, this.pos);
    }

    // ── Number ─────────────────────────────────────────────────────────────────
    private scanNumber(start: number): Token {
        const rest = this.src.slice(this.pos);

        // Hex: 0x[0-9a-fA-F]+
        const hexM = /^0x[0-9a-fA-F]+/i.exec(rest);
        if (hexM) {
            this.pos += hexM[0].length;
            return this.make(TokenType.HexInteger, hexM[0], start, this.pos);
        }

        // Binary: 0b[01]+
        const binM = /^0b[01]+/i.exec(rest);
        if (binM) {
            this.pos += binM[0].length;
            return this.make(TokenType.BinInteger, binM[0], start, this.pos);
        }

        // Float / Int
        const numM = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
        if (numM) {
            this.pos += numM[0].length;
            const isFloat = numM[0].includes('.') || /[eE]/.test(numM[0]);
            return this.make(isFloat ? TokenType.Float : TokenType.Integer, numM[0], start, this.pos);
        }

        // Fallback: single digit
        this.pos++;
        return this.make(TokenType.Integer, this.src[start], start, this.pos);
    }

    // ── Word: G-code, meta keyword, function, constant, identifier ─────────────
    private scanWord(start: number): Token {
        const rest = this.src.slice(this.pos);

        // ── G/M codes ──────────────────────────────────────────────────────────
        if (!this.inExprContext) {
            const gcodeM = /^[GM]\d+(?:\.\d+)?(?![a-zA-Z_][a-zA-Z_])/i.exec(rest);
            if (gcodeM) {
                this.pos += gcodeM[0].length;
                return this.make(TokenType.GCode, gcodeM[0].toUpperCase(), start, this.pos);
            }

            const tcodeM = /^T(?:-?\d+(?![a-zA-Z0-9_])|(?![a-zA-Z0-9_\d]))/i.exec(rest);
            if (tcodeM) {
                this.pos += tcodeM[0].length;
                return this.make(TokenType.TCode, tcodeM[0].toUpperCase(), start, this.pos);
            }
        }

        // ── General identifier ─────────────────────────────────────────────────
        const raw = this.scanIdentifierStr();
        if (!raw) {
            this.pos++;
            return this.make(TokenType.Unknown, this.src[start], start, this.pos);
        }
        this.pos += raw.length;

        if (this.expectingVarName) {
            return this.make(TokenType.Identifier, raw, start, this.pos);
        }

        const lower = raw.toLowerCase();

        // Named constants
        if (NAMED_CONSTANTS.has(lower)) {
            const tt = namedConstantType(lower);
            return this.make(tt, raw, start, this.pos);
        }

        // Meta keywords (only bare name, not qualified e.g. "var.something")
        if (raw.indexOf('.') === -1 && META_KEYWORDS[lower] !== undefined) {
            return this.make(META_KEYWORDS[lower], raw, start, this.pos);
        }

        // Functions: plain name followed (eventually) by '('
        if (FUNCTION_NAMES.has(lower) && raw.indexOf('.') === -1) {
            return this.make(TokenType.FunctionName, raw, start, this.pos);
        }

        return this.make(TokenType.Identifier, raw, start, this.pos);
    }

    // ── Identifier string scanner ──────────────────────────────────────────────
    //
    // Scans from `this.pos`, returns the raw identifier string without advancing
    // `this.pos`.  The caller is responsible for updating `this.pos`.
    //
    // Rules:
    //   • Consumes [a-zA-Z_][a-zA-Z0-9_]* for each segment.
    //   • Outside expression context: stops BEFORE a G or M (case-insensitive)
    //     that is immediately followed by a digit — those are inline G/M commands.
    //   • Inside expression context (meta-command line OR inside `{ … }`):
    //     G and M are plain letters; never break.
    //   • Extends across dots to handle qualified names: var.foo, global.bar,
    //     param.baz.  Dot extension only when dot is followed by a letter/_.
    /**
     * Look-ahead from `i`: returns true if the source starts a qualified
     * identifier such as `var.x`, `global.y`, `param.z`, `move.axes.x`.
     * The criterion is: a non-empty run of [a-zA-Z_][a-zA-Z0-9_]* followed
     * directly by a `.` and then another identifier character.
     *
     * Used by `nextToken` to suppress GCodeWord lexing when the current
     * letter is the start of a qualified identifier (which can appear
     * unbraced in malformed expressions — see comment at the call site).
     */
    private isQualifiedIdentStart(i: number): boolean {
        const src = this.src;
        if (i >= src.length || !/[a-zA-Z_]/.test(src[i])) return false;
        let j = i + 1;
        while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
        return j < src.length - 1 && src[j] === '.' && /[a-zA-Z_]/.test(src[j + 1]);
    }

    private scanIdentifierStr(): string {
        const src = this.src;
        let i = this.pos;

        // Must start with a letter or underscore
        if (i >= src.length || !/[a-zA-Z_]/.test(src[i])) return '';

        i = this.scanSegmentChars(src, i);

        // Extend with dot-qualified segments (var.x, global.y, etc.)
        while (
            i < src.length &&
            src[i] === '.' &&
            i + 1 < src.length &&
            /[a-zA-Z_]/.test(src[i + 1])
        ) {
            i++; // consume the dot
            i = this.scanSegmentChars(src, i);
        }

        return src.slice(this.pos, i);
    }

    // Scan one contiguous segment of word-chars [a-zA-Z0-9_].
    //
    // Outside expression context: stops BEFORE G/M immediately followed by a
    // digit (= new inline G/M command), e.g. allows `M42P2S1M42P3S0` to be
    // split correctly.
    //
    // Inside expression context (meta-command line OR inside `{ … }`):
    //   G and M are treated as ordinary letters.  This means
    //   `testg1`, `g1test`, `m100val`, `var.msg1`, `var.warnMsg1` etc. are all
    //   scanned as one complete token and never incorrectly split into an
    //   identifier + a GCode.
    private scanSegmentChars(src: string, i: number): number {
        while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) {
            const c = src[i];
            const isGM = c === 'G' || c === 'g' || c === 'M' || c === 'm';
            if (!this.inExprContext && isGM && i + 1 < src.length && /\d/.test(src[i + 1])) break;
            i++;
        }
        return i;
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    private skipWhitespace(): void {
        while (this.pos < this.src.length && (this.src[this.pos] === ' ' || this.src[this.pos] === '\t')) {
            this.pos++;
        }
    }

    private isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
    private isAlpha(c: string): boolean { return /[a-zA-Z_]/.test(c); }
    private peek(offset: number): string { return this.src[this.pos + offset] ?? ''; }

    private make(type: TokenType, value: string, start: number, end: number): Token {
        return { type, value, line: this.lineNum, start, end };
    }
}

// ── Named constant → TokenType lookup ────────────────────────────────────────
function namedConstantType(name: string): TokenType {
    switch (name) {
        case 'true': return TokenType.True;
        case 'false': return TokenType.False;
        case 'null': return TokenType.Null;
        case 'pi': return TokenType.Pi;
        case 'iterations': return TokenType.Iterations;
        case 'line': return TokenType.Line;
        case 'result': return TokenType.Result;
        case 'input': return TokenType.Input;
        default: return TokenType.Identifier;
    }
}

// ── Meta-context type check ────────────────────────────────────────────────────
//
// Returns true for token types that introduce a meta-command line.
// When any of these is the FIRST token on a line, G/M code recognition is
// suppressed for all subsequent tokens on that line.
function isMetaContextType(type: TokenType): boolean {
    switch (type) {
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
            return true;
        default:
            return false;
    }
}
