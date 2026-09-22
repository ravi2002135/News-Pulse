/**
 * A small error hierarchy so route handlers can throw semantically and a single
 * middleware decides the status code. Anything thrown that isn't an ApiError is
 * treated as a 500 and its message is not leaked to the client.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BadRequest extends ApiError {
  constructor(message, details) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class NotFound extends ApiError {
  constructor(message, details) {
    super(404, 'NOT_FOUND', message, details);
  }
}

export class Conflict extends ApiError {
  constructor(message, details) {
    super(409, 'CONFLICT', message, details);
  }
}

export class ServiceUnavailable extends ApiError {
  constructor(message, details) {
    super(503, 'SERVICE_UNAVAILABLE', message, details);
  }
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

/**
 * Every query parameter is validated before it reaches SQL. Unknown parameters
 * are rejected rather than ignored: silently dropping a misspelled `minSize`
 * would return a plausible-looking but wrong result set, which is worse for a
 * frontend developer than a 400.
 */
export function parseQuery(query, spec) {
  const unknown = Object.keys(query).filter((k) => !(k in spec));
  if (unknown.length) {
    throw new BadRequest(`Unknown query parameter(s): ${unknown.join(', ')}`, {
      allowed: Object.keys(spec),
    });
  }

  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const raw = query[key];
    if (raw === undefined || raw === '') {
      out[key] = rule.default;
      continue;
    }
    out[key] = rule.parse(raw, key);
  }
  return out;
}

export const rules = {
  int: ({ min, max, default: def }) => ({
    default: def,
    parse(raw, key) {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        throw new BadRequest(`Query parameter "${key}" must be an integer, got "${raw}"`);
      }
      if (min !== undefined && n < min) {
        throw new BadRequest(`Query parameter "${key}" must be >= ${min}, got ${n}`);
      }
      if (max !== undefined && n > max) {
        throw new BadRequest(`Query parameter "${key}" must be <= ${max}, got ${n}`);
      }
      return n;
    },
  }),

  enum: (values, def) => ({
    default: def,
    parse(raw, key) {
      if (!values.includes(raw)) {
        throw new BadRequest(
          `Query parameter "${key}" must be one of: ${values.join(', ')} (got "${raw}")`,
        );
      }
      return raw;
    },
  }),

  isoDate: (def) => ({
    default: def,
    parse(raw, key) {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequest(
          `Query parameter "${key}" must be an ISO-8601 date, got "${raw}"`,
        );
      }
      return d.toISOString();
    },
  }),

  text: ({ maxLength = 200, default: def } = {}) => ({
    default: def,
    parse(raw, key) {
      const value = String(raw).trim();
      if (value.length > maxLength) {
        throw new BadRequest(`Query parameter "${key}" must be <= ${maxLength} characters`);
      }
      return value;
    },
  }),

  bool: (def) => ({
    default: def,
    parse(raw, key) {
      if (['true', '1', 'yes'].includes(raw)) return true;
      if (['false', '0', 'no'].includes(raw)) return false;
      throw new BadRequest(`Query parameter "${key}" must be true or false, got "${raw}"`);
    },
  }),
};

/** Cluster IDs are the 16-char hex prefix the Python clusterer generates. */
const CLUSTER_ID = /^[0-9a-f]{16}$/;
export function validateClusterId(id) {
  if (!CLUSTER_ID.test(id)) {
    throw new BadRequest('Cluster id must be a 16-character hexadecimal string', { received: id });
  }
  return id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateJobId(id) {
  if (!UUID.test(id)) {
    throw new BadRequest('Job id must be a UUID', { received: id });
  }
  return id;
}

/** Reject a range whose bounds are inverted rather than returning an empty set. */
export function assertRange(since, until) {
  if (since && until && new Date(since) > new Date(until)) {
    throw new BadRequest('"since" must be earlier than "until"', { since, until });
  }
}
