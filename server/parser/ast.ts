import { Range } from 'vscode-languageserver/node';

export type ASTNode =
    | Program
    | StatementNode
    | ExpressionNode
    | ParameterNode;

export interface Program {
    type: 'Program';
    body: StatementNode[];
    range: Range;
}

export type StatementNode =
    | GCodeCommand
    | MetaCommand
    | CommentNode
    | EmptyLineNode;

// --- StringParser ---

export interface GCodeCommand {
    type: 'GCodeCommand';
    letter: string;           // 'G', 'M', 'T'
    number: number;
    fraction?: number;
    parameters: ParameterNode[];
    range: Range;
}

export interface ParameterNode {
    type: 'Parameter';
    letter: string;           // 'X', 'Y', 'Z', 'S', 'P'...
    value: ExpressionNode;
    range: Range;
}

export interface MetaCommand {
    type: 'MetaCommand';
    keyword: string;          // 'if', 'while', 'var', 'set', 'echo'...
    expression?: ExpressionNode;
    body?: StatementNode[];
    elseBody?: StatementNode[];
    indentation: number;
    range: Range;
}

export interface CommentNode {
    type: 'Comment';
    text: string;
    range: Range;
}

export interface EmptyLineNode {
    type: 'EmptyLine';
    range: Range;
}

// ---ExpressionParser ---

export type ExpressionNode =
    | BinaryExpression
    | UnaryExpression
    | FunctionCall
    | Identifier
    | LiteralNode
    | ArrayExpression;

export interface BinaryExpression {
    type: 'BinaryExpression';
    operator: string;         // '+', '-', '*', '/', '==', '!=', '&&', '||', '^'
    left: ExpressionNode;
    right: ExpressionNode;
    range: Range;
}

export interface UnaryExpression {
    type: 'UnaryExpression';
    operator: string;         // '!', '-', '+'
    operand: ExpressionNode;
    range: Range;
}

export interface FunctionCall {
    type: 'FunctionCall';
    functionName: string;     // 'sin', 'cos', 'exists', 'floor'...
    args: ExpressionNode[];
    range: Range;
}

export interface Identifier {
    type: 'Identifier';
    name: string;             // 'global.var', 'move.axes[0].machinePosition'
    range: Range;
}

export interface LiteralNode {
    type: 'Literal';
    valueType: 'String' | 'Integer' | 'Float' | 'Boolean' | 'Null';
    value: any;
    range: Range;
}

export interface ArrayExpression {
    type: 'ArrayExpression';
    elements: ExpressionNode[];
    range: Range;
}