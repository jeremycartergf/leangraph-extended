// Database Wrapper for SQLite
import * as nodePath from 'path';

// Lazy-loaded better-sqlite3 to avoid requiring it in remote mode
let BetterSqlite3: any = null;

/**
 * Get the better-sqlite3 module, loading it lazily if needed.
 * Throws a helpful error if better-sqlite3 is not installed when needed.
 */
function getBetterSqlite3(): any {
  if (BetterSqlite3 === null) {
    try {
      BetterSqlite3 = require('better-sqlite3');
    } catch (err) {
      throw new Error(
        'better-sqlite3 is not installed. Install it with: npm install better-sqlite3\n' +
          'Note: better-sqlite3 is only required for local/test mode. Remote mode does not need it.',
      );
    }
  }
  return BetterSqlite3;
}

// ============================================================================
// Types
// ============================================================================

export interface NodeRow {
  id: string;
  label: string;
  properties: string; // JSON string
}

export interface EdgeRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties: string; // JSON string
}

export interface Node {
  id: string;
  label: string | string[]; // Support both single and multiple labels
  properties: Record<string, unknown>;
}

export interface Edge {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties: Record<string, unknown>;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  changes: number;
  lastInsertRowid: number | bigint;
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    label JSON NOT NULL,
    properties JSON DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    properties JSON DEFAULT '{}',
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(source_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(target_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_primary_label ON nodes(json_extract(label, '$[0]'));
CREATE INDEX IF NOT EXISTS idx_nodes_properties_id ON nodes(json_extract(properties, '$.id')) WHERE json_extract(properties, '$.id') IS NOT NULL;
`;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a parameter value for SQLite binding.
 * Large integers (outside JavaScript's safe integer range) are converted to BigInt
 * to ensure SQLite treats them as INTEGER rather than REAL (which loses precision).
 *
 * Important: We convert via string representation to preserve the value that JavaScript
 * would serialize (e.g., to JSON), rather than the internal floating-point representation
 * which may differ for large integers.
 */
function convertParamForSqlite(value: unknown): unknown {
  // SQLite bind params cannot be undefined; map to null for Cypher-like semantics.
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // better-sqlite3 positional binding does not accept plain JS objects.
  // Serialize arrays/maps so JSON values can be safely bound to single '?'
  // placeholders (for example node properties like geolocation objects).
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(convertParamForSqlite));
  }
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  ) {
    // Large integer: convert to BigInt via string to preserve the serialized representation
    // This ensures consistency with JSON.stringify() behavior
    return BigInt(String(value));
  }
  // Convert booleans to 1/0 for SQLite
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Convert all params in an array for SQLite binding.
 */
function convertParamsForSqlite(params: unknown[]): unknown[] {
  return params.map(convertParamForSqlite);
}

// ============================================================================
// Database Class
// ============================================================================

// ============================================================================
// Custom SQL Functions for Cypher Semantics
// ============================================================================

/**
 * Deep equality comparison with Cypher's three-valued logic.
 * Returns: 1 (true), 0 (false), or null (unknown when comparing with null)
 */
function deepCypherEquals(a: unknown, b: unknown): number | null {
  // Both null/undefined -> null (unknown if null equals null)
  if (a === null && b === null) return null;
  // One null -> null (unknown)
  if (a === null || b === null) return null;

  // Arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return 0; // false
    if (a.length === 0) return 1; // true

    let hasNull = false;
    for (let i = 0; i < a.length; i++) {
      const cmp = deepCypherEquals(a[i], b[i]);
      if (cmp === null) hasNull = true;
      else if (cmp === 0) return 0; // false
    }
    return hasNull ? null : 1;
  }

  // Objects (maps)
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keysA = Object.keys(a as Record<string, unknown>).sort();
    const keysB = Object.keys(b as Record<string, unknown>).sort();
    if (keysA.length !== keysB.length) return 0;
    if (keysA.join(',') !== keysB.join(',')) return 0;

    let hasNull = false;
    for (const k of keysA) {
      const cmp = deepCypherEquals(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      );
      if (cmp === null) hasNull = true;
      else if (cmp === 0) return 0;
    }
    return hasNull ? null : 1;
  }

  // Primitives
  return a === b ? 1 : 0;
}

/**
 * Get the Cypher type category for ordering comparisons.
 * Returns a type string for values that can be ordered, or null for non-orderable types.
 *
 * When using SQLite's -> operator for JSON extraction, values come as JSON-formatted strings:
 * - 'true' / 'false' for booleans
 * - '"string"' for strings (with quotes)
 * - '123' or '3.14' for numbers (no quotes)
 * - '[...]' for arrays
 * - '{...}' for objects
 */
// Regex patterns for temporal types
const TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const LOCALTIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?(\[.+\])?$/;
const LOCALDATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

function getCypherTypeForOrdering(value: unknown): string | null {
  if (value === null) return null;

  const jsType = typeof value;

  // Numbers (integer and real) are in the same ordering category
  if (jsType === 'number' || jsType === 'bigint') return 'number';

  // Strings - could be raw strings OR JSON-formatted values from -> operator
  if (jsType === 'string') {
    const s = value as string;

    // Check for JSON boolean literals (from -> operator)
    if (s === 'true' || s === 'false') return 'boolean';

    // Check for JSON null
    if (s === 'null') return null;

    // Check for JSON array
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        JSON.parse(s);
        return 'array'; // arrays are not orderable
      } catch {
        // Not valid JSON, treat as string
      }
    }

    // Check for JSON object
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        JSON.parse(s);
        return 'object'; // objects are not orderable
      } catch {
        // Not valid JSON, treat as string
      }
    }

    // Check for JSON string literal (starts and ends with quotes)
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      return 'string';
    }

    // Check for JSON number (no quotes, valid number)
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
      return 'number';
    }

    // Check for temporal types (times with timezone need special comparison)
    if (TIME_PATTERN.test(s)) return 'time';
    if (DATETIME_PATTERN.test(s)) return 'datetime';
    if (DATE_PATTERN.test(s)) return 'date';
    if (LOCALTIME_PATTERN.test(s)) return 'localtime';
    if (LOCALDATETIME_PATTERN.test(s)) return 'localdatetime';

    // Otherwise treat as a plain string
    return 'string';
  }

  // Booleans - SQLite stores these as integers, but if we somehow get a JS boolean
  if (jsType === 'boolean') return 'boolean';

  // Objects and arrays in JS form (shouldn't normally happen with SQLite)
  if (Array.isArray(value)) return 'array';
  if (jsType === 'object') return 'object';

  return null;
}

/**
 * Check if two Cypher types are compatible for ordering comparisons (<, <=, >, >=).
 */
function areCypherTypesOrderable(
  typeA: string | null,
  typeB: string | null,
): boolean {
  if (typeA === null || typeB === null) return false;

  // Arrays, objects, nodes, relationships are not orderable
  if (typeA === 'array' || typeB === 'array') return false;
  if (typeA === 'object' || typeB === 'object') return false;

  // Same type is always orderable
  if (typeA === typeB) return true;

  // Numbers (integer/real) are orderable with each other - already handled by "number" category

  return false;
}

/**
 * Parse timezone offset to minutes from UTC
 */
function parseTimezoneOffset(tz: string): number {
  if (tz === 'Z' || tz === '+00:00') return 0;
  const sign = tz[0] === '-' ? -1 : 1;
  const hours = parseInt(tz.slice(1, 3), 10);
  const minutes = parseInt(tz.slice(4, 6), 10);
  return sign * (hours * 60 + minutes);
}

/**
 * Convert time string to nanoseconds from midnight UTC for comparison
 */
function timeToNanosUTC(timeStr: string): number {
  // Format: HH:MM or HH:MM:SS or HH:MM:SS.nnnnnnnnn followed by Z or +HH:MM or -HH:MM
  // May also have [timezone] suffix - strip it
  const withoutTzName = timeStr.replace(/\[.+\]$/, '');

  // Find timezone part
  let tzOffset = 0;
  let timePart = withoutTzName;

  if (withoutTzName.endsWith('Z')) {
    timePart = withoutTzName.slice(0, -1);
    tzOffset = 0;
  } else {
    const tzMatch = withoutTzName.match(/([+-]\d{2}:\d{2})$/);
    if (tzMatch) {
      tzOffset = parseTimezoneOffset(tzMatch[1]);
      timePart = withoutTzName.slice(0, -6);
    }
  }

  // Parse time components
  const parts = timePart.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  let seconds = 0;
  let nanos = 0;

  if (parts[2]) {
    const secParts = parts[2].split('.');
    seconds = parseInt(secParts[0], 10);
    if (secParts[1]) {
      // Pad or truncate to 9 digits
      const fracStr = secParts[1].padEnd(9, '0').slice(0, 9);
      nanos = parseInt(fracStr, 10);
    }
  }

  // Convert to total nanoseconds from midnight, then adjust for timezone
  const totalMinutes = hours * 60 + minutes - tzOffset;
  const totalNanos = (totalMinutes * 60 + seconds) * 1_000_000_000 + nanos;

  // Normalize to 24-hour range (handle negative from timezone adjustment)
  const dayInNanos = 24 * 60 * 60 * 1_000_000_000;
  return ((totalNanos % dayInNanos) + dayInNanos) % dayInNanos;
}

/**
 * Convert a value to its comparable form.
 * For JSON-formatted strings from -> operator, parse to get actual value.
 * For temporal types, convert to a form suitable for comparison.
 */
function toComparableValue(
  value: unknown,
  type: string,
): number | string | boolean {
  if (typeof value === 'string') {
    if (type === 'number') {
      return parseFloat(value);
    }
    if (type === 'boolean') {
      return value === 'true';
    }
    if (type === 'string') {
      // JSON string literal - remove outer quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
      }
      return value;
    }
    if (type === 'time') {
      // Convert to nanoseconds from midnight UTC for comparison
      return timeToNanosUTC(value);
    }
    if (type === 'datetime') {
      // Strip [timezone] suffix and compare lexically (ISO format is naturally sortable when in UTC or same TZ)
      // For proper comparison, we'd need to convert to UTC, but for same-offset datetimes, lexical works
      // TODO: Full timezone-aware datetime comparison
      return value.replace(/\[.+\]$/, '');
    }
    // date, localtime, localdatetime can be compared lexically (ISO format is sortable)
    if (type === 'date' || type === 'localtime' || type === 'localdatetime') {
      return value;
    }
  }
  return value as number | string | boolean;
}

/**
 * Helper to convert SQLite boolean representation to JavaScript boolean.
 * SQLite can represent booleans as: 1, 0, 'true', 'false'
 */
function toBoolValue(x: unknown): boolean | null {
  if (x === null || x === undefined) return null;
  if (x === 1 || x === true || x === 'true') return true;
  if (x === 0 || x === false || x === 'false') return false;
  return null;
}

/**
 * Register custom SQL functions for Cypher semantics on a database instance.
 */
function registerCypherFunctions(db: import('better-sqlite3').Database): void {
  // cypher_not: Proper boolean negation that works with both JSON booleans and integers
  // Converts json('true')/1 -> 0, json('false')/0 -> 1, null -> null
  // Returns integers for SQLite compatibility in WHERE clauses
  db.function('cypher_not', { deterministic: true }, (x: unknown) => {
    const b = toBoolValue(x);
    if (b === null) return null;
    return b ? 0 : 1;
  });

  // cypher_and: Proper boolean AND that works with both JSON booleans and integers
  // Returns integers for SQLite compatibility in WHERE clauses
  db.function(
    'cypher_and',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      const boolA = toBoolValue(a);
      const boolB = toBoolValue(b);
      // Cypher AND with NULL: false AND NULL = false, true AND NULL = NULL
      if (boolA === false || boolB === false) return 0;
      if (boolA === null || boolB === null) return null;
      return boolA && boolB ? 1 : 0;
    },
  );

  // cypher_or: Proper boolean OR that works with both JSON booleans and integers
  // Returns integers for SQLite compatibility in WHERE clauses
  db.function(
    'cypher_or',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      const boolA = toBoolValue(a);
      const boolB = toBoolValue(b);
      // Cypher OR with NULL: true OR NULL = true, false OR NULL = NULL
      if (boolA === true || boolB === true) return 1;
      if (boolA === null || boolB === null) return null;
      return boolA || boolB ? 1 : 0;
    },
  );

  // cypher_to_json_bool: Convert 0/1/null to JSON boolean for RETURN results
  // This preserves boolean type information through SQLite's JSON functions
  db.function('cypher_to_json_bool', { deterministic: true }, (x: unknown) => {
    const b = toBoolValue(x);
    if (b === null) return null;
    return b ? 'true' : 'false'; // Returns JSON boolean literal string
  });

  // cypher_to_string: Convert value to string for concatenation
  // Integers should not have .0 suffix (e.g., 2 -> "2", not "2.0")
  // Note: JSON extraction in SQLite returns numbers as strings like "2.0"
  db.function('cypher_to_string', { deterministic: true }, (x: unknown) => {
    if (x === null || x === undefined) return null;
    if (typeof x === 'string') {
      // Check if it's a string that looks like an integer with .0 suffix (e.g., "2.0", "-5.0")
      // This happens when JSON extraction returns integer values
      if (/^-?\d+\.0$/.test(x)) {
        return x.replace(/\.0$/, '');
      }
      return x;
    }
    if (typeof x === 'number') {
      // Format integers without decimal point
      if (Number.isInteger(x)) return String(Math.trunc(x));
      return String(x);
    }
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    // For objects/arrays, return JSON representation
    return JSON.stringify(x);
  });

  // cypher_bool_eq: Boolean-aware equality comparison
  // Handles cases where one side is a JSON boolean string ('true'/'false') and the other is an integer (1/0)
  // Returns: 1 if equal, 0 if not equal, null if either is null
  db.function(
    'cypher_bool_eq',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      if (a === null || a === undefined || b === null || b === undefined)
        return null;

      // Try to normalize both to booleans if they look like boolean values
      const boolA = toBoolValue(a);
      const boolB = toBoolValue(b);

      // If both are recognized as booleans, compare them as booleans
      if (boolA !== null && boolB !== null) {
        return boolA === boolB ? 1 : 0;
      }

      // Fall back to regular equality
      return a === b ? 1 : 0;
    },
  );

  // cypher_compare: Type-aware comparison for ordering operators (<, <=, >, >=)
  // Returns: 1 if condition is true, 0 if false, null if types are incompatible
  db.function(
    'cypher_lt',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      if (a === null || a === undefined || b === null || b === undefined)
        return null;
      const typeA = getCypherTypeForOrdering(a);
      const typeB = getCypherTypeForOrdering(b);
      if (!areCypherTypesOrderable(typeA, typeB)) return null;
      const valA = toComparableValue(a, typeA!);
      const valB = toComparableValue(b, typeB!);
      return valA < valB ? 1 : 0;
    },
  );

  db.function(
    'cypher_lte',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      if (a === null || a === undefined || b === null || b === undefined)
        return null;
      const typeA = getCypherTypeForOrdering(a);
      const typeB = getCypherTypeForOrdering(b);
      if (!areCypherTypesOrderable(typeA, typeB)) return null;
      const valA = toComparableValue(a, typeA!);
      const valB = toComparableValue(b, typeB!);
      return valA <= valB ? 1 : 0;
    },
  );

  db.function(
    'cypher_gt',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      if (a === null || a === undefined || b === null || b === undefined)
        return null;
      const typeA = getCypherTypeForOrdering(a);
      const typeB = getCypherTypeForOrdering(b);
      if (!areCypherTypesOrderable(typeA, typeB)) return null;
      const valA = toComparableValue(a, typeA!);
      const valB = toComparableValue(b, typeB!);
      return valA > valB ? 1 : 0;
    },
  );

  db.function(
    'cypher_gte',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      if (a === null || a === undefined || b === null || b === undefined)
        return null;
      const typeA = getCypherTypeForOrdering(a);
      const typeB = getCypherTypeForOrdering(b);
      if (!areCypherTypesOrderable(typeA, typeB)) return null;
      const valA = toComparableValue(a, typeA!);
      const valB = toComparableValue(b, typeB!);
      return valA >= valB ? 1 : 0;
    },
  );

  // cypher_equals: Null-aware deep equality for lists and maps
  db.function(
    'cypher_equals',
    { deterministic: true },
    (a: unknown, b: unknown) => {
      // Handle SQL NULL
      if (a === null && b === null) return null;
      if (a === null || b === null) return null;

      // Try to parse as JSON (for arrays/objects stored as JSON strings)
      let parsedA: unknown, parsedB: unknown;
      try {
        parsedA = typeof a === 'string' ? JSON.parse(a) : a;
      } catch {
        parsedA = a;
      }
      try {
        parsedB = typeof b === 'string' ? JSON.parse(b) : b;
      } catch {
        parsedB = b;
      }

      return deepCypherEquals(parsedA, parsedB);
    },
  );

  // cypher_list_contains: Membership check for Cypher IN semantics over list-like values.
  // Returns: 1 if found, 0 if not found, null if unknown due to nulls.
  db.function(
    'cypher_list_contains',
    { deterministic: true },
    (listValue: unknown, itemValue: unknown) => {
      if (listValue === null || listValue === undefined) return null;

      const normalize = (value: unknown): unknown => {
        if (value === null || value === undefined) return value;

        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            if (
              parsed &&
              typeof parsed === 'object' &&
              !Array.isArray(parsed)
            ) {
              const record = parsed as Record<string, unknown>;
              if (record._nf_id !== undefined) {
                return record._nf_id;
              }
            }
            return parsed;
          } catch {
            return value;
          }
        }

        if (typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (record._nf_id !== undefined) {
            return record._nf_id;
          }
        }

        return value;
      };

      let parsedList: unknown = listValue;
      if (typeof parsedList === 'string') {
        try {
          parsedList = JSON.parse(parsedList);
        } catch {
          parsedList = [parsedList];
        }
      }

      const list = Array.isArray(parsedList) ? parsedList : [parsedList];
      const needle = normalize(itemValue);

      let sawUnknown = needle === null || needle === undefined;
      for (const entry of list) {
        const candidate = normalize(entry);

        if (
          candidate === null ||
          candidate === undefined ||
          needle === null ||
          needle === undefined
        ) {
          sawUnknown = true;
          continue;
        }

        const equals = deepCypherEquals(candidate, needle);
        if (equals === true || equals === 1) {
          return 1;
        }
        if (equals === null) {
          sawUnknown = true;
        }
      }

      return sawUnknown ? null : 0;
    },
  );

  // cypher_list_predicate_in:
  // Evaluate quantified predicates where each element of sourceList is tested
  // with Cypher IN semantics against targetList.
  // Returns 1/0/null for true/false/unknown.
  db.function(
    'cypher_list_predicate_in',
    { deterministic: true },
    (
      predicateTypeRaw: unknown,
      sourceListValue: unknown,
      targetListValue: unknown,
    ) => {
      const predicateType = String(predicateTypeRaw ?? '').toUpperCase();

      const normalize = (value: unknown): unknown => {
        if (value === null || value === undefined) return value;

        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            if (
              parsed &&
              typeof parsed === 'object' &&
              !Array.isArray(parsed)
            ) {
              const record = parsed as Record<string, unknown>;
              if (record._nf_id !== undefined) return record._nf_id;
            }
            return parsed;
          } catch {
            return value;
          }
        }

        if (typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (record._nf_id !== undefined) return record._nf_id;
        }

        return value;
      };

      const toList = (value: unknown): unknown[] | null => {
        if (value === null || value === undefined) return null;
        let parsed: unknown = value;
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            parsed = [parsed];
          }
        }
        return Array.isArray(parsed) ? parsed : [parsed];
      };

      const targetList = toList(targetListValue);
      const membership = (candidateRaw: unknown): 1 | 0 | null => {
        const candidate = normalize(candidateRaw);
        if (candidate === null || candidate === undefined) return null;
        if (targetList === null) return null;

        let sawUnknown = false;
        for (const entry of targetList) {
          const target = normalize(entry);
          if (target === null || target === undefined) {
            sawUnknown = true;
            continue;
          }
          const equals = deepCypherEquals(candidate, target);
          if (equals === true || equals === 1) return 1;
          if (equals === null) sawUnknown = true;
        }
        return sawUnknown ? null : 0;
      };

      const sourceList = toList(sourceListValue);
      if (sourceList === null) return null;

      if (sourceList.length === 0) {
        if (predicateType === 'ALL') return 1;
        if (predicateType === 'ANY') return 0;
        if (predicateType === 'NONE') return 1;
        if (predicateType === 'SINGLE') return 0;
        return null;
      }

      let trueCount = 0;
      let falseCount = 0;
      let nullCount = 0;
      for (const candidate of sourceList) {
        const status = membership(candidate);
        if (status === 1) trueCount++;
        else if (status === 0) falseCount++;
        else nullCount++;
      }

      switch (predicateType) {
        case 'ALL':
          if (falseCount > 0) return 0;
          if (nullCount > 0) return null;
          return 1;
        case 'ANY':
          if (trueCount > 0) return 1;
          if (nullCount > 0) return null;
          return 0;
        case 'NONE':
          if (trueCount > 0) return 0;
          if (nullCount > 0) return null;
          return 1;
        case 'SINGLE':
          if (trueCount > 1) return 0;
          if (nullCount > 0) return null;
          return trueCount === 1 ? 1 : 0;
        default:
          return null;
      }
    },
  );

  // cypher_case_eq: Type-aware equality for CASE expressions
  // Takes value+type pairs to preserve type information across SQLite's type coercion
  // Returns: 1 if equal (same type and value), 0 if not equal
  db.function(
    'cypher_case_eq',
    { deterministic: true },
    (val1: unknown, type1: string, val2: unknown, type2: string) => {
      // NULL handling: if either is null, return null (unknown)
      if (val1 === null || val2 === null) return null;
      if (type1 === 'null' || type2 === 'null') return null;

      // Helper to get runtime type from a value
      const getRuntimeType = (val: unknown): string => {
        if (val === null) return 'null';
        const jsType = typeof val;
        if (jsType === 'boolean' || val === 0 || val === 1) {
          // SQLite stores booleans as 0/1, so we can't distinguish at runtime
          // We rely on the compile-time type info for this
          return 'unknown_number_or_boolean';
        }
        if (jsType === 'number' || jsType === 'bigint') return 'number';
        if (jsType === 'string') {
          // Check if it's a JSON array/object
          const str = val as string;
          if (str.startsWith('[')) return 'list';
          if (str.startsWith('{')) return 'map';
          return 'string';
        }
        return 'unknown';
      };

      // Resolve "dynamic" types using runtime type detection
      let resolvedType1 = type1;
      let resolvedType2 = type2;

      if (type1 === 'dynamic') {
        resolvedType1 = getRuntimeType(val1);
      }
      if (type2 === 'dynamic') {
        resolvedType2 = getRuntimeType(val2);
      }

      // Normalize numeric types: integer, float, and number are all comparable
      const normalizeNumericType = (t: string): string => {
        if (t === 'integer' || t === 'float' || t === 'number')
          return 'numeric';
        return t;
      };

      const normType1 = normalizeNumericType(resolvedType1);
      const normType2 = normalizeNumericType(resolvedType2);

      // Different types are never equal in CASE expressions
      // (except numeric types which are comparable)
      if (normType1 !== normType2) return 0;

      // Same type - compare values
      // For lists/maps, use deep comparison
      if (normType1 === 'list' || normType1 === 'map') {
        let parsed1: unknown, parsed2: unknown;
        try {
          parsed1 = typeof val1 === 'string' ? JSON.parse(val1) : val1;
        } catch {
          parsed1 = val1;
        }
        try {
          parsed2 = typeof val2 === 'string' ? JSON.parse(val2) : val2;
        } catch {
          parsed2 = val2;
        }
        const result = deepCypherEquals(parsed1, parsed2);
        return result === null ? null : result;
      }

      // For numeric types, compare as numbers
      if (normType1 === 'numeric') {
        const num1 = Number(val1);
        const num2 = Number(val2);
        return num1 === num2 ? 1 : 0;
      }

      // For primitives (boolean, string), direct comparison
      return val1 === val2 ? 1 : 0;
    },
  );

  // cypher_datetime_with_timezone:
  // Convert a datetime value to the supplied timezone while preserving Cypher-like
  // output formatting (offset plus optional [IANA] zone suffix).
  db.function(
    'cypher_datetime_with_timezone',
    { deterministic: true },
    (rawValue: unknown, timezoneValue: unknown) => {
      if (rawValue === null || rawValue === undefined) return null;

      const tryUnquoteJsonString = (value: unknown): unknown => {
        if (typeof value !== 'string') return value;
        try {
          const parsed = JSON.parse(value);
          return typeof parsed === 'string' ? parsed : value;
        } catch {
          return value;
        }
      };

      let raw = tryUnquoteJsonString(rawValue);
      const timezoneRaw = tryUnquoteJsonString(timezoneValue);
      if (typeof raw === 'string') {
        raw = raw.replace(/\[[^\]]+\]$/, '');
      }

      const base = new Date(raw as string | number | Date);
      if (Number.isNaN(base.getTime())) return null;

      const timezone =
        timezoneRaw === null || timezoneRaw === undefined
          ? 'UTC'
          : String(timezoneRaw);

      const pad2 = (n: number): string => String(n).padStart(2, '0');
      const parseOffsetMinutes = (tz: string): number | null => {
        if (tz === 'Z') return 0;
        const match = tz.match(/^([+-])(\d{2}):(\d{2})$/);
        if (!match) return null;
        const sign = match[1] === '-' ? -1 : 1;
        return sign * (Number(match[2]) * 60 + Number(match[3]));
      };
      const parseShortOffset = (tzName: string): string | null => {
        if (tzName === 'GMT' || tzName === 'UTC') return '+00:00';
        const match = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
        if (!match) return null;
        const hh = String(Number(match[2])).padStart(2, '0');
        const mm = String(Number(match[3] ?? '0')).padStart(2, '0');
        return `${match[1]}${hh}:${mm}`;
      };

      const offsetMinutes = parseOffsetMinutes(timezone);
      if (offsetMinutes !== null) {
        const shifted = new Date(base.getTime() + offsetMinutes * 60 * 1000);
        const year = shifted.getUTCFullYear();
        const month = pad2(shifted.getUTCMonth() + 1);
        const day = pad2(shifted.getUTCDate());
        const hour = pad2(shifted.getUTCHours());
        const minute = pad2(shifted.getUTCMinutes());
        const second = pad2(shifted.getUTCSeconds());
        const tzOut = timezone === 'Z' ? '+00:00' : timezone;
        return `${year}-${month}-${day}T${hour}:${minute}:${second}${tzOut}`;
      }

      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZoneName: 'shortOffset',
        }).formatToParts(base);

        const pick = (type: string) =>
          parts.find((part) => part.type === type)?.value ?? '';
        const year = pick('year');
        const month = pick('month');
        const day = pick('day');
        const hour = pick('hour');
        const minute = pick('minute');
        const second = pick('second');
        const tzName = pick('timeZoneName');
        const offset = parseShortOffset(tzName) ?? '+00:00';

        if (!year || !month || !day || !hour || !minute || !second) return null;
        return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}[${timezone}]`;
      } catch {
        return base.toISOString();
      }
    },
  );

  // cypher_regex: Regex matching for =~ operator
  // Returns: 1 if pattern matches, 0 if not, null if either operand is null
  // Supports inline modifiers like (?i) for case-insensitive matching
  // Security: Rejects patterns with nested quantifiers that cause catastrophic
  // backtracking (ReDoS), and limits input string length.
  db.function(
    'cypher_regex',
    { deterministic: true },
    (str: unknown, pattern: unknown) => {
      if (
        str === null ||
        str === undefined ||
        pattern === null ||
        pattern === undefined
      )
        return null;
      if (typeof str !== 'string' || typeof pattern !== 'string') return 0;

      // Limit input length to mitigate ReDoS via large inputs
      const MAX_REGEX_INPUT_LENGTH = 10_000;
      if (str.length > MAX_REGEX_INPUT_LENGTH) {
        throw new Error(
          `Regex input exceeds maximum length of ${MAX_REGEX_INPUT_LENGTH} characters`,
        );
      }

      // Reject patterns with nested quantifiers that cause exponential backtracking.
      // Detects patterns like (a+)+, (a*)+, (a+)*, (.+)+, etc.
      // This is a heuristic — it won't catch every ReDoS pattern, but it blocks
      // the most common and dangerous ones.
      const NESTED_QUANTIFIER = /([+*]|\{\d+,\d*\})\s*\)([+*]|\{\d+,\d*\})/;
      if (NESTED_QUANTIFIER.test(pattern)) {
        throw new Error(
          'Regex pattern rejected: nested quantifiers can cause catastrophic backtracking',
        );
      }

      try {
        // Extract inline modifiers like (?i) (?m) (?s) from pattern start
        // JavaScript doesn't support inline modifiers, so convert to flags
        let flags = '';
        let actualPattern = pattern;
        const modifierMatch = pattern.match(/^\(\?([imsu]+)\)/);
        if (modifierMatch) {
          flags = modifierMatch[1];
          actualPattern = pattern.slice(modifierMatch[0].length);
        }
        const regex = new RegExp(actualPattern, flags);
        return regex.test(str) ? 1 : 0;
      } catch (e) {
        // Invalid regex pattern — re-throw length/backtracking errors, suppress others
        if (
          e instanceof Error &&
          (e.message.includes('maximum length') ||
            e.message.includes('backtracking'))
        )
          throw e;
        return 0;
      }
    },
  );
}

