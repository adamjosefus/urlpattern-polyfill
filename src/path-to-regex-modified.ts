/**
 * Tokenizer results.
 */
export interface LexToken {
  type:
    | "OPEN"
    | "CLOSE"
    | "PATTERN"
    | "NAME"
    | "CHAR"
    | "ESCAPED_CHAR"
    | "MODIFIER"
    | "ASTERISK"
    | "INVALID_CHAR"
    | "END";
  index: number;
  value: string;
}

// Note, the `//u` suffix triggers this typescript linting bug:
//
//  https://github.com/buzinas/tslint-eslint-rules/issues/289
//
// This requires disabling the no-empty-character-class lint rule.
const regexIdentifierStart = /[$_\p{ID_Start}]/u;
const regexIdentifierPart = /[$_\u200C\u200D\p{ID_Continue}]/u;

function isASCII(str: string, extended: boolean) {
  return (extended ? /^[\x00-\xFF]*$/ : /^[\x00-\x7F]*$/).test(str);
}

/**
 * Tokenize input string.
 */
export function lexer(str: string, lenient: boolean = false): LexToken[] {
  const tokens: LexToken[] = [];
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    const ErrorOrInvalid = function (msg: string) {
      if (!lenient) throw new TypeError(msg);
      tokens.push({ type: "INVALID_CHAR", index: i, value: str[i++] });
    };

    if (char === "*") {
      tokens.push({ type: "ASTERISK", index: i, value: str[i++] });
      continue;
    }

    if (char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }

    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }

    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }

    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }

    if (char === ":") {
      let name = "";
      let j = i + 1;

      while (j < str.length) {
        const code = str.substr(j, 1);

        if (
          (j === i + 1 && regexIdentifierStart.test(code)) ||
          (j !== i + 1 && regexIdentifierPart.test(code))
        ) {
          name += str[j++];
          continue;
        }

        break;
      }

      if (!name) {
        ErrorOrInvalid(`Missing parameter name at ${i}`);
        continue;
      }

      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }

    if (char === "(") {
      let count = 1;
      let pattern = "";
      let j = i + 1;
      let error = false;

      if (str[j] === "?") {
        ErrorOrInvalid(`Pattern cannot start with "?" at ${j}`);
        continue;
      }

      while (j < str.length) {
        if (!isASCII(str[j], false)) {
          ErrorOrInvalid(`Invalid character '${str[j]}' at ${j}.`);
          error = true;
          break;
        }

        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }

        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            ErrorOrInvalid(`Capturing groups are not allowed at ${j}`);
            error = true;
            break;
          }
        }

        pattern += str[j++];
      }

      if (error) {
        continue;
      }

      if (count) {
        ErrorOrInvalid(`Unbalanced pattern at ${i}`);
        continue;
      }
      if (!pattern) {
        ErrorOrInvalid(`Missing pattern at ${i}`);
        continue;
      }

      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }

    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }

  tokens.push({ type: "END", index: i, value: "" });

  return tokens;
}

/**
 * Callback type that is invoked for every plain text part of the pattern.
 * This is intended to be used to apply URL canonicalization to the pattern
 * itself.  This is different from the encode callback used to encode group
 * values passed to compile, match, etc.
 */
type EncodePartCallback = (value: string) => string;

export interface ParseOptions {
  /**
   * Set the default delimiter for repeat parameters. (default: `'/'`)
   */
  delimiter?: string;
  /**
   * List of characters to automatically consider prefixes when parsing.
   */
  prefixes?: string;

  /**
   * Encoding callback to apply to each plaintext part of the pattern.
   */
  encodePart?: EncodePartCallback;
}

/**
 * Parse a string for the raw tokens.
 */
