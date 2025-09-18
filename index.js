// index.js — SCP-294 backend (Railway, ESM) | fast-fail + logs + structured output
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

const SYSTEM_PROMPT = `You are SCP-294's describer. Choose a SAFE in-game effect from this enum:
["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP","EXPLODE"].
Return color/visuals and ONE effect with optional params. Never invent new effectIds.
EXPLODE must be slapstick (no gore) and only affects the requesting player. Keep output PG-13.`;

// Strict JSON schema (required includes every key)
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
      properties: { foam:{type:"boolean"}, bubbles:{type:"boolean"}, steam:{type:"boolean"} },
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
        duration: { type: "number", minimum: 0.5, maximum: 15 },
        speedMultiplier: { type: "number", minimum: 0.5, maximum: 2.0 },
        jumpBoost: { type: "number", minimum: 0, maximum: 50 },
        glowBrightness: { type: "number", minimum: 0, maximum: 10 },
        power: { type: "number", minimum: 0, maximum: 1 },
        radius: { type: "number", minimum: 0, maximum: 12 }
      }
    },
    message: { type: "string", maxLength: 120 }
  },
  required: ["displayName","colorHex","temperature","container","visual","tasteNotes","effectId","message"]
};

// ===== helpers =====
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

// quick GET for browser sanity check
app.get("/api/scp294", (_req, res) => {
  res.json({ ok: true, hint: "POST here with JSON: { query: 'lemonade' }" });
});

// optional debug (does NOT leak key)
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

    console.log(`[SCP294] POST start q="${query}"`);

    // 1) Moderation (fast-fail, timeout 2000ms)
    try {
      const mod = await withTimeout(
        openai.moderations.create({ model: "omni-moderation-latest", input: query }),
        2000,
        "moderation"
      );
      if (mod?.results?.[0]?.flagged) {
        console.log("[SCP294] moderation: flagged");
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
      console.log("[SCP294] moderation: ok");
    } catch (e) {
      console.warn("[SCP294] moderation skipped:", e.message || e);
    }

    // 2) Structured output (timeout 6500ms)
    let r;
    try {
      r = await withTimeout(
        openai.responses.create({
          model: "gpt-4o-mini",
          instructions: SYSTEM_PROMPT,
          input: `Request: ${query}`,
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
      console.error("[SCP294] responses.create failed:", e.message || e);
      return res.json(FALLBACK_OK(query)); // respond immediately (avoid 502)
    }

    const text = r.output_text ?? r.output?.[0]?.content?.[0]?.text ?? "{}";
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!data || !data.effectId) {
      console.warn("[SCP294] parse failed; sending fallback");
      return res.json(FALLBACK_OK(query));
    }

    console.log(`[SCP294] ok in ${Date.now()-t0}ms`);
    res.json(data);
  } catch (e) {
    console.error("[SCP294] POST error:", e?.response?.data || e?.message || e);
    // hard fallback
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

// health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SCP-294 backend on :" + PORT));

// cosmetic: quiet the build probe logs
process.on("SIGTERM", () => {
  console.log("Received SIGTERM (platform probe or redeploy). Exiting cleanly.");
  process.exit(0);
});
