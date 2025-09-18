// index.js — SCP-294 backend (Railway, ESM) — structured output + custom effects + timeouts
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { RateLimiterMemory } from "rate-limiter-flexible";

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(cors({ origin: "*" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const limiter = new RateLimiterMemory({ points: 20, duration: 120 }); // 20 req / 2 min

// === Prompt: force a single whitelisted effect with small, safe params ===
const SYSTEM_PROMPT = `You are SCP-294's describer.
Pick EXACTLY ONE safe in-game effect from:
["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP","EXPLODE"].
Return a short, fun message, a plausible color, and optional effectParams (bounded).
- If user asks for harmful/illegal/NSFW: choose "NONE" and a refusal-flavored message.
- "EXPLODE" is slapstick only (no gore), affects ONLY the requester.
- Prefer variety: if request sounds energetic or explosive → EXPLODE; bright → GLOW; fast → SPEED_SMALL; floaty → JUMP_SMALL; cozy → WARMTH; chilly → COOLING; otherwise → NONE.
Respond STRICTLY with the schema; no extra keys.`;

// === Strict JSON schema (every object with properties has required[]) ===
const DrinkSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    displayName: { type: "string", maxLength: 40 },
    colorHex: { type: "string", pattern: "^#([0-9A-Fa-f]{6})$" },
    temperature: { type: "string", enum: ["cold","cool","ambient","warm","hot"] },
    container: { type: "string", enum: ["paper_cup","mug","glass","metal_cup"] },
    visual: {
      type: "object",
      additionalProperties: false,
      properties: {
        foam: { type: "boolean" },
        bubbles: { type: "boolean" },
        steam: { type: "boolean" }
      },
      required: ["foam","bubbles","steam"]
    },
    tasteNotes: { type: "array", items: { type: "string" }, maxItems: 3 },

    effectId: {
      type: "string",
      enum: ["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP","EXPLODE"]
    },

    effectParams: {
      type: "object",
      additionalProperties: false,
      properties: {
        // generic
        duration:        { type: "number", minimum: 0.5, maximum: 15 },
        // SPEED/JUMP
        speedMultiplier: { type: "number", minimum: 0.5, maximum: 2.0 },
        jumpBoost:       { type: "number", minimum: 0,   maximum: 50  },
        // GLOW
        glowBrightness:  { type: "number", minimum: 0,   maximum: 10  },
        // EXPLODE (cartoon)
        power:           { type: "number", minimum: 0,   maximum: 1   },
        radius:          { type: "number", minimum: 0,   maximum: 12  }
      },
      // strict mode wants every key listed here:
      required: ["duration","speedMultiplier","jumpBoost","glowBrightness","power","radius"]
    },

    message: { type: "string", maxLength: 120 }
  },
  // root required must include every property except effectParams (it's optional as a whole)
  required: ["displayName","colorHex","temperature","container","visual","tasteNotes","effectId","message"]
};

// ---------- helpers ----------
const FALLBACK_OK = (q) => ({
  displayName: q || "Generic Beverage",
  colorHex: "#A0C4FF",
  temperature: "ambient",
  container: "paper_cup",
  visual: { foam: false, bubbles: true, steam: false },
  tasteNotes: ["mild"],
  effectId: "NONE",
  message: "A nondescript drink dispenses with a soft hum."
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label || "op"}:${ms}ms`)), ms)
    )
  ]);
}

// Extract parsed JSON regardless of SDK shape
function extractDrinkStruct(r) {
  if (r && r.output_parsed) return r.output_parsed;
  const out = r?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c.parsed === "object") return c.parsed;
          if (c && typeof c.json === "object") return c.json;
          if (c?.type === "output_text" && typeof c.text === "string") {
            const s = c.text.trim();
            if (s.startsWith("{") && s.endsWith("}")) { try { return JSON.parse(s); } catch {} }
            const m = s.match(/\{[\s\S]*\}/);
            if (m) { try { return JSON.parse(m[0]); } catch {} }
          }
        }
      }
    }
  }
  const t = r?.output_text;
  if (typeof t === "string" && t.trim()) {
    const s = t.trim();
    if (s.startsWith("{") && s.endsWith("}")) { try { return JSON.parse(s); } catch {} }
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
  }
  return null;
}

// ---------- routes ----------
app.get("/api/scp294", (_req, res) => {
  res.json({ ok: true, hint: "POST here with JSON: { query: 'lemonade' }" });
});

app.get("/api/debug", (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    uptime: process.uptime(),
    env: process.env.RAILWAY_ENVIRONMENT || "unknown"
  });
});

app.post("/api/scp294", async (req, res) => {
  const t0 = Date.now();
  try {
    await limiter.consume(req.ip);

    const query = String(req.body?.query ?? "").slice(0, 50).trim();
    if (!query) return res.status(400).json({ error: "Missing query" });

    // 1) quick moderation (2s cap)
    try {
      const mod = await withTimeout(
        openai.moderations.create({ model: "omni-moderation-latest", input: query }),
        2000,
        "moderation"
      );
      if (mod?.results?.[0]?.flagged) {
        return res.json({
          displayName: "Unknown Liquid",
          colorHex: "#7F7F7F",
          temperature: "ambient",
          container: "paper_cup",
          visual: { foam: false, bubbles: false, steam: false },
          tasteNotes: ["neutral"],
          effectId: "NONE",
          message: "The machine refuses to dispense that request."
        });
      }
    } catch (_) {}

    // 2) structured output (6.5s cap)
    let resp;
    try {
      resp = await withTimeout(
        openai.responses.create({
          model: "gpt-4o-mini",
          instructions: SYSTEM_PROMPT,
          input: `Request: ${query}`,
          temperature: 0.2,
          text: {
            format: {
              type: "json_schema",
              name: "Drink",
              schema: DrinkSchema,
              strict: true
            }
          }
        }),
        6500,
        "responses.create"
      );
    } catch (e) {
      console.error("[SCP294] responses.create failed:", e?.response?.data || e?.message || e);
      return res.json(FALLBACK_OK(query));
    }

    const data = extractDrinkStruct(resp);
    if (!data || !data.effectId) {
      console.warn("[SCP294] parse returned no effect; sending fallback");
      return res.json(FALLBACK_OK(query));
    }

    // Guardrails: clean/sanitize
    const clean = {
      displayName: String(data.displayName || query || "Beverage").slice(0, 40),
      colorHex: /^#[0-9a-fA-F]{6}$/.test(String(data.colorHex)) ? data.colorHex : "#A0C4FF",
      temperature: ["cold","cool","ambient","warm","hot"].includes(data.temperature) ? data.temperature : "ambient",
      container: ["paper_cup","mug","glass","metal_cup"].includes(data.container) ? data.container : "paper_cup",
      visual: {
        foam: !!(data?.visual?.foam),
        bubbles: !!(data?.visual?.bubbles),
        steam: !!(data?.visual?.steam)
      },
      tasteNotes: Array.isArray(data.tasteNotes) ? data.tasteNotes.slice(0,3).map(String) : [],
      effectId: ["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP","EXPLODE"]
        .includes(data.effectId) ? data.effectId : "NONE",
      effectParams: (typeof data.effectParams === "object" && data.effectParams) ? data.effectParams : {},
      message: String(data.message || "").slice(0, 120) || "The machine chirps pleasantly."
    };

    console.log(`[SCP294] ok "${clean.displayName}" → ${clean.effectId} in ${Date.now() - t0}ms`);
    res.json(clean);
  } catch (e) {
    console.error("[SCP294] POST error:", e?.response?.data || e?.message || e);
    res.json({
      displayName: "Machine Coolant (Safe Replica)",
      colorHex: "#88E0FF",
      temperature: "cool",
      container: "metal_cup",
      visual: { foam: false, bubbles: false, steam: false },
      tasteNotes: ["minty"],
      effectId: "COOLING",
      message: "Failsafe blend dispensed."
    });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SCP-294 backend on :" + PORT));

process.on("SIGTERM", () => {
  console.log("Received SIGTERM (platform probe or redeploy). Exiting cleanly.");
  process.exit(0);
});