export function parse(str: string, options: ParseOptions = {}): Token[] {
  const tokens = lexer(str);
  const { prefixes = "./" } = options;
  const defaultPattern = `[^${escapeString(options.delimiter ?? "/#?")}]+?`;
  const result: Token[] = [];
  let key = 0;
  let i = 0;
  let path = "";
  let nameSet = new Set();

  const tryConsume = (type: LexToken["type"]): string | undefined => {
    if (i < tokens.length && tokens[i].type === type) return tokens[i++].value;
  };

  const tryConsumeModifier = (): string | undefined => {
    const r = tryConsume("MODIFIER");
    if (r) {
      return r;
    }
    return tryConsume("ASTERISK");
  };

  const mustConsume = (type: LexToken["type"]): string => {
    const value = tryConsume(type);
    if (value !== undefined) return value;
    const { type: nextType, index } = tokens[i];
    throw new TypeError(`Unexpected ${nextType} at ${index}, expected ${type}`);
  };

  const consumeText = (): string => {
    let result = "";
    let value: string | undefined;
    // tslint:disable-next-line
    while ((value = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR"))) {
      result += value;
    }
    return result;
  };

  const DefaultEncodePart = (value: string): string => {
    return value;
  };
  const encodePart = options.encodePart || DefaultEncodePart;

  while (i < tokens.length) {
    const char = tryConsume("CHAR");
    const name = tryConsume("NAME");

    let pattern = tryConsume("PATTERN");
    if (!name && !pattern && tryConsume("ASTERISK")) {
      pattern = ".*";
    }

    if (name || pattern) {
      let prefix = char || "";

      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }

      if (path) {
        result.push(encodePart(path));
        path = "";
      }

      const finalName = name || key++;
      if (nameSet.has(finalName)) {
        throw new TypeError(`Duplicate name '${finalName}'.`);
      }
      nameSet.add(finalName);

      result.push({
        name: finalName,
        prefix: encodePart(prefix),
        suffix: "",
        pattern: pattern || defaultPattern,
        modifier: tryConsumeModifier() || "",
      });
      continue;
    }

    const value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }

    const open = tryConsume("OPEN");
    if (open) {
      const prefix = consumeText();
      const name = tryConsume("NAME") || "";
      let pattern = tryConsume("PATTERN") || "";
      if (!name && !pattern && tryConsume("ASTERISK")) {
        pattern = ".*";
      }
      const suffix = consumeText();

      mustConsume("CLOSE");
      const modifier = tryConsumeModifier() || "";

      if (!name && !pattern && !modifier) {
        path += prefix;
        continue;
      }

      if (!name && !pattern && !prefix) {
        continue;
      }

      if (path) {
        result.push(encodePart(path));
        path = "";
      }

      result.push({
        name: name || (pattern ? key++ : ""),
        pattern: name && !pattern ? defaultPattern : pattern,
        prefix: encodePart(prefix),
        suffix: encodePart(suffix),
        modifier: modifier,
      });
      continue;
    }

    if (path) {
      result.push(encodePart(path));
      path = "";
    }

    mustConsume("END");
  }

  return result;
}

export interface TokensToFunctionOptions {
  /**
   * When `true` the regexp will be case sensitive. (default: `false`)
   */
  sensitive?: boolean;
  /**
   * Function for encoding input strings for output.
   */
  encode?: (value: string, token: Key) => string;
  /**
   * When `false` the function can produce an invalid (unmatched) path. (default: `true`)
   */
  validate?: boolean;
}

/**
 * Compile a string to a template function for the path.
 */
export function compile<P extends object = object>(
  str: string,
  options?: ParseOptions & TokensToFunctionOptions
) {
  return tokensToFunction<P>(parse(str, options), options);
}

export type PathFunction<P extends object = object> = (data?: P) => string;

/**
 * Expose a method for transforming tokens into the path function.
 */
