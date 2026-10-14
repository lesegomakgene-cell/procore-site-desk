// Minimal streaming client for the Anthropic Messages API (built-in fetch, no SDK).
// Streaming keeps long analyses (big drawing sets, high effort) clear of HTTP
// timeouts and lets the UI show progress.

// Models that accept server-side refusal fallbacks ("fallbacks": "default").
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;

class ClaudeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function streamMessage({ apiKey, model, effort, system, messages, maxTokens, outputFormat, onProgress }) {
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages,
    thinking: { type: "adaptive" },
    output_config: { effort },
  };
  if (outputFormat) body.output_config.format = outputFormat;
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (FALLBACK_MODELS.test(model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }

  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetch(base + "/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `Anthropic API error ${res.status}`;
    try {
      const j = await res.json();
      if (j.error && j.error.message) msg += `: ${j.error.message}`;
    } catch {}
    throw new ClaudeError(msg, res.status);
  }

  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  let stopReason = null;
  let usage = {};
  let phase = "";
  const setPhase = (p) => {
    if (p !== phase) {
      phase = p;
      onProgress && onProgress({ phase, chars: text.length });
    }
  };

  const handle = (evt) => {
    switch (evt.type) {
      case "message_start":
        usage = { ...(evt.message && evt.message.usage) };
        setPhase("reading");
        break;
      case "content_block_start":
        if (evt.content_block.type === "thinking") setPhase("thinking");
        else if (evt.content_block.type === "text") setPhase("writing");
        else if (evt.content_block.type === "fallback") text = ""; // another model took over - discard partial output
        break;
      case "content_block_delta":
        if (evt.delta.type === "text_delta") {
          text += evt.delta.text;
          if (text.length % 400 < evt.delta.text.length) onProgress && onProgress({ phase: "writing", chars: text.length });
        }
        break;
      case "message_delta":
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = { ...usage, ...evt.usage };
        break;
      case "error":
        throw new ClaudeError(`Anthropic API error: ${(evt.error && evt.error.message) || "stream error"}`, 500);
    }
  };

  for await (const chunk of res.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffered.indexOf("\n\n")) >= 0) {
      const raw = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      handle(evt);
    }
  }

  if (stopReason === "refusal") {
    throw new ClaudeError("The model declined to analyse this content. Try removing unrelated attachments and run it again.", 422);
  }
  if (stopReason === "max_tokens") {
    throw new ClaudeError("The analysis ran out of room before finishing. Try fewer attachments, or raise MAX_TOKENS in .env.", 422);
  }
  return { text, stopReason, usage };
}

module.exports = { streamMessage, ClaudeError };
