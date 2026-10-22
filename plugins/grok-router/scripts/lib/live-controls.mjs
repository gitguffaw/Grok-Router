import { optionName, parseGrokHelp } from "./help.mjs";

export const ROUTER_OWNED_OPTIONS = new Set([
  "all",
  "allow-dangerous",
  "allow-mutating",
  "background",
  "base",
  "best",
  "cwd",
  "docs",
  "fresh",
  "full",
  "json",
  "lane",
  "lanes",
  "lean",
  "panel",
  "parallel",
  "raw-arg-string",
  "resume-last",
  "scope",
  "search",
  "timeout",
  "timeout-ms",
  "tool",
  "wait",
  "write"
]);

export const POLICY_OWNED_OPTIONS = new Set([
  "allow",
  "allowedTools",
  "always-approve",
  "deny",
  "disallowed-tools",
  "disallowedTools",
  "permission-mode",
  "sandbox",
  "tools",
  "yolo"
]);

const DANGEROUS_OPTION_PATTERN = /always-approve|yolo|bypass|danger/i;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function longName(names) {
  const longs = names.filter((name) => name.startsWith("--") && /^--[a-z0-9-]+$/.test(name));
  return longs.sort((left, right) => right.length - left.length)[0] ?? names.find((name) => name.startsWith("--")) ?? null;
}

function choicesForFlag(flag) {
  return unique(flag.possibleValues ?? []);
}

export function discoverGrokControls(helpText) {
  return parseGrokHelp(helpText).flags.flatMap((parsed) => {
    const flag = parsed.long ?? longName(parsed.names);
    if (!flag) {
      return [];
    }
    const option = optionName(flag);
    const aliases = parsed.names
      .filter((name) => name.startsWith("--") && name !== flag)
      .map(optionName);
    if (parsed.short) {
      aliases.push(optionName(parsed.short));
    }
    const allOptionNames = unique([option, ...aliases]);
    const policy = allOptionNames.some((name) => POLICY_OWNED_OPTIONS.has(name));
    const routerOwned = allOptionNames.some((name) => ROUTER_OWNED_OPTIONS.has(name));
    return [{
      flag,
      option,
      optionAliases: unique(aliases),
      inputKeys: unique([option, option.replaceAll("-", "_"), ...aliases, ...aliases.map((alias) => alias.replaceAll("-", "_"))]),
      kind: parsed.requiresValue ? "value" : parsed.optionalValue ? "optional-value" : "boolean",
      repeatable: Boolean(parsed.variadic) || allOptionNames.some((name) => ["allow", "deny"].includes(name)),
      valueHint: parsed.valueHint,
      choices: choicesForFlag(parsed),
      description: parsed.description,
      default: parsed.default,
      policy,
      routerOwned,
      dangerous: allOptionNames.some((name) => DANGEROUS_OPTION_PATTERN.test(name)) || policy,
      source: "grok-help"
    }];
  });
}

export function classifyControls(helpText) {
  const controls = discoverGrokControls(helpText);
  const commands = parseGrokHelp(helpText).commands;
  return {
    controls,
    commands,
    safeForward: controls.filter((control) => !control.policy && !control.routerOwned),
    policy: controls.filter((control) => control.policy),
    routerOwned: controls.filter((control) => control.routerOwned)
  };
}

export function liveControlParseConfig(controls) {
  const valueOptions = [];
  const optionalValueOptions = [];
  const booleanOptions = [];
  const repeatableOptions = [];
  const aliasMap = { m: "model", C: "cwd", r: "resume", s: "session-id", p: "single" };
  for (const control of controls) {
    if (control.kind === "value") {
      valueOptions.push(control.option);
    } else if (control.kind === "optional-value") {
      optionalValueOptions.push(control.option);
    } else {
      booleanOptions.push(control.option);
    }
    if (control.repeatable) {
      repeatableOptions.push(control.option);
    }
    for (const alias of control.optionAliases) {
      aliasMap[alias] = control.option;
    }
  }
  return { valueOptions, optionalValueOptions, booleanOptions, repeatableOptions, aliasMap };
}

export function nativeArgsFromParsedOptions(options, controls) {
  const args = [];
  for (const control of controls) {
    if (control.policy || control.routerOwned) {
      continue;
    }
    const key = control.inputKeys.find((candidate) => Object.prototype.hasOwnProperty.call(options, candidate));
    if (!key) {
      continue;
    }
    const value = options[key];
    if (control.kind === "boolean") {
      if (value === true) {
        args.push(control.flag);
      }
      continue;
    }
    if (control.kind === "optional-value" && value === true) {
      args.push(control.flag);
      continue;
    }
    if (value === undefined || value === null || value === false) {
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      args.push(control.flag, String(item));
    }
  }
  return args;
}

export function schemaForLiveControl(control) {
  let scalar;
  if (control.kind === "boolean") {
    scalar = { type: "boolean" };
  } else {
    scalar = { type: "string" };
  }
  const schema = control.repeatable
    ? { oneOf: [scalar, { type: "array", items: scalar }] }
    : control.kind === "optional-value"
      ? { oneOf: [{ type: "boolean" }, scalar] }
      : scalar;
  const choiceNote = control.choices?.length ? ` Current installed-CLI choices: ${control.choices.join(", ")}.` : "";
  if (control.description || choiceNote) {
    schema.description = `${control.description}${choiceNote}`.trim();
  }
  return schema;
}

export function coverageForSurface(helpText) {
  const parsed = parseGrokHelp(helpText);
  const classified = classifyControls(helpText);
  const firstClassCommands = new Set([
    "models",
    "inspect",
    "doctor",
    "login",
    "sessions",
    "help",
    "version"
  ]);
  return {
    flags: classified.controls.map((control) => ({
      option: control.option,
      flag: control.flag,
      coverage: control.routerOwned
        ? "router-owned"
        : control.policy
          ? "policy-owned"
          : "safe-forward"
    })),
    commands: parsed.commands.map((command) => ({
      name: command.name,
      coverage: firstClassCommands.has(command.name) ? "discovery" : "cli-only"
    }))
  };
}
