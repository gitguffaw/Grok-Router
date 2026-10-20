import { nativeArgsFromParsedOptions } from "./live-controls.mjs";
import { READ_ONLY_TOOLS, READ_ONLY_WEB_TOOLS } from "./grok.mjs";
import { applyLeanToRequest, resolveLean, REVIEW_JSON_SCHEMA } from "./lean.mjs";
import { resolveModelSelector } from "./models.mjs";

const MODE_CONFIG = {
  analyze: { workflow: "Analyze", write: false },
  exec: { workflow: "Exec", write: true },
  review: { workflow: "Review", write: false, review: true, rejectFocus: true },
  "adversarial-review": { workflow: "Adversarial Review", write: false, review: true },
  rescue: { workflow: "Rescue", write: null }
};

function requirePrompt(prompt, { allowEmpty = false } = {}) {
  if (!allowEmpty && !String(prompt ?? "").trim()) {
    throw new Error("Provide a prompt.");
  }
}

function rejectWait(options) {
  if (options.wait) {
    throw new Error("--wait is only valid on status. Foreground is the default; pass --background to detach.");
  }
}

function toolsFor(mode, options) {
  if (MODE_CONFIG[mode]?.write) {
    return null;
  }
  return options.search ? READ_ONLY_WEB_TOOLS : READ_ONLY_TOOLS;
}

function buildPrompt(mode, prompt, options, extras = {}) {
  const text = String(prompt ?? "").trim();
  const parts = [];
  if (mode === "analyze") {
    parts.push(
      "Question / task:",
      text,
      "",
      "Contract:",
      "- Return observed facts, options, tradeoffs, recommendation, and next action.",
      "- Cite files and line ranges when the repo is in scope.",
      "- Do not edit files, apply patches, or run mutating commands."
    );
  } else if (mode === "exec") {
    parts.push(
      "Goal:",
      text,
      "",
      "Contract:",
      "- Implement the requested change narrowly.",
      "- Put verification in the work (tests, lint, typecheck as appropriate).",
      "- Return summary, touched files, verification, and residual risks.",
      "- Avoid unrelated refactors."
    );
  } else if (mode === "review") {
    parts.push(
      "Review the selected Git changes. Findings only; do not edit.",
      extras.diffPreamble ?? "",
      text && text !== "Review the current uncommitted changes." ? `Focus is not accepted on review. Treating the request as a review of the selected diff.\n` : "",
      "Contract:",
      "- Prioritized findings with file paths and concrete risk.",
      "- Suggested fix direction, not patches.",
      "- Do not edit files."
    );
  } else if (mode === "adversarial-review") {
    parts.push(
      "Adversarial review. Challenge the approach, assumptions, tradeoffs, and failure modes. Findings only; do not edit.",
      extras.diffPreamble ?? "",
      text ? `Focus:\n${text}` : "",
      "",
      "Contract:",
      "- Findings first, ordered by severity.",
      "- Question whether this was the right design, not only whether the lines are locally correct.",
      "- Do not edit files or apply fixes."
    );
  } else if (mode === "rescue") {
    parts.push(
      options.write === false || (!options.write && extras.diagnosisOnly)
        ? "Investigate the problem. Do not edit unless the user explicitly asked for a fix."
        : "Investigate and fix the problem with the smallest safe change.",
      "",
      text
    );
  }
  if (extras.lane) {
    parts.push("", `Lane: ${extras.lane}. Cover only this concern. Do not spawn subagents.`);
  }
  if (options.docs) {
    parts.push("", "Use inner Grok docs/MCP documentation tools when current upstream docs matter. Do not substitute outer-host docs tools.");
  }
  if (options.tool) {
    const tools = Array.isArray(options.tool) ? options.tool : [options.tool];
    parts.push("", `Use this inner Grok capability if available: ${tools.join(", ")}. Fail explicitly if it is not available. Do not substitute an outer-host tool of a similar name.`);
  }
  if (options.search) {
    parts.push("", "Use inner Grok web_search / web_fetch when current external facts matter. Cite sources.");
  }
  return parts.filter((part) => part !== "").join("\n");
}

export function buildRouterRequest({
  mode,
  prompt,
  options = {},
  gitBefore = null,
  catalog = null,
  nativeControls = [],
  diff = null
}) {
  const config = MODE_CONFIG[mode];
  if (!config) {
    throw new Error(`Unsupported Grok Router mode "${mode}".`);
  }
  rejectWait(options);
  if (mode === "review" && String(prompt ?? "").trim()) {
    throw new Error("Focus text is not accepted on review. Use adversarial-review for steered review.");
  }
  const effectivePrompt = String(prompt ?? "").trim()
    || (config.review ? "Review the current uncommitted changes." : "");
  requirePrompt(effectivePrompt, { allowEmpty: false });

  if ((options.docs || options.tool || options.search) && config.review && mode === "review") {
    throw new Error("--search, --docs, and --tool are not supported on review. Use analyze or exec, or adversarial-review for steered review.");
  }
  const lean = resolveLean(options);

  const write = mode === "rescue"
    ? options.write !== false && options.write !== "false"
    : Boolean(config.write);

  let model = null;
  if (options.best || options.model) {
    if (!catalog) {
      throw new Error("Model catalog is required to resolve --model / --best.");
    }
    model = resolveModelSelector(catalog, options.model, { best: Boolean(options.best) });
  }
  const effort = options.effort ?? options["reasoning-effort"] ?? null;
  const tools = write ? null : toolsFor(mode, options);
  const resume = options.resume && options.resume !== true ? options.resume : null;
  // A named resume is emitted by buildGrokPrintArgs through controls.
  // Keep a bare --resume on the native path for the CLI session picker.
  const nativeArgs = nativeArgsFromParsedOptions(options,
    nativeControls.filter((control) => control.option !== "resume" || !resume));
  const diffPreamble = diff?.text
    ? `\nSelected diff (\`${diff.command}\`):\n\n${diff.text}\n`
    : "";
  const routedPrompt = buildPrompt(mode, effectivePrompt, { ...options, write }, {
    diffPreamble,
    diagnosisOnly: !write,
    lane: options.lane ?? null
  });
  const jsonSchema = config.review ? REVIEW_JSON_SCHEMA : null;
  const leaf = Boolean(options.lane || options.panel || options.parallel || options.lanes);

  const request = applyLeanToRequest({
    mode,
    workflow: config.workflow,
    write,
    tools,
    outputFormat: "json",
    prompt: routedPrompt,
    userRequest: effectivePrompt,
    controls: {
      model,
      effort,
      timeoutMs: options["timeout-ms"],
      resume,
      continue: Boolean(options.continue && !options.resume)
    },
    nativeArgs,
    gitBefore,
    diff,
    jsonSchema,
    nonGoals: write ? ["Avoid unrelated refactors."] : ["Do not edit files."],
    constraints: ["Preserve user changes.", "Do not synthesize an outer-host substitute if Grok fails."]
  }, { mode, options, lean });
  if (leaf) {
    request.noSubagents = true;
    request.extraEnv = { ...(request.extraEnv ?? {}), GROK_ROUTER_NESTING: "1" };
  }
  return request;
}
