// data/signatures.ts
// Extracted directly from ExpressionParser.cpp — NamedEnum(Function, ...) and the switch cases.

export interface ParamInfo {
    name: string;
    doc: string;
    type?: string;
}

export interface FunctionSignature {
    name: string;
    params: ParamInfo[];
    returnType: string;
    doc: string;
    minArgs: number;
    maxArgs: number;
}

export const FUNCTION_SIGNATURES: Record<string, FunctionSignature> = {
    abs: {
        name: 'abs', returnType: 'numeric', minArgs: 1, maxArgs: 1,
        doc: 'Returns the absolute value of a numeric expression.',
        params: [{ name: 'value', doc: 'Integer or float value', type: 'numeric' }],
    },
    acos: {
        name: 'acos', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the arc cosine (in radians) of the value.',
        params: [{ name: 'value', doc: 'Value in range [-1, 1]', type: 'float' }],
    },
    asin: {
        name: 'asin', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the arc sine (in radians) of the value.',
        params: [{ name: 'value', doc: 'Value in range [-1, 1]', type: 'float' }],
    },
    atan: {
        name: 'atan', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the arc tangent (in radians) of the value.',
        params: [{ name: 'value', doc: 'Tangent value', type: 'float' }],
    },
    atan2: {
        name: 'atan2', returnType: 'float', minArgs: 2, maxArgs: 2,
        doc: 'Returns the arc tangent of y/x using the signs of both arguments to determine the correct quadrant.',
        params: [
            { name: 'y', doc: 'Y coordinate', type: 'float' },
            { name: 'x', doc: 'X coordinate', type: 'float' },
        ],
    },
    ceil: {
        name: 'ceil', returnType: 'int', minArgs: 1, maxArgs: 1,
        doc: 'Returns the smallest integer greater than or equal to the value.',
        params: [{ name: 'value', doc: 'Float value', type: 'float' }],
    },
    cos: {
        name: 'cos', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the cosine of the value (in radians).',
        params: [{ name: 'value', doc: 'Angle in radians', type: 'float' }],
    },
    datetime: {
        name: 'datetime', returnType: 'datetime', minArgs: 1, maxArgs: 1,
        doc: 'Converts a value to a DateTime. Accepts an integer (Unix timestamp), a DateTime, or a string in format `YYYY-MM-DDTHH:MM:SS`.',
        params: [{ name: 'value', doc: 'Integer, DateTime, or ISO 8601 string', type: 'int|datetime|string' }],
    },
    degrees: {
        name: 'degrees', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Converts radians to degrees.',
        params: [{ name: 'radians', doc: 'Angle in radians', type: 'float' }],
    },
    drop: {
        name: 'drop', returnType: 'array|string', minArgs: 2, maxArgs: 2,
        doc: 'Drops the first *n* elements from an array or string, returning the rest.',
        params: [
            { name: 'array_or_string', doc: 'Source array or string', type: 'array|string' },
            { name: 'count', doc: 'Number of elements to skip', type: 'int' },
        ],
    },
    exists: {
        name: 'exists', returnType: 'bool', minArgs: 1, maxArgs: 1,
        doc: 'Returns `true` if the object model path or variable exists. Prefix with `#` to check length instead.',
        params: [{ name: 'expression', doc: 'Object model path or variable reference', type: 'identifier' }],
    },
    exp: {
        name: 'exp', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns e raised to the power of the value.',
        params: [{ name: 'value', doc: 'Exponent', type: 'float' }],
    },
    fileexists: {
        name: 'fileexists', returnType: 'bool', minArgs: 1, maxArgs: 1,
        doc: 'Returns `true` if the specified file exists in the `/sys/` folder.',
        params: [{ name: 'path', doc: 'File path relative to /sys/', type: 'string' }],
    },
    fileread: {
        name: 'fileread', returnType: 'array', minArgs: 4, maxArgs: 4,
        doc: 'Reads an array of values from the first line of a CSV/delimited file.',
        params: [
            { name: 'path', doc: 'File path relative to /sys/', type: 'string' },
            { name: 'offset', doc: 'Number of elements to skip (0-based)', type: 'int' },
            { name: 'length', doc: 'Maximum number of elements to read', type: 'int' },
            { name: 'delimiter', doc: 'Delimiter character literal, e.g. `\',\'`', type: 'char' },
        ],
    },
    find: {
        name: 'find', returnType: 'int', minArgs: 2, maxArgs: 2,
        doc: 'Returns the index of the first occurrence of a character or substring within a string, or -1 if not found.',
        params: [
            { name: 'string', doc: 'The string to search within', type: 'string' },
            { name: 'search', doc: 'Character or substring to find', type: 'char|string' },
        ],
    },
    floor: {
        name: 'floor', returnType: 'int', minArgs: 1, maxArgs: 1,
        doc: 'Returns the largest integer less than or equal to the value.',
        params: [{ name: 'value', doc: 'Float value', type: 'float' }],
    },
    isnan: {
        name: 'isnan', returnType: 'bool', minArgs: 1, maxArgs: 1,
        doc: 'Returns `true` if the value is NaN (not a number).',
        params: [{ name: 'value', doc: 'Float value to test', type: 'float' }],
    },
    log: {
        name: 'log', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the natural logarithm (base e) of the value.',
        params: [{ name: 'value', doc: 'Positive float value', type: 'float' }],
    },
    max: {
        name: 'max', returnType: 'numeric', minArgs: 1, maxArgs: 99,
        doc: 'Returns the maximum of multiple values, or the maximum element of an array when called with a single array argument.',
        params: [
            { name: 'a', doc: 'First value or array', type: 'numeric|array' },
            { name: '...b', doc: 'Additional values (optional)', type: 'numeric' },
        ],
    },
    min: {
        name: 'min', returnType: 'numeric', minArgs: 1, maxArgs: 99,
        doc: 'Returns the minimum of multiple values, or the minimum element of an array when called with a single array argument.',
        params: [
            { name: 'a', doc: 'First value or array', type: 'numeric|array' },
            { name: '...b', doc: 'Additional values (optional)', type: 'numeric' },
        ],
    },
    mod: {
        name: 'mod', returnType: 'numeric', minArgs: 2, maxArgs: 2,
        doc: 'Returns the remainder of `a` divided by `b`. Works on integers and floats.',
        params: [
            { name: 'a', doc: 'Dividend', type: 'numeric' },
            { name: 'b', doc: 'Divisor (0 → result is 0 for integers)', type: 'numeric' },
        ],
    },
    pow: {
        name: 'pow', returnType: 'numeric', minArgs: 2, maxArgs: 2,
        doc: 'Returns `base` raised to the power of `exponent`. Returns an integer if both operands are integers and exponent is non-negative.',
        params: [
            { name: 'base', doc: 'Base value', type: 'numeric' },
            { name: 'exponent', doc: 'Exponent value', type: 'numeric' },
        ],
    },
    radians: {
        name: 'radians', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Converts degrees to radians.',
        params: [{ name: 'degrees', doc: 'Angle in degrees', type: 'float' }],
    },
    random: {
        name: 'random', returnType: 'int', minArgs: 1, maxArgs: 1,
        doc: 'Returns a random non-negative integer less than the given limit.',
        params: [{ name: 'limit', doc: 'Upper bound (exclusive, must be positive)', type: 'int' }],
    },
    round: {
        name: 'round', returnType: 'int', minArgs: 1, maxArgs: 1,
        doc: 'Rounds to the nearest integer (ties round to even).',
        params: [{ name: 'value', doc: 'Float value', type: 'float' }],
    },
    sin: {
        name: 'sin', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the sine of the value (in radians).',
        params: [{ name: 'value', doc: 'Angle in radians', type: 'float' }],
    },
    sqrt: {
        name: 'sqrt', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the square root of the value.',
        params: [{ name: 'value', doc: 'Non-negative float', type: 'float' }],
    },
    square: {
        name: 'square', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the square of the value.',
        params: [{ name: 'value', doc: 'Numeric value', type: 'float' }],
    },
    take: {
        name: 'take', returnType: 'array|string', minArgs: 2, maxArgs: 2,
        doc: 'Returns the first *n* elements of an array or string.',
        params: [
            { name: 'array_or_string', doc: 'Source array or string', type: 'array|string' },
            { name: 'count', doc: 'Number of elements to keep', type: 'int' },
        ],
    },
    tan: {
        name: 'tan', returnType: 'float', minArgs: 1, maxArgs: 1,
        doc: 'Returns the tangent of the value (in radians).',
        params: [{ name: 'value', doc: 'Angle in radians', type: 'float' }],
    },
    vector: {
        name: 'vector', returnType: 'array', minArgs: 2, maxArgs: 2,
        doc: 'Creates an array of *length* elements all set to *fill_value*.',
        params: [
            { name: 'length', doc: 'Number of elements (non-negative integer)', type: 'int' },
            { name: 'fill_value', doc: 'Initial value for every element', type: 'any' },
        ],
    },
};

