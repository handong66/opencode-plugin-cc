// Slash commands forward `$ARGUMENTS` as a single string; direct callers may
// pass pre-split argv. Join then re-tokenize so both shapes behave the same.
export function tokenize(input) {
  const text = Array.isArray(input) ? input.join(" ") : String(input ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let hasContent = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }

    current += char;
    hasContent = true;
  }

  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

// spec: { valueFlags: ["--model", ...], booleanFlags: ["--wait", ...] }
// Returns { flags: Map<name, value|true>, rest: string[], errors: string[] }.
// Unknown `--flags` are treated as part of the free text so natural-language
// task text that happens to contain dashes is not swallowed.
export function parseFlags(tokens, spec) {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const booleanFlags = new Set(spec.booleanFlags ?? []);
  const flags = new Map();
  const rest = [];
  const errors = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (valueFlags.has(token)) {
      const value = tokens[index + 1];
      if (value == null || value.startsWith("--")) {
        errors.push(`${token} requires a value`);
        continue;
      }
      flags.set(token, value);
      index += 1;
      continue;
    }

    if (booleanFlags.has(token)) {
      flags.set(token, true);
      continue;
    }

    rest.push(token);
  }

  return { flags, rest, errors };
}