/**
 * Register custom APOC-compatible functions using better-sqlite3's native db.function().
 */
function registerJavascriptFunctions(
  db: import('better-sqlite3').Database,
): void {
  db.function(
    'apoc_convert_fromjsonmap',
    { deterministic: true, varargs: true },
    (...args: unknown[]) => {
      const value = args[0];
      const path = args[1];
      if (value === null || value === undefined) return null;

      let mapValue: unknown = value;
      if (typeof mapValue === 'string') {
        try {
          mapValue = JSON.parse(mapValue);
        } catch {
          return null;
        }
      }
      if (
        !mapValue ||
        typeof mapValue !== 'object' ||
        Array.isArray(mapValue)
      ) {
        return null;
      }

      if (typeof path === 'string' && path.length > 0) {
        const raw = path.replace(/^\$\./, '').replace(/^\$/, '');
        if (raw.length > 0) {
          const keys = raw.split('.').filter(Boolean);
          let current: unknown = mapValue;
          for (const key of keys) {
            if (
              current &&
              typeof current === 'object' &&
              !Array.isArray(current) &&
              key in current
            ) {
              current = (current as Record<string, unknown>)[key];
            } else {
              return null;
            }
          }
          return current === undefined ? null : JSON.stringify(current);
        }
      }

      return JSON.stringify(mapValue);
    },
  );

  db.function(
    'apoc_convert_tojson',
    { deterministic: true },
    (value: unknown) => {
      if (value === undefined) return null;
      try {
        return JSON.stringify(value);
      } catch {
        return null;
      }
    },
  );

  db.function(
    'apoc_text_join',
    { deterministic: true },
    (listInput: unknown, delimiterRaw: unknown) => {
      const delimiter =
        delimiterRaw === null || delimiterRaw === undefined
          ? ''
          : String(delimiterRaw);
      if (listInput === null || listInput === undefined) return null;

      let list: unknown = listInput;
      if (typeof list === 'string') {
        try {
          list = JSON.parse(list);
        } catch {
          list = [list];
        }
      }
      if (!Array.isArray(list)) return null;

      return (list as unknown[])
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v))
        .join(delimiter);
    },
  );

  db.function(
    'apoc_text_jarowinklerdistance',
    { deterministic: true },
    (leftRaw: unknown, rightRaw: unknown) => {
      if (
        leftRaw === null ||
        leftRaw === undefined ||
        rightRaw === null ||
        rightRaw === undefined
      )
        return null;

      const s1 = String(leftRaw);
      const s2 = String(rightRaw);
      if (s1 === s2) return 1;
      if (s1.length === 0 || s2.length === 0) return 0;

      const matchDistance = Math.max(
        Math.floor(Math.max(s1.length, s2.length) / 2) - 1,
        0,
      );
      const s1Matches = new Array(s1.length).fill(false);
      const s2Matches = new Array(s2.length).fill(false);

      let matches = 0;
      for (let i = 0; i < s1.length; i++) {
        const start = Math.max(0, i - matchDistance);
        const end = Math.min(i + matchDistance + 1, s2.length);
        for (let j = start; j < end; j++) {
          if (s2Matches[j]) continue;
          if (s1[i] !== s2[j]) continue;
          s1Matches[i] = true;
          s2Matches[j] = true;
          matches++;
          break;
        }
      }

      if (matches === 0) return 0;

      let transpositions = 0;
      let k = 0;
      for (let i = 0; i < s1.length; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1[i] !== s2[k]) transpositions++;
        k++;
      }
      transpositions = transpositions / 2;

      const m = matches;
      const jaro =
        (m / s1.length + m / s2.length + (m - transpositions) / m) / 3;

      let prefix = 0;
      const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
      while (prefix < maxPrefix && s1[prefix] === s2[prefix]) prefix++;

      const scaling = 0.1;
      return jaro + prefix * scaling * (1 - jaro);
    },
  );

  db.function(
    'apoc_map_removekeys',
    { deterministic: true, varargs: true },
    (...args: unknown[]) => {
      const source = args[0];
      const keysInput = args[1];
      const configInput = args[2];
      if (source === null || source === undefined) return null;

      let mapValue: unknown = source;
      if (typeof mapValue === 'string') {
        try {
          mapValue = JSON.parse(mapValue);
        } catch {
          return null;
        }
      }
      if (!mapValue || typeof mapValue !== 'object' || Array.isArray(mapValue))
        return null;

      let keys: unknown = keysInput;
      if (typeof keys === 'string') {
        try {
          keys = JSON.parse(keys);
        } catch {
          keys = [keys];
        }
      }
      if (!Array.isArray(keys)) return JSON.stringify(mapValue);

      let recursive = false;
      let config: unknown = configInput;
      if (typeof config === 'string') {
        try {
          config = JSON.parse(config);
        } catch {
          config = null;
        }
      }
      if (config && typeof config === 'object' && !Array.isArray(config)) {
        recursive = (config as Record<string, unknown>).recursive === true;
      }

      const removeSet = new Set((keys as unknown[]).map((k) => String(k)));
      const strip = (obj: unknown): unknown => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (removeSet.has(k)) continue;
          out[k] = recursive ? strip(v) : v;
        }
        return out;
      };

      return JSON.stringify(strip(mapValue));
    },
  );

  db.function('apoc_coll_toset', { deterministic: true }, (input: unknown) => {
    if (input === null || input === undefined) return null;

    let list: unknown = input;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        return input;
      }
    }

    if (!Array.isArray(list)) return input;

    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of list as unknown[]) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
    return JSON.stringify(out);
  });

  db.function(
    'apoc_coll_flatten',
    { deterministic: true, varargs: true },
    (...args: unknown[]) => {
      const input = args[0];
      const recursiveRaw = args[1];
      const recursive =
        recursiveRaw === true || recursiveRaw === 1 || recursiveRaw === 'true';
      if (input === null || input === undefined) return null;

      let list: unknown = input;
      if (typeof list === 'string') {
        try {
          list = JSON.parse(list);
        } catch {
          return null;
        }
      }
      if (!Array.isArray(list)) return null;

      const toExpandable = (item: unknown): unknown => {
        if (Array.isArray(item)) return item;
        if (typeof item === 'string') {
          try {
            const parsed = JSON.parse(item);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            /* not JSON */
          }
        }
        return item;
      };

      const flattenOnce = (arr: unknown[]): unknown[] => {
        const out: unknown[] = [];
        for (const item of arr) {
          const expanded = toExpandable(item);
          if (Array.isArray(expanded)) out.push(...expanded);
          else out.push(item);
        }
        return out;
      };

      let out = flattenOnce(list as unknown[]);
      if (recursive) {
        while (out.some((v) => Array.isArray(toExpandable(v)))) {
          out = flattenOnce(out);
        }
      }

      return JSON.stringify(out);
    },
  );

  db.function(
    'apoc_coll_subtract',
    { deterministic: true },
    (leftInput: unknown, rightInput: unknown) => {
      if (leftInput === null || leftInput === undefined) return null;
      if (rightInput === null || rightInput === undefined) return null;

      const parseList = (value: unknown): unknown[] | null => {
        let list: unknown = value;
        if (typeof list === 'string') {
          try {
            list = JSON.parse(list);
          } catch {
            return null;
          }
        }
        return Array.isArray(list) ? list : null;
      };

      const left = parseList(leftInput);
      const right = parseList(rightInput);
      if (!left || !right) return null;

      const rightKeys = new Set(right.map((v) => JSON.stringify(v)));
      const out = left.filter((v) => !rightKeys.has(JSON.stringify(v)));
      return JSON.stringify(out);
    },
  );

  db.function('apoc_coll_avg', { deterministic: true }, (input: unknown) => {
    if (input === null || input === undefined) return null;

    let list: unknown = input;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(list)) return null;

    const nums = (list as unknown[])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  });

  db.function('apoc_coll_min', { deterministic: true }, (input: unknown) => {
    if (input === null || input === undefined) return null;

    let list: unknown = input;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(list)) return null;

    const values = (list as unknown[]).filter(
      (v) => v !== null && v !== undefined,
    );
    if (values.length === 0) return null;
    return values.reduce((min, curr) => (curr < min ? curr : min), values[0]);
  });

  db.function(
    'apoc_coll_sortnodes',
    { deterministic: true },
    (input: unknown, specRaw: unknown) => {
      if (input === null || input === undefined) return null;
      if (specRaw === null || specRaw === undefined) return null;

      let list: unknown = input;
      if (typeof list === 'string') {
        try {
          list = JSON.parse(list);
        } catch {
          return null;
        }
      }
      if (!Array.isArray(list)) return null;

      const spec = String(specRaw);
      const ascending = spec.startsWith('^');
      const key = ascending ? spec.slice(1) : spec;
      if (!key) return JSON.stringify(list);

      const out = [...(list as unknown[])].sort((a, b) => {
        const av =
          a && typeof a === 'object'
            ? (a as Record<string, unknown>)[key]
            : undefined;
        const bv =
          b && typeof b === 'object'
            ? (b as Record<string, unknown>)[key]
            : undefined;
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (av < bv) return ascending ? -1 : 1;
        if (av > bv) return ascending ? 1 : -1;
        return 0;
      });
      return JSON.stringify(out);
    },
  );

  db.function(
    'apoc_date_format',
    { deterministic: true, varargs: true },
    (...args: unknown[]) => {
      const value = args[0];
      const unitRaw = args[1];
      const formatRaw = args[2];
      const timezoneRaw = args[3];
      if (value === null || value === undefined) return null;

      let epoch = Number(value);
      if (!Number.isFinite(epoch)) return null;
      const unit = unitRaw ?? 'ms';
      if (unit === 's') epoch = epoch * 1000;

      const date = new Date(epoch);
      if (Number.isNaN(date.getTime())) return null;

      const format = (formatRaw ?? 'yyyy-MM-dd') as string;
      const timezone =
        timezoneRaw && typeof timezoneRaw === 'string' ? timezoneRaw : 'UTC';

      try {
        const fmt = new Intl.DateTimeFormat('en-AU', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        const parts = Object.fromEntries(
          fmt.formatToParts(date).map((p) => [p.type, p.value]),
        );
        if (format === 'yyyy-MM') return `${parts.year}-${parts.month}`;
        if (format === 'yyyy') return parts.year;
        return `${parts.year}-${parts.month}-${parts.day}`;
      } catch {
        // Fallback to UTC if timezone is invalid
        const year = String(date.getUTCFullYear()).padStart(4, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        if (format === 'yyyy-MM') return `${year}-${month}`;
        if (format === 'yyyy') return year;
        return `${year}-${month}-${day}`;
      }
    },
  );
}

export class GraphDatabase {
  private db: import('better-sqlite3').Database;
  private initialized: boolean = false;
  private stmtCache: Map<string, import('better-sqlite3').Statement> =
    new Map();
  private readonly STMT_CACHE_MAX = 100;

  constructor(path: string = ':memory:') {
    const Database = getBetterSqlite3();
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL'); // Safe with WAL, faster writes
    this.db.pragma('cache_size = -64000'); // 64MB cache (default is 2MB)
    this.db.pragma('temp_store = MEMORY'); // Temp tables in RAM
    this.db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
    // Register custom Cypher functions
    registerCypherFunctions(this.db);
    // Register custom APOC-compatible functions
    registerJavascriptFunctions(this.db);
  }

  /**
   * Initialize the database schema
   */
  initialize(): void {
    if (this.initialized) return;

    this.db.exec(SCHEMA);
    this.initialized = true;
  }

  /**
   * Get a cached prepared statement, or create and cache a new one
   * Uses LRU eviction: recently accessed entries are moved to end of Map
   */
  private getCachedStatement(sql: string): import('better-sqlite3').Statement {
    let stmt = this.stmtCache.get(sql);
    if (stmt) {
      // Move to end for LRU (delete and re-add)
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, stmt);
      return stmt;
    }

    // Not cached - prepare and add
    stmt = this.db.prepare(sql);
    if (this.stmtCache.size >= this.STMT_CACHE_MAX) {
      // Evict least recently used (first entry)
      const firstKey = this.stmtCache.keys().next().value;
      if (firstKey) this.stmtCache.delete(firstKey);
    }
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  /**
   * Execute a SQL statement and return results
   */
  execute(sql: string, params: unknown[] = []): QueryResult {
    this.ensureInitialized();

    // Convert large integers to BigInt for proper SQLite INTEGER binding
    const convertedParams = convertParamsForSqlite(params);
    try {
      const stmt = this.getCachedStatement(sql);
      const trimmedSql = sql.trim().toUpperCase();
      // Check if it's a query (SELECT, WITH for CTEs, or EXPLAIN)
      const isQuery =
        trimmedSql.startsWith('SELECT') ||
        trimmedSql.startsWith('WITH') ||
        trimmedSql.startsWith('EXPLAIN');

      if (isQuery) {
        const rows = stmt.all(...convertedParams) as Record<string, unknown>[];
        if (process.env.LEANGRAPH_DEBUG_SQL === '1') {
          console.log('[LeanGraph] SQL TEXT:\n' + sql);
          console.log(
            '[LeanGraph] SQL PARAMS:',
            JSON.stringify(convertedParams),
          );
          console.log('[LeanGraph] SQL ROWS:', rows.length);
        }
        return { rows, changes: 0, lastInsertRowid: 0 };
      } else {
        const result = stmt.run(...convertedParams);
        if (process.env.LEANGRAPH_DEBUG_SQL === '1') {
          console.log('[LeanGraph] SQL TEXT:\n' + sql);
          console.log(
            '[LeanGraph] SQL PARAMS:',
            JSON.stringify(convertedParams),
          );
          console.log('[LeanGraph] SQL CHANGES:', result.changes);
        }
        return {
          rows: [],
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      }
    } catch (error) {
      if (process.env.LEANGRAPH_DEBUG_SQL_ERRORS === '1') {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[LeanGraph] SQL ERROR:', message);
        console.error('[LeanGraph] SQL TEXT:\n' + sql);
        console.error(
          '[LeanGraph] SQL PARAMS:',
          JSON.stringify(convertedParams),
        );
      }
      throw error;
    }
  }

  /**
   * Execute multiple statements in a transaction
   */
  transaction<T>(fn: () => T): T {
    this.ensureInitialized();
    return this.db.transaction(fn)();
  }

  /**
   * Insert a node
   */
  insertNode(
    id: string,
    label: string | string[],
    properties: Record<string, unknown> = {},
  ): void {
    // Normalize label to array format for storage
    const labelArray = Array.isArray(label) ? label : [label];
    this.execute('INSERT INTO nodes (id, label, properties) VALUES (?, ?, ?)', [
      id,
      JSON.stringify(labelArray),
      JSON.stringify(properties),
    ]);
  }

  /**
   * Insert an edge
   */
  insertEdge(
    id: string,
    type: string,
    sourceId: string,
    targetId: string,
    properties: Record<string, unknown> = {},
  ): void {
    this.execute(
      'INSERT INTO edges (id, type, source_id, target_id, properties) VALUES (?, ?, ?, ?, ?)',
      [id, type, sourceId, targetId, JSON.stringify(properties)],
    );
  }

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    const result = this.execute('SELECT * FROM nodes WHERE id = ?', [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0] as unknown as NodeRow;
    const labelArray = JSON.parse(row.label);
    return {
      id: row.id,
      label: labelArray,
      properties: JSON.parse(row.properties),
    };
  }

  /**
   * Get an edge by ID
   */
  getEdge(id: string): Edge | null {
    const result = this.execute('SELECT * FROM edges WHERE id = ?', [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0] as unknown as EdgeRow;
    return {
      id: row.id,
      type: row.type,
      source_id: row.source_id,
      target_id: row.target_id,
      properties: JSON.parse(row.properties),
    };
  }

  /**
   * Get all nodes with a given label
   */
  getNodesByLabel(label: string): Node[] {
    // Use index for primary label, fallback for secondary labels
    const result = this.execute(
      `SELECT * FROM nodes WHERE json_extract(label, '$[0]') = ? OR EXISTS (SELECT 1 FROM json_each(label) WHERE value = ? AND json_extract(label, '$[0]') != ?)`,
      [label, label, label],
    );
    return result.rows.map((row) => {
      const r = row as unknown as NodeRow;
      const labelArray = JSON.parse(r.label);
      return {
        id: r.id,
        label: labelArray,
        properties: JSON.parse(r.properties),
      };
    });
  }

  /**
   * Get all edges with a given type
   */
  getEdgesByType(type: string): Edge[] {
    const result = this.execute('SELECT * FROM edges WHERE type = ?', [type]);
    return result.rows.map((row) => {
      const r = row as unknown as EdgeRow;
      return {
        id: r.id,
        type: r.type,
        source_id: r.source_id,
        target_id: r.target_id,
        properties: JSON.parse(r.properties),
      };
    });
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): boolean {
    const result = this.execute('DELETE FROM nodes WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Delete an edge by ID
   */
  deleteEdge(id: string): boolean {
    const result = this.execute('DELETE FROM edges WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Update node properties
   */
  updateNodeProperties(
    id: string,
    properties: Record<string, unknown>,
  ): boolean {
    const result = this.execute(
      'UPDATE nodes SET properties = ? WHERE id = ?',
      [JSON.stringify(properties), id],
    );
    return result.changes > 0;
  }

  /**
   * Count nodes
   */
  countNodes(): number {
    const result = this.execute('SELECT COUNT(*) as count FROM nodes');
    return (result.rows[0] as { count: number }).count;
  }

  /**
   * Count edges
   */
  countEdges(): number {
    const result = this.execute('SELECT COUNT(*) as count FROM edges');
    return (result.rows[0] as { count: number }).count;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }

  /**
   * Get the underlying database instance (for advanced operations)
   */
  getRawDatabase(): any {
    return this.db;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }
}

// ============================================================================
// Database Manager (for multi-project support)
// ============================================================================

export class DatabaseManager {
  private databases: Map<string, GraphDatabase> = new Map();
  private basePath: string;

  constructor(basePath: string = ':memory:') {
    this.basePath = basePath;
  }

  /**
   * Get or create a database for a project.
   * Validates that the resolved database path stays within the base directory
   * to prevent path traversal attacks.
   */
  getDatabase(project: string): GraphDatabase {
    if (!this.databases.has(project)) {
      let dbPath: string;

      if (this.basePath === ':memory:') {
        dbPath = ':memory:';
      } else {
        // Resolve paths to prevent traversal
        const resolvedBase = nodePath.resolve(this.basePath);
        const resolvedPath = nodePath.resolve(this.basePath, `${project}.db`);

        // Defense-in-depth: ensure the resolved path is within the base directory
        if (
          !resolvedPath.startsWith(resolvedBase + nodePath.sep) &&
          resolvedPath !== resolvedBase
        ) {
          throw new Error(`Invalid project name: path traversal detected`);
        }

        dbPath = resolvedPath;
      }

      const db = new GraphDatabase(dbPath);
      db.initialize();
      this.databases.set(project, db);
    }

    return this.databases.get(project)!;
  }

  /**
   * Close all database connections
   */
  closeAll(): void {
    for (const db of this.databases.values()) {
      db.close();
    }
    this.databases.clear();
  }

  /**
   * List all open databases
   */
  listDatabases(): string[] {
    return Array.from(this.databases.keys());
  }
}
