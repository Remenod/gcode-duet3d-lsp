// analysis/objectModelIndex.ts
// Builds a flat map of valid Object Model paths from @duet3d/objectmodel.
//
// Two key problems with naive Object.keys() traversal that this solves:
//
// 1. wrapModelProperty() replaces class fields with a getter/setter closure.
//    When the backing value is null (default), the getter returns null and we
//    cannot recurse. FIX: set the property to {} — the setter then calls
//    `new constructor()` (it knows the class from the closure) and stores the
//    real instance. We can then recurse into it.
//
// 2. ModelCollection is an empty Array on startup (no elements to recurse into).
//    FIX: the collection stores its element constructor as `$itemConstructor`.
//    We instantiate a dummy element and recurse with path `prefix[]`.
//
// Install: npm install @duet3d/objectmodel  (in server/)

let rootCtor: (new () => object) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('@duet3d/objectmodel');
    rootCtor = pkg.ObjectModel ?? pkg.default ?? null;
} catch {
    // Package not installed — all paths unknown.
}

export interface OmPathInfo {
    /** Normalised path with [] for array elements, e.g. "move.axes[].homed" */
    path: string;
    /** JavaScript typeof or constructor name */
    type: string;
    /** True if this property is a ModelCollection (subscriptable) */
    isArray: boolean;
}

let _index: Map<string, OmPathInfo> | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

/** True if the path is a known Object Model path. Array indices normalised automatically. */
export function isValidOmPath(path: string): boolean {
    return getOmIndex().has(normalisePath(path));
}

/** Metadata for an OM path, or undefined if unknown. */
export function getOmPathInfo(path: string): OmPathInfo | undefined {
    return getOmIndex().get(normalisePath(path));
}

/** True when the OM package is installed and the index is non-empty. */
export function isOmIndexAvailable(): boolean {
    return rootCtor !== null && getOmIndex().size > 0;
}

/** All known OM paths (for completions). */
export function allOmPaths(): OmPathInfo[] {
    return [...getOmIndex().values()];
}

// ── Internal ──────────────────────────────────────────────────────────────────

function getOmIndex(): Map<string, OmPathInfo> {
    if (!_index) _index = buildIndex();
    return _index;
}

function buildIndex(): Map<string, OmPathInfo> {
    const map = new Map<string, OmPathInfo>();
    if (!rootCtor) return map;

    try {
        const root = new rootCtor();
        traverse(root as Record<string, unknown>, '', map, new Set());
    } catch (e) {
        // If instantiation fails, return empty index.
    }

    return map;
}

/**
 * Recursive traversal.
 *
 * @param obj     The current object to traverse.
 * @param prefix  Dot-separated path so far (empty string for root).
 * @param map     Output map: normalised path → OmPathInfo.
 * @param visited Cycle guard — holds object references already visited.
 */
function traverse(
    obj: Record<string, unknown>,
    prefix: string,
    map: Map<string, OmPathInfo>,
    visited: Set<object>,
): void {
    if (visited.has(obj)) return;
    visited.add(obj);

    // Hydrate null-valued getters: setting to {} triggers the wrapModelProperty
    // setter which calls `new constructor()` internally and stores the real instance.
    hydrateNullGetters(obj);

    for (const key of Object.keys(obj)) {
        // Skip internal / framework properties
        if (key.startsWith('_') || key.startsWith('$')) continue;

        const fullPath = prefix ? `${prefix}.${key}` : key;

        let value: unknown;
        try {
            value = obj[key];
        } catch {
            continue;
        }

        if (value === null || value === undefined) {
            // Null even after hydration → primitive optional field (e.g. number | null)
            map.set(fullPath, { path: fullPath, type: 'null', isArray: false });

        } else if (isModelCollection(value)) {
            // ModelCollection<T>: empty array with $itemConstructor
            map.set(fullPath, { path: fullPath, type: 'array', isArray: true });
            const itemCtor = getItemConstructor(value as Record<string, unknown>);
            if (itemCtor) {
                try {
                    const dummy = new itemCtor() as Record<string, unknown>;
                    traverse(dummy, `${fullPath}[]`, map, new Set(visited));
                } catch {
                    // Cannot instantiate element — skip
                }
            }

        } else if (Array.isArray(value)) {
            // Plain array (e.g. Array<number>) — record as array, no element recursion
            map.set(fullPath, { path: fullPath, type: 'array', isArray: true });

        } else if (typeof value === 'object') {
            const typeName = (value as object).constructor?.name ?? 'object';
            map.set(fullPath, { path: fullPath, type: typeName, isArray: false });
            traverse(value as Record<string, unknown>, fullPath, map, new Set(visited));

        } else {
            map.set(fullPath, { path: fullPath, type: typeof value, isArray: false });
        }
    }
}

/**
 * Hydrates null getters: iterates own property descriptors, and for each
 * property that has a getter (added by wrapModelProperty) AND currently
 * returns null, assigns {} to it.  The wrapModelProperty setter will then
 * call `new constructor()` (the class stored in its closure) and replace the
 * backing value with a real instance.  On the next read the getter returns
 * that instance.
 */
function hydrateNullGetters(obj: Record<string, unknown>): void {
    const descs = Object.getOwnPropertyDescriptors(obj);
    for (const [key, desc] of Object.entries(descs)) {
        if (typeof desc.get === 'function' && obj[key] === null) {
            try {
                (obj as Record<string, unknown>)[key] = {};
            } catch {
                // Read-only or sealed — skip
            }
        }
    }
}

/** Returns true if value is a ModelCollection (Array subclass with $itemConstructor). */
function isModelCollection(value: unknown): boolean {
    return (
        Array.isArray(value) &&
        typeof (value as any)['$itemConstructor'] === 'function'
    );
}
/** Returns the element constructor from a ModelCollection, or null. */
function getItemConstructor(col: Record<string, unknown>): (new () => object) | null {
    const ctor = col['$itemConstructor'];
    return typeof ctor === 'function' ? (ctor as new () => object) : null;
}

/** Replace concrete array indices with [] for normalised key lookup. */
function normalisePath(path: string): string {
    return path.replace(/\[\d+\]/g, '[]');
}
