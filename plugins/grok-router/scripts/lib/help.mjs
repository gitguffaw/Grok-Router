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
  const match = String(text ?? "").match(/\[aliases:\s*([^\]]+)\]/i);
  if (!match) {
    return [];
  }
  return unique(
    match[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseFlagLine(line) {
  const match = line.match(
    /^\s{2,}(?:(-[A-Za-z0-9]),\s*)?(--[a-z0-9][a-z0-9-]*)(?:\s+(<[^>]+>|\[\s*<[^>]+>\s*\]))?/i
  );
  if (!match) {
    return null;
  }
  const valueToken = match[3] ?? "";
  const optionalValue = valueToken.startsWith("[");
  const valueHint = valueToken.replace(/^[\[<]\s*/, "").replace(/\s*[\]>]$/, "").replace(/^<|>$/g, "") || null;
  return {
    short: match[1] ?? null,
    long: match[2],
    valueHint,
    optionalValue,
    requiresValue: Boolean(valueHint) && !optionalValue
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
        currentFlag = {
          ...flag,
          names: unique([flag.long, flag.short]),
          aliases: [],
          description: "",
          possibleValues: [],
          default: null
        };
        flags.push(currentFlag);
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
