function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parsePossibleValues(text) {
  const block = String(text ?? "");
  const listed = [];
  for (const match of block.matchAll(/^\s*-\s+([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) {
    listed.push(match[1]);
  }
  const bracket = block.match(/\[possible values:\s*([^\]]+)\]/i);
  if (bracket) {
    listed.push(...bracket[1].split(",").map((item) => item.trim()).filter(Boolean));
  }
  return unique(listed);
}

function parseDefault(text) {
  const match = String(text ?? "").match(/\[default:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function parseAliases(text) {
  const raw = String(text ?? "");
  const collected = [];
  for (const bracket of raw.matchAll(/\[aliases:\s*([^\]]+)\]/gi)) {
    collected.push(...bracket[1].split(","));
  }
  for (const compat of raw.matchAll(/\(compat alias(?:es)?:\s*([^)]+)\)/gi)) {
    collected.push(...compat[1].split(","));
  }
  return unique(
    collected
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseFlagLine(line) {
  const match = line.match(
    /^\s{2,}(?:(?:(-[A-Za-z0-9]),\s*)?(--[A-Za-z0-9][A-Za-z0-9-]*)|(-[A-Za-z0-9]))(?:(?:\s+|=)(<[^>]+>(?:\.\.\.)?|\[\s*(?:=\s*)?<[^>]+>(?:\.\.\.)?\s*\])|(\[\s*=\s*<[^>]+>(?:\.\.\.)?\s*\]))?(?:\s{2,}(.+))?$/
  );
  if (!match) {
    return null;
  }
  const short = match[1] ?? match[3] ?? null;
  const long = match[2] ?? null;
  const valueToken = match[4] ?? match[5] ?? "";
  const inlineDescription = (match[6] ?? "").trim();
  const optionalValue = valueToken.startsWith("[");
  const variadic = /\.\.\.(?:\s*\])?$/.test(valueToken);
  const rawHint = valueToken
    .replace(/^\[\s*=?\s*/, "")
    .replace(/\s*\]$/, "")
    .replace(/\.\.\.$/, "")
    .replace(/^<|>$/g, "")
    .trim();
  const valueHint = rawHint || null;
  return {
    short,
    long,
    valueHint,
    optionalValue,
    requiresValue: Boolean(valueHint) && !optionalValue,
    variadic,
    inlineDescription
  };
}

function parseCommandLine(line) {
  const match = line.match(/^\s{2}([a-z][a-z0-9-]*)\s{2,}(.*)$/i);
  if (!match) {
    return null;
  }
  const description = match[2].trim();
  const aliases = parseAliases(description).map((alias) => alias.replace(/^--/, ""));
  return {
    name: match[1],
    aliases,
    description: description.replace(/\s*\[aliases:[^\]]+\]/i, "").trim()
  };
}

export function parseGrokHelp(text) {
  const flags = [];
  const commands = [];
  const parseWarnings = [];
  let section = null;
  let currentFlag = null;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^options:/i.test(trimmed)) {
      section = "options";
      currentFlag = null;
      continue;
    }
    if (/^commands:/i.test(trimmed)) {
      section = "commands";
      currentFlag = null;
      continue;
    }
    if (/^(arguments|usage):/i.test(trimmed)) {
      section = trimmed.toLowerCase().startsWith("arguments") ? "arguments" : "usage";
      currentFlag = null;
      continue;
    }
    if (section === "commands") {
      const command = parseCommandLine(line);
      if (command) {
        commands.push(command);
      } else if (/^\s{2}\S/.test(line) && !trimmed.startsWith("-")) {
        parseWarnings.push(`unparsed command line: ${trimmed}`);
      }
      continue;
    }
    if (section === "options" || /^\s{2,}(?:-[A-Za-z0-9],\s*)?--[a-z0-9]/.test(line)) {
      const flag = parseFlagLine(line);
      if (flag) {
        const { inlineDescription, ...flagMeta } = flag;
        const inlineAliases = parseAliases(inlineDescription).filter((alias) => alias.startsWith("-"));
        currentFlag = {
          ...flagMeta,
          names: unique([flag.long, flag.short, ...inlineAliases]),
          aliases: inlineAliases,
          description: inlineDescription,
          possibleValues: parsePossibleValues(inlineDescription),
          default: parseDefault(inlineDescription)
        };
        flags.push(currentFlag);
        continue;
      }
      if (section === "options" && /^\s{2,6}-\S/.test(line)) {
        parseWarnings.push(`unparsed option line: ${trimmed}`);
        currentFlag = null;
        continue;
      }
    }
    if (currentFlag && /^\s{4,}\S/.test(line)) {
      currentFlag.description = `${currentFlag.description} ${trimmed}`.trim();
      currentFlag.possibleValues = parsePossibleValues(currentFlag.description);
      currentFlag.default = parseDefault(currentFlag.description);
      const extraAliases = parseAliases(currentFlag.description);
      currentFlag.aliases = unique([
        ...currentFlag.aliases,
        ...extraAliases.filter((alias) => alias.startsWith("--") || alias.startsWith("-"))
      ]);
      currentFlag.names = unique([...currentFlag.names, ...currentFlag.aliases]);
    }
  }

  return { flags, commands, parseWarnings };
}

export function extractVersion(text) {
  const trimmed = String(text ?? "").trim();
  const match = trimmed.match(/grok\s+(\S+)/i);
  return match ? match[1] : trimmed.split(/\s+/)[0] || trimmed;
}

export function optionName(flag) {
  return String(flag ?? "").replace(/^-+/, "");
}
