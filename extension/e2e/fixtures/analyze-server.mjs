// TEST FIXTURE — a stand-in for the PromptSecura backend in e2e tests.
//
// It speaks the same HTTP contract as POST /api/v1/analyze (see
// backend/app/schemas/analysis.py) with canned, deterministic decisions:
//   - text containing "ignore all previous instructions" -> BLOCK (70)
//   - text containing an email address                   -> SANITIZE (35), with
//     sanitized_prompt = emails replaced by [EMAIL]
//   - anything else                                      -> ALLOW (0)
// It is NOT the real detection pipeline; the backend has its own tests.
// Modes: "normal", "503" (analysis_unavailable), and stop()/start() for "down".
import http from "node:http";

const FAIL_MSG = "PromptSecura could not complete the security analysis.";
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function body(decision, score, extra = {}) {
  return {
    request_id: `fixture-${Date.now()}`,
    decision,
    risk_level: score <= 30 ? "low" : score <= 60 ? "medium" : "high",
    risk_score: score,
    reasons: [],
    pii_entities: [],
    pii_summary: {},
    injection_matches: [],
    score_breakdown: { pii: 0, injection: 0, obfuscation: 0, total: score },
    sanitized_prompt: null,
    latency_ms: 1,
    detectors: { pii: "fixture", injection: "fixture" },
    ...extra,
  };
}

export function decide(prompt) {
  if (prompt.toLowerCase().includes("ignore all previous instructions")) {
    return body("BLOCK", 70, {
      reasons: ["Attempts to make the model ignore or override its previous instructions (rule: instruction_override)"],
      injection_matches: [
        {
          rule_id: "instruction_override",
          category: "prompt_injection",
          description: "Attempts to make the model ignore or override its previous instructions",
          weight: 70,
        },
      ],
    });
  }
  const emails = prompt.match(EMAIL);
  if (emails) {
    return body("SANITIZE", 35, {
      pii_summary: { EMAIL_ADDRESS: emails.length },
      reasons: [`Sensitive information detected: EMAIL_ADDRESS x${emails.length}`],
      sanitized_prompt: prompt.replace(EMAIL, "[EMAIL]"),
    });
  }
  return body("ALLOW", 0);
}

export function createAnalyzeServer(port) {
  const state = { mode: "normal", delayMs: 0, requests: [] };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (req.url !== "/api/v1/analyze" || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const prompt = String(JSON.parse(data || "{}").prompt ?? "");
      state.requests.push({ at: Date.now(), prompt });
      setTimeout(() => {
        if (state.mode === "503") {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "analysis_unavailable", message: FAIL_MSG, retryable: true }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(decide(prompt)));
      }, state.delayMs);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    state,
    start: () => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