// Named constants documentation
export const NAMED_CONSTANT_DOCS: Record<string, string> = {
    true: '**Boolean** constant `true`.',
    false: '**Boolean** constant `false`.',
    null: '**Null** value. Represents an absent or undefined object model value.',
    pi: '**Float** constant π ≈ 3.14159265.',
    iterations: '**Integer** — current loop iteration count (0-based). Only valid inside a `while` block.',
    line: '**Integer** — current line number of the executing file.',
    result: '**Integer** — result code of the last executed G/M code command. `0` = ok, `1` = warning, `2` = error, `-1` = cancelled.',
    input: 'The value returned by an `M291` prompt, or `null` if none.',
};

// Meta command documentation
export const META_COMMAND_DOCS: Record<string, { title: string; doc: string; syntax: string }> = {
    if: { title: 'Conditional', syntax: 'if {expression}', doc: 'Executes the following indented block if the expression evaluates to `true`.' },
    elif: { title: 'Else-if', syntax: 'elif {expression}', doc: 'Alternative condition for an `if` block.' },
    else: { title: 'Else', syntax: 'else', doc: 'Executes when the preceding `if`/`elif` was `false`.' },
    while: { title: 'Loop', syntax: 'while {expression}', doc: 'Repeatedly executes the indented block while the expression is `true`. Use `iterations` to get the loop count.' },
    break: { title: 'Break', syntax: 'break', doc: 'Exits the innermost `while` loop immediately.' },
    continue: { title: 'Continue', syntax: 'continue', doc: 'Skips the rest of the current loop iteration and re-evaluates the `while` condition.' },
    abort: { title: 'Abort', syntax: 'abort {optional_message}', doc: 'Aborts the current macro file (and optionally all calling files) with an error message.' },
    var: { title: 'Local variable', syntax: 'var name = {expression}', doc: 'Declares a local variable scoped to the current file. Access it as `var.name`.' },
    global: { title: 'Global variable', syntax: 'global name = {expression}', doc: 'Declares a global variable accessible from any file as `global.name`.' },
    set: { title: 'Assignment', syntax: 'set var.name = {expression}', doc: 'Assigns a new value to an existing `var.` or `global.` variable.' },
    echo: { title: 'Echo', syntax: 'echo {expr1} {expr2} ...', doc: 'Outputs one or more expressions to the console / response message.' },
    skip: { title: 'Skip', syntax: 'skip', doc: 'Skips the current line (no-op marker).' },
};
