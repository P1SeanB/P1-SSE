// Input validation at the API boundary.
//
// Deliberately hand-rolled and tiny rather than a schema library: the shapes here
// are a dozen fields of string/number/enum, and a dependency would be more code to
// audit than the checks themselves.
//
// The point is that the SERVER validates. The frontend validates too, but a
// frontend check is a courtesy to the person typing — it is not a control, because
// anything signed in can call these endpoints directly.

export class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.errors = errors;
  }
  /** Shaped so the caller can return it directly. */
  get response() {
    return { status: 400, jsonBody: { error: 'Validation failed', details: this.errors } };
  }
}

/**
 * Reads and checks a JSON body.
 *
 *   const body = await readBody(request, {
 *     name:  { type: 'string', required: true, max: 200 },
 *     email: { type: 'string', max: 200 },
 *     rate:  { type: 'number', min: 0 },
 *     status:{ type: 'enum', values: ['open', 'done'] },
 *     data:  { type: 'json', required: true },
 *   });
 *
 * Throws ValidationError; unknown fields are dropped rather than rejected, so a
 * frontend sending an extra key does not fail the whole request.
 */
export async function readBody(request, spec) {
  let raw;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError({ _body: 'Expected a JSON body.' });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError({ _body: 'Expected a JSON object.' });
  }

  const out = {};
  const errors = {};

  for (const [field, rule] of Object.entries(spec)) {
    const value = raw[field];
    const missing = value === undefined || value === null || value === '';

    if (missing) {
      if (rule.required) errors[field] = 'Required.';
      else if ('default' in rule) out[field] = rule.default;
      else out[field] = null;
      continue;
    }

    switch (rule.type) {
      case 'string': {
        const s = String(value).trim();
        if (rule.max && s.length > rule.max) {
          errors[field] = `Must be ${rule.max} characters or fewer.`;
        } else if (rule.min && s.length < rule.min) {
          errors[field] = `Must be at least ${rule.min} characters.`;
        } else {
          out[field] = s;
        }
        break;
      }
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) errors[field] = 'Must be a number.';
        else if (rule.min !== undefined && n < rule.min) errors[field] = `Must be at least ${rule.min}.`;
        else if (rule.max !== undefined && n > rule.max) errors[field] = `Must be at most ${rule.max}.`;
        else out[field] = n;
        break;
      }
      case 'integer': {
        const n = Number(value);
        if (!Number.isInteger(n)) errors[field] = 'Must be a whole number.';
        else if (rule.min !== undefined && n < rule.min) errors[field] = `Must be at least ${rule.min}.`;
        else out[field] = n;
        break;
      }
      case 'enum': {
        if (!rule.values.includes(value)) {
          errors[field] = `Must be one of: ${rule.values.join(', ')}.`;
        } else {
          out[field] = value;
        }
        break;
      }
      case 'json': {
        // Stored in a jsonb column. Objects and arrays pass straight through; a
        // string is parsed, so a frontend that stringifies still works.
        if (typeof value === 'string') {
          try {
            out[field] = JSON.parse(value);
          } catch {
            errors[field] = 'Must be valid JSON.';
          }
        } else if (typeof value === 'object') {
          out[field] = value;
        } else {
          errors[field] = 'Must be an object or array.';
        }
        break;
      }
      default:
        throw new Error(`validate.js: unknown rule type "${rule.type}" for "${field}"`);
    }
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/** A positive integer route parameter, or null. Never interpolate one into SQL. */
export function idParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Wraps a handler so ValidationError becomes a 400 and anything else becomes a 500
 * that says nothing about the internals — a database error message can name tables
 * and columns, which is not something an error toast should be teaching people.
 */
export function handler(fn) {
  return async (request, context) => {
    try {
      return await fn(request, context);
    } catch (err) {
      if (err instanceof ValidationError) return err.response;
      context.error('Unhandled error:', err);
      return { status: 500, jsonBody: { error: 'Something went wrong. Try again.' } };
    }
  };
}
