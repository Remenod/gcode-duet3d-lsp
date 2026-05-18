// parser/types.ts
// Derived from ExpressionParser.cpp, StringParser.cpp (RRF firmware)

export enum TokenType {
    // ── Literals ─────────────────────────────────────────────────────────────
    Integer,            // 42  0  -1
    HexInteger,         // 0xFF
    BinInteger,         // 0b1010
    Float,              // 3.14  1e-3
    StringLit,          // "hello"  (double-quote escape = "")
    CharLit,            // 'A'

    // ── Named constants (NamedEnum NamedConstant in ExpressionParser.cpp) ────
    True, False, Null, Pi, Iterations, Line, Result, Input,

    // ── G/M/T codes ──────────────────────────────────────────────────────────
    GCode,              // G28  M220  G29.1
    TCode,              // T0  T-1  T
    GCodeWord,          // Single-letter G-code parameter word (P, S, R, X, …)
    //                     emitted ONLY in G-code lines, OUTSIDE any { … } block.
    //                     The numeric/string value that follows is a separate token.

    // ── Meta commands (StringParser.cpp, CheckIfMetaCommand) ─────────────────
    If, Elif, Else,
    While, Break, Continue,
    Abort,
    Var, Global, Set, Echo, Param, Skip,

    // ── Functions (NamedEnum Function in ExpressionParser.cpp) ───────────────
    FunctionName,       // abs acos asin atan atan2 ceil cos datetime degrees
    // drop exists exp fileexists fileread find floor isnan
    // log max min mod pow radians random round sin sqrt
    // square take tan vector

    // ── Operators (from ParseInternal operators string "?^&|!=<>+-*/") ───────
    Plus,               // +   (also unary)
    Minus,              // -   (also unary)
    Star,               // *
    Slash,              // /
    Caret,              // ^   string concat
    Eq,                 // =   (assignment context) or == (comparison)
    EqEq,               // ==
    NEq,                // !=
    Lt,                 // <
    Gt,                 // >
    LtEq,               // <=
    GtEq,               // >=
    And,                // &  or &&
    Or,                 // |  or ||
    Not,                // !
    Ternary,            // ?
    Colon,              // :
    Hash,               // #   length operator
    TripleGt,           // >>>
    DoubleGt,           // >>

    // ── Brackets ─────────────────────────────────────────────────────────────
    LParen,             // (
    RParen,             // )
    LBrace,             // {
    RBrace,             // }
    LBracket,           // [
    RBracket,           // ]

    // ── Structural ────────────────────────────────────────────────────────────
    Dot,                // .
    Comma,              // ,
    Semicolon,          // ; (also starts a comment)

    // ── Misc ──────────────────────────────────────────────────────────────────
    Identifier,         // var.x  global.y  param.z  or plain name
    Comment,            // ; rest of line
    EOF,
    Unknown,
}

export interface Token {
    type: TokenType;
    value: string;
    line: number;   // 0-based
    start: number;   // character offset from line start
    end: number;   // exclusive
}

// ── Known function names ──────────────────────────────────────────────────────
export const FUNCTION_NAMES = new Set([
    'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'datetime', 'degrees',
    'drop', 'exists', 'exp', 'fileexists', 'fileread', 'find', 'floor', 'isnan',
    'log', 'max', 'min', 'mod', 'pow', 'radians', 'random', 'round', 'sin', 'sqrt',
    'square', 'take', 'tan', 'vector',
]);

// ── Named constants ───────────────────────────────────────────────────────────
export const NAMED_CONSTANTS = new Set([
    'true', 'false', 'null', 'pi', 'iterations', 'line', 'result', 'input',
]);

// ── Meta command keyword → TokenType ─────────────────────────────────────────
export const META_KEYWORDS: Record<string, TokenType> = {
    if: TokenType.If,
    elif: TokenType.Elif,
    else: TokenType.Else,
    while: TokenType.While,
    break: TokenType.Break,
    continue: TokenType.Continue,
    abort: TokenType.Abort,
    var: TokenType.Var,
    global: TokenType.Global,
    set: TokenType.Set,
    echo: TokenType.Echo,
    param: TokenType.Param,
    skip: TokenType.Skip,
};

// ── Semantic token type names (for LSP legend) ────────────────────────────────
//
// All names are LSP standard token types so any colour theme picks them up
// without custom configuration.  The index order MUST match the `ST` constant
// in server.ts.
export const SEMANTIC_TOKEN_TYPES = [
    'keyword',      // 0  meta commands: if, var, while, …
    'function',     // 1  built-in functions: abs, sin, max, …
    'variable',     // 2  var.x  global.x  param.x
    'number',       // 3  numeric literals
    'string',       // 4  string / char literals
    'operator',     // 5  + - * / ^ == != < > = , : ? # >> >>>
    'parameter',    // 6  G-code parameter letters: P, S, R, X, …
    'macro',        // 7  G/M/T command codes: G1, M291, T0
    'comment',      // 8  ; comments
    'enumMember',   // 9  named constants: true, false, null, pi, iterations, …
];

// ── Semantic token modifiers ──────────────────────────────────────────────────
//
// Standard LSP modifiers.  Themes that support these will style the affected
// tokens distinctively (e.g. strike-through for `deprecated`, bold-italic for
// `declaration`).
export const SEMANTIC_TOKEN_MODIFIERS = [
    'declaration',  // 0  the defining occurrence of a symbol (var x = …)
    'readonly',     // 1  named constants, param.X (set at call site)
    'deprecated',   // 2  >>> redirect operator
];
