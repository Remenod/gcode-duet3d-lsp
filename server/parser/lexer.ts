import { Position, Range } from 'vscode-languageserver/node';

export enum TokenType {
    CommandLetter,  // G, M, T
    Parameter,      // X, Y, Z, F
    Number,         // 10, -5.5
    String,         // "text"
    Keyword,        // if, while, global
    Identifier,     // var_name, move.axes
    Operator,       // +, -, ==, &&
    OpenBrace,      // {
    CloseBrace,     // }
    Comment,        // ; ...
    EOF
}

export interface Token {
    type: TokenType;
    value: string;
    range: Range;
}

export class Lexer {
    private source: string;
    private current = 0;
    private line = 0;
    private character = 0;

    constructor(source: string) {
        this.source = source;
    }

    public tokenize(): Token[] {
        const tokens: Token[] = [];
        while (!this.isAtEnd()) {
            this.skipWhitespace();
            if (this.isAtEnd()) break;

            const startPos = this.getPosition();
            const char = this.advance();

            // Comments
            if (char === ';') {
                const commentText = this.readUntil('\n');
                tokens.push(this.createToken(TokenType.Comment, ';' + commentText, startPos));
                continue;
            }

            // G, M, T
            if (/[GMT]/i.test(char) && this.isNextDigit()) {
                tokens.push(this.createToken(TokenType.CommandLetter, char.toUpperCase(), startPos));
                continue;
            }

            // ExpressionParser start
            if (char === '{') {
                tokens.push(this.createToken(TokenType.OpenBrace, '{', startPos));
                continue;
            }
            if (char === '}') {
                tokens.push(this.createToken(TokenType.CloseBrace, '}', startPos));
                continue;
            }

            if (/[0-9.-]/.test(char)) {
                const num = char + this.readWhile(/[0-9.]/);
                tokens.push(this.createToken(TokenType.Number, num, startPos));
                continue;
            }

            // Identifiers & Keywords
            if (/[a-zA-Z_]/.test(char)) {
                const word = char + this.readWhile(/[a-zA-Z0-9_.]/);
                const type = this.isKeyword(word) ? TokenType.Keyword : TokenType.Identifier;
                tokens.push(this.createToken(type, word, startPos));
                continue;
            }
        }
        tokens.push(this.createToken(TokenType.EOF, "", this.getPosition()));
        return tokens;
    }

    private advance(): string {
        const char = this.source[this.current++];
        if (char === '\n') {
            this.line++;
            this.character = 0;
        } else {
            this.character++;
        }
        return char;
    }

    private isAtEnd(): boolean {
        return this.current >= this.source.length;
    }

    private getPosition(): Position {
        return { line: this.line, character: this.character };
    }

    private readWhile(regex: RegExp): string {
        let result = '';
        while (!this.isAtEnd() && regex.test(this.source[this.current])) {
            result += this.advance();
        }
        return result;
    }

    private readUntil(char: string): string {
        let result = '';
        while (!this.isAtEnd() && this.source[this.current] !== char) {
            result += this.advance();
        }
        return result;
    }

    private isNextDigit(): boolean {
        if (this.isAtEnd()) return false;
        return /[0-9]/.test(this.source[this.current]);
    }

    private skipWhitespace(): void {
        this.readWhile(/[ \t\r\n]/);
    }

    private isKeyword(word: string): boolean {
        const keywords = ['if', 'elif', 'else', 'while', 'break', 'continue', 'var', 'global', 'set', 'echo', 'abort'];
        return keywords.includes(word.toLowerCase());
    }

    private createToken(type: TokenType, value: string, start: Position): Token {
        return { type, value, range: { start, end: this.getPosition() } };
    }
}