export function tokensToFunction<P extends object = object>(
  tokens: Token[],
  options: TokensToFunctionOptions = {}
): PathFunction<P> {
  const reFlags = flags(options);
  const { encode = (x: string) => x, validate = true } = options;

  // Compile all the tokens into regexps.
  const matches = tokens.map((token) => {
    if (typeof token === "object") {
      return new RegExp(`^(?:${token.pattern})$`, reFlags);
    }
  });

  return (data: Record<string, any> | null | undefined) => {
    let path = "";

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (typeof token === "string") {
        path += token;
        continue;
      }

      const value = data ? data[token.name] : undefined;
      const optional = token.modifier === "?" || token.modifier === "*";
      const repeat = token.modifier === "*" || token.modifier === "+";

      if (Array.isArray(value)) {
        if (!repeat) {
          throw new TypeError(
            `Expected "${token.name}" to not repeat, but got an array`
          );
        }

        if (value.length === 0) {
          if (optional) continue;

          throw new TypeError(`Expected "${token.name}" to not be empty`);
        }

        for (let j = 0; j < value.length; j++) {
          const segment = encode(value[j], token);

          if (validate && !(matches[i] as RegExp).test(segment)) {
            throw new TypeError(
              `Expected all "${token.name}" to match "${token.pattern}", but got "${segment}"`
            );
          }

          path += token.prefix + segment + token.suffix;
        }

        continue;
      }

      if (typeof value === "string" || typeof value === "number") {
        const segment = encode(String(value), token);

        if (validate && !(matches[i] as RegExp).test(segment)) {
          throw new TypeError(
            `Expected "${token.name}" to match "${token.pattern}", but got "${segment}"`
          );
        }

        path += token.prefix + segment + token.suffix;
        continue;
      }

      if (optional) continue;

      const typeOfMessage = repeat ? "an array" : "a string";
      throw new TypeError(`Expected "${token.name}" to be ${typeOfMessage}`);
    }

    return path;
  };
}

export interface RegexpToFunctionOptions {
  /**
   * Function for decoding strings for params.
   */
  decode?: (value: string, token: Key) => string;
}

/**
 * A match result contains data about the path match.
 */
export interface MatchResult<P extends object = object> {
  path: string;
  index: number;
  params: P;
}

/**
 * A match is either `false` (no match) or a match result.
 */
export type Match<P extends object = object> = false | MatchResult<P>;

/**
 * The match function takes a string and returns whether it matched the path.
 */
export type MatchFunction<P extends object = object> = (
  path: string
) => Match<P>;

/**
 * Create path match function from `path-to-regexp` spec.
 */
export function match<P extends object = object>(
  str: Path,
  options?: ParseOptions & TokensToRegexpOptions & RegexpToFunctionOptions
) {
  const keys: Key[] = [];
  const re = pathToRegexp(str, keys, options);
  return regexpToFunction<P>(re, keys, options);
}

/**
 * Create a path match function from `path-to-regexp` output.
 */
export function regexpToFunction<P extends object = object>(
  re: RegExp,
  keys: Key[],
  options: RegexpToFunctionOptions = {}
): MatchFunction<P> {
  const { decode = (x: string) => x } = options;

  return function (pathname: string) {
    const m = re.exec(pathname);
    if (!m) return false;

    const { 0: path, index } = m;
    const params = Object.create(null);

    for (let i = 1; i < m.length; i++) {
      // tslint:disable-next-line
      if (m[i] === undefined) continue;

      const key = keys[i - 1];

      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i].split(key.prefix + key.suffix).map((value) => {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i], key);
      }
    }

    return { path, index, params };
  };
}

/**
 * Escape a regular expression string.
 */
function escapeString(str: string) {
  return str.replace(/([.+*?^${}()[\]|/\\])/g, "\\$1");
}

/**
 * Get the flags for a regexp from the options.
 */
function flags(options?: { sensitive?: boolean }) {
  return options && options.sensitive ? "u" : "ui";
}

/**
 * Metadata about a key.
 */
export interface Key {
  name: string | number;
  prefix: string;
  suffix: string;
  pattern: string;
  modifier: string;
}

/**
 * A token is a string (nothing special) or key metadata (capture group).
 */
export type Token = string | Key;

/**
 * Pull out keys from a regexp.
 */
function regexpToRegexp(path: RegExp, keys?: Key[]): RegExp {
  if (!keys) return path;

  const groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;

  let index = 0;
  let execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: "",
    });
    execResult = groupsRegex.exec(path.source);
  }

  return path;
}

/**
 * Transform an array into a regexp.
 */
