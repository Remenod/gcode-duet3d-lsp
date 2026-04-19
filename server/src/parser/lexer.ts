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

    constructor(src: string, lineNum = 0) {
        this.src = src;
        this.lineNum = lineNum;
    }

    get errors(): readonly LexError[] { return this._errors; }

    // ── Public entry point ─────────────────────────────────────────────────────
    tokenize(): Token[] {
        const tokens: Token[] = [];
        while (this.pos < this.src.length) {
            const tok = this.nextToken();
            if (tok) {
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
    private scanString(start: number): Token {
        this.pos++; // skip opening "
        let closed = false;
        while (this.pos < this.src.length) {
            const c = this.src[this.pos++];
            if (c === '"') {
                if (this.src[this.pos] === '"') {
                    this.pos++; // escaped "" → single "
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
        return this.make(TokenType.StringLit, this.src.slice(start, this.pos), start, this.pos);
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
        // G/M codes: [GM]\d+(\.\d+)?
        const gcodeM = /^[GM]\d+(?:\.\d+)?(?![a-zA-Z_])/i.exec(this.src.slice(this.pos));
        if (gcodeM) {
            this.pos += gcodeM[0].length;
            return this.make(TokenType.GCode, gcodeM[0].toUpperCase(), start, this.pos);
        }

        // T-code: T followed by optional digit(s)
        const tcodeM = /^T(-?\d+)?(?![a-zA-Z_])/i.exec(this.src.slice(this.pos));
        if (tcodeM) {
            this.pos += tcodeM[0].length;
            return this.make(TokenType.TCode, tcodeM[0].toUpperCase(), start, this.pos);
        }

        // General identifier (may include dots for var.x, global.x)
        // RRF identifiers: letters, digits, underscores, and dots for namespacing
        const idM = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*/.exec(this.src.slice(this.pos));
        if (!idM) {
            this.pos++;
            return this.make(TokenType.Unknown, this.src[start], start, this.pos);
        }

        this.pos += idM[0].length;
        const raw = idM[0];
        const lower = raw.toLowerCase();

        // Named constants
        if (NAMED_CONSTANTS.has(lower)) {
            const tt = namedConstantType(lower);
            return this.make(tt, raw, start, this.pos);
        }

        // Meta keywords (only first segment, e.g. "var" not "var.something")
        if (raw.indexOf('.') === -1 && META_KEYWORDS[lower] !== undefined) {
            return this.make(META_KEYWORDS[lower], raw, start, this.pos);
        }

        // Functions: plain name followed (eventually) by '('
        if (FUNCTION_NAMES.has(lower) && raw.indexOf('.') === -1) {
            return this.make(TokenType.FunctionName, raw, start, this.pos);
        }

        return this.make(TokenType.Identifier, raw, start, this.pos);
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
