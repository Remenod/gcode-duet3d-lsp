import { Token, TokenType } from './lexer';
import {
    ASTNode, Program, StatementNode, GCodeCommand,
    ExpressionNode, ParameterNode, LiteralNode
} from './ast';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';

export class RRFParser {
    private tokens: Token[];
    private current = 0;
    public diagnostics: Diagnostic[] = [];

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    public parse(): Program {
        const start = this.peek().range.start;
        const statements: StatementNode[] = [];

        while (!this.isAtEnd()) {
            try {
                const stmt = this.parseStatement();
                if (stmt) statements.push(stmt);
            } catch (error) {
                this.synchronize();
            }
        }

        const end = this.peek().range.end;

        return {
            type: 'Program',
            body: statements,
            range: { start, end }
        };
    }

    private parseStatement(): StatementNode | null {
        const token = this.peek();

        if (token.type === TokenType.CommandLetter) {
            return this.parseGCodeCommand();
        }

        if (token.type === TokenType.Keyword) {
            return this.parseMetaCommand();
        }

        if (token.type === TokenType.Comment) {
            this.advance();
            return { type: 'Comment', text: token.value, range: token.range };
        }

        // Handle unexpected tokens at statement level
        this.advance();
        return null;
    }

    private parseGCodeCommand(): GCodeCommand {
        const letterToken = this.advance();
        const numberToken = this.consume(TokenType.Number, "Expected command number.");

        const parameters: ParameterNode[] = [];

        // Loop through parameters until end of line/file or next command
        while (!this.isAtEnd() &&
            this.peek().type !== TokenType.Comment &&
            this.peek().type !== TokenType.CommandLetter &&
            this.peek().type !== TokenType.Keyword) {

            if (this.peek().type === TokenType.Parameter) {
                parameters.push(this.parseParameter());
            } else {
                this.advance(); // Skip unexpected tokens within command
            }
        }

        const lastToken = parameters.length > 0 ? parameters[parameters.length - 1] : numberToken;

        return {
            type: 'GCodeCommand',
            letter: letterToken.value,
            number: parseFloat(numberToken.value),
            parameters: parameters,
            range: { start: letterToken.range.start, end: lastToken.range.end }
        };
    }

    private parseParameter(): ParameterNode {
        const paramToken = this.advance();
        let value: ExpressionNode;

        // RRF Logic: if next is '{', it's a complex expression, else it's a literal
        if (this.peek().type === TokenType.OpenBrace) {
            this.advance(); // consume '{'
            value = this.parseExpression();
            this.consume(TokenType.CloseBrace, "Expected '}' after expression.");
        } else if (this.peek().type === TokenType.Number || this.peek().type === TokenType.String) {
            value = this.parseLiteral();
        } else {
            // Fallback for missing values
            value = {
                type: 'Literal',
                valueType: 'Null',
                value: null,
                range: paramToken.range
            };
        }

        return {
            type: 'Parameter',
            letter: paramToken.value,
            value: value,
            range: { start: paramToken.range.start, end: value.range.end }
        };
    }

    // --- Expression Parser (Recursive Descent) ---

    private parseExpression(priority = 0): ExpressionNode {
        // Precedence table based on ExpressionParser.cpp
        const operators: Record<string, number> = {
            '?': 1, '^': 2, '&': 3, '|': 3,
            '!': 4, '=': 4, '<': 4, '>': 4,
            '+': 5, '-': 5, '*': 6, '/': 6
        };

        let left = this.parsePrimary();

        while (true) {
            const token = this.peek();
            const op = token.value;
            const opPriority = operators[op] || 0;

            if (opPriority <= priority) break;

            this.advance();
            const right = this.parseExpression(opPriority);

            left = {
                type: 'BinaryExpression',
                operator: op,
                left,
                right,
                range: { start: left.range.start, end: right.range.end }
            };
        }

        return left;
    }

    private parsePrimary(): ExpressionNode {
        const token = this.peek();

        if (this.match(TokenType.Number)) {
            return this.parseLiteral();
        }

        if (this.match(TokenType.String)) {
            return this.parseLiteral();
        }

        if (this.match(TokenType.Identifier)) {
            this.advance();
            return { type: 'Identifier', name: token.value, range: token.range };
        }

        // Function calls: Identifier followed by '('
        // Logic for this would go here...

        throw this.error(token, `Expected expression, found ${token.value}`);
    }

    private parseLiteral(): LiteralNode {
        const token = this.advance();
        let valueType: LiteralNode['valueType'] = 'Integer';
        let val: any = token.value;

        if (token.type === TokenType.String) {
            valueType = 'String';
            val = token.value.replace(/"/g, '');
        } else {
            val = parseFloat(token.value);
            valueType = token.value.includes('.') ? 'Float' : 'Integer';
        }

        return {
            type: 'Literal',
            valueType: valueType,
            value: val,
            range: token.range
        };
    }

    private parseMetaCommand(): StatementNode {
        const keywordToken = this.advance();
        // Basic var/set implementation
        return {
            type: 'MetaCommand',
            keyword: keywordToken.value,
            indentation: keywordToken.range.start.character,
            range: keywordToken.range
        };
    }

    // --- Helpers ---

    private match(...types: TokenType[]): boolean {
        for (const type of types) {
            if (this.peek().type === type) return true;
        }
        return false;
    }

    private peek(): Token { return this.tokens[this.current]; }

    private previous(): Token { return this.tokens[this.current - 1]; }

    private isAtEnd(): boolean { return this.peek().type === TokenType.EOF; }

    private advance(): Token {
        if (!this.isAtEnd()) this.current++;
        return this.previous();
    }

    private consume(type: TokenType, message: string): Token {
        if (this.peek().type === type) return this.advance();
        throw this.error(this.peek(), message);
    }

    private error(token: Token, message: string): Error {
        this.diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: token.range,
            message: message,
            source: 'rrf-lsp'
        });
        return new Error(message);
    }

    private synchronize(): void {
        this.advance();
        while (!this.isAtEnd()) {
            // Stop at characters that likely start a new command
            if (this.peek().type === TokenType.CommandLetter) return;
            if (this.peek().type === TokenType.Keyword) return;
            this.advance();
        }
    }
}