function arrayToRegexp(
  paths: Array<string | RegExp>,
  keys?: Key[],
  options?: TokensToRegexpOptions & ParseOptions
): RegExp {
  const parts = paths.map((path) => pathToRegexp(path, keys, options).source);
  return new RegExp(`(?:${parts.join("|")})`, flags(options));
}

/**
 * Create a path regexp from string input.
 */
function stringToRegexp(
  path: string,
  keys?: Key[],
  options?: TokensToRegexpOptions & ParseOptions
) {
  return tokensToRegexp(parse(path, options), keys, options);
}

export interface TokensToRegexpOptions {
  /**
   * When `true` the regexp will be case sensitive. (default: `false`)
   */
  sensitive?: boolean;
  /**
   * When `true` the regexp won't allow an optional trailing delimiter to match. (default: `false`)
   */
  strict?: boolean;
  /**
   * When `true` the regexp will match to the end of the string. (default: `true`)
   */
  end?: boolean;
  /**
   * When `true` the regexp will match from the beginning of the string. (default: `true`)
   */
  start?: boolean;
  /**
   * Sets the final character for non-ending optimistic matches. (default: `/`)
   */
  delimiter?: string;
  /**
   * List of characters that can also be "end" characters.
   */
  endsWith?: string;
  /**
   * Encode path tokens for use in the `RegExp`.
   */
  encode?: (value: string) => string;
}

/**
 * Expose a function for taking tokens and returning a RegExp.
 */
export function tokensToRegexp(
  tokens: Token[],
  keys?: Key[],
  options: TokensToRegexpOptions = {}
) {
  const {
    strict = false,
    start = true,
    end = true,
    encode = (x: string) => x,
  } = options;
  const endsWith = `[${escapeString(options.endsWith ?? "")}]|$`;
  const delimiter = `[${escapeString(options.delimiter ?? "/#?")}]`;
  let route = start ? "^" : "";

  // Iterate over the tokens and create our regexp string.
  for (const token of tokens) {
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      const prefix = escapeString(encode(token.prefix));
      const suffix = escapeString(encode(token.suffix));

      if (token.pattern) {
        if (keys) keys.push(token);

        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            const mod = token.modifier === "*" ? "?" : "";
            route += `(?:${prefix}((?:${token.pattern})(?:${suffix}${prefix}(?:${token.pattern}))*)${suffix})${mod}`;
          } else {
            route += `(?:${prefix}(${token.pattern})${suffix})${token.modifier}`;
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            route += `((?:${token.pattern})${token.modifier})`;
          } else {
            route += `(${token.pattern})${token.modifier}`;
          }
        }
      } else {
        route += `(?:${prefix}${suffix})${token.modifier}`;
      }
    }
  }

  if (end) {
    if (!strict) route += `${delimiter}?`;

    route += !options.endsWith ? "$" : `(?=${endsWith})`;
  } else {
    const endToken = tokens[tokens.length - 1];
    const isEndDelimited =
      typeof endToken === "string"
        ? delimiter.indexOf(endToken[endToken.length - 1]) > -1
        : // tslint:disable-next-line
          endToken === undefined;

    if (!strict) {
      route += `(?:${delimiter}(?=${endsWith}))?`;
    }

    if (!isEndDelimited) {
      route += `(?=${delimiter}|${endsWith})`;
    }
  }

  return new RegExp(route, flags(options));
}

/**
 * Supported `path-to-regexp` input types.
 */
export type Path = string | RegExp | Array<string | RegExp>;

/**
 * Normalize the given path string, returning a regular expression.
 *
 * An empty array can be passed in for the keys, which will hold the
 * placeholder key descriptions. For example, using `/user/:id`, `keys` will
 * contain `[{ name: 'id', delimiter: '/', optional: false, repeat: false }]`.
 */
export function pathToRegexp(
  path: Path,
  keys?: Key[],
  options?: TokensToRegexpOptions & ParseOptions
) {
  if (path instanceof RegExp) return regexpToRegexp(path, keys);
  if (Array.isArray(path)) return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
