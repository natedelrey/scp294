// index.js — SCP-294 backend (Express + OpenAI Responses API, JSON Schema output)
const express = require("express");
const cors = require("cors");

// ---- CONFIG ----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

// Model you want to use
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Effect enum the model is allowed to choose from
const EFFECT_ENUM = [
  "NONE","WARMTH","COOLING",
  "SPEED_SMALL","SPEED_MED","SPEED_LARGE",
  "JUMP_SMALL","JUMP_MED",
  "LOW_GRAVITY","HIGH_GRAVITY","SLIPPERY","STICKY",
  "GLOW","GLOW_STRONG","AURA_SPARKS","SMOKE_PUFF",
  "CAMERA_SHAKE","TUNNEL_VISION","SPIN","KNOCKDOWN",
  "BURP","BREEZE","POP_EXPLODE",
  "BURP_SFX","SODA_OPEN","MAGIC_CHIME","THUNDER_CLAP","BASS_DROP","DUCK_QUACK",
  "BUBBLES","CONFETTI","HEARTS","SKULLS","STARBURST","FOG_RING","FOG_RING_EMIT",
  "DUCK_PROP","BALLOON_SPAWN","HAT_PROP",
  "VINTAGE_FILTER","PIXELATE","SCANLINES",
  "SHRINK_VFX","GROW_VFX"
];

// Soft denylist for obvious disallowed requests (kept simple; Roblox handles safety too)
const DENY = [
  "acid", "cyanide", "poison", "bleach", "mercury", "radiation", "uranium",
  "napalm", "arsenic", "rat poison", "chloroform", "lye",
  "blood", "semen", "urine", "feces", "gasoline", "diesel", "antifreeze",
  "heroin", "cocaine", "meth", "fentanyl"
];

// JSON Schema for the Responses API (must include required arrays)
const DrinkSchema = {
  name: "Drink",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      drinkName: { type: "string", minLength: 1, maxLength: 64 },
      colorHex: {
        type: "string",
        pattern: "^#([0-9A-Fa-f]{6})$",
        description: "sRGB hex color for the liquid, e.g. #8FD6FF"
      },
      description: { type: "string", minLength: 1, maxLength: 180 },
      tasteNotes: { type: "string", minLength: 1, maxLength: 120 },
      effectId: { type: "string", enum: EFFECT_ENUM },
      effectParams: {
        type: "object",
        additionalProperties: false,
        properties: {
          duration: { type: "number", minimum: 0, maximum: 60 },
          speedMultiplier: { type: "number", minimum: 0.2, maximum: 3 },
          jumpBoost: { type: "number", minimum: 0, maximum: 80 },
          glowBrightness: { type: "number", minimum: 0, maximum: 20 },
          power: { type: "number", minimum: 0, maximum: 10 },
          radius: { type: "number", minimum: 0, maximum: 30 }
        },
        // Responses API requires 'required' to include every key listed in properties
        required: ["duration","speedMultiplier","jumpBoost","glowBrightness","power","radius"]
      },
      safe: { type: "boolean", description: "true if suitable for a Roblox player to drink" }
    },
    required: ["drinkName","colorHex","description","tasteNotes","effectId","effectParams","safe"]
  },
  strict: true
};

// Fallbacks when we refuse
const FALLBACK_DENY = (q) => ({
  drinkName: `Unknown Liquid`,
  colorHex: "#5A5A5A",
  description: "The machine hums but refuses your request.",
  tasteNotes: "Flat, metallic, indeterminate.",
  effectId: "NONE",
  effectParams: { duration: 0, speedMultiplier: 1, jumpBoost: 0, glowBrightness: 0, power: 0, radius: 0 },
  safe: false
});

const FALLBACK_OK = (q) => ({
  drinkName: `Cup of ${q.slice(0, 50)}`,
  colorHex: "#8FD6FF",
  description: "A mysteriously accurate rendition appears in the cup.",
  tasteNotes: "Surprisingly authentic.",
  effectId: "NONE",
  effectParams: { duration: 0, speedMultiplier: 1, jumpBoost: 0, glowBrightness: 0, power: 0, radius: 0 },
  safe: true
});

const app = express();
app.use(cors());
app.use(express.json());

// Health + root
app.get("/", (_req, res) => res.json({ ok: true, service: "SCP294", model: MODEL }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Utility: basic deny check
function isDenied(query) {
  const q = (query || "").toLowerCase();
  return DENY.some(term => q.includes(term));
}

// Utility: robustly extract JSON from Responses API
function extractDrink(resp) {
  // Typical shape: { output: [ { content: [ { type: "output_text", text: "{...json...}" } ] } ] }
  const o = resp || {};
  try {
    if (o.output && o.output.length > 0) {
      const content = o.output[0].content && o.output[0].content[0];
      if (!content) throw new Error("no content");
      if (content.type === "output_text") {
        return JSON.parse(content.text);
      }
      if (content.type === "output_json") {
        return content.json;
      }
    }
  } catch (e) {
    // try alternate fields (future-proof)
    if (o.output_text) {
      try { return JSON.parse(o.output_text); } catch {}
    }
  }
  throw new Error("Unable to parse model output");
}

const SYSTEM_PROMPT = `You are SCP-294, a beverage dispenser that can produce any liquid that is safe for a Roblox game context.
Follow these rules:
- If the user requests something obviously harmful, illegal, or biological fluids, refuse with a safe=false result and effectId="NONE".
- Otherwise, produce a plausible drinkName (prefix not needed; server will label the tool), a HEX color for the liquid, a short flavor description & tasteNotes.
- Choose an effectId ONLY from the allowed enum. Use the numeric effectParams reasonably:
  • duration: 3–10s for buffs/VFX; 0 when none
  • speedMultiplier: 1.0 for normal; up to 1.9 for SPEED_LARGE; down to 0.6 for STICKY
  • jumpBoost: 0–35 (small/med)
  • glowBrightness: 0–10
  • power: 0–5 for camera/feel type
  • radius: 6–12 for POP_EXPLODE or breeze push
- Keep it safe, fun, and non-graphic. Keep text under the specified max lengths.
Return ONLY valid JSON per the provided schema.`;

app.post("/api/scp294", async (req, res) => {
  try {
    const query = String((req.body && req.body.query) || "").trim();
    if (!query) {
      return res.status(400).json({ status: "error", code: 400, message: "Missing 'query' body field" });
    }

    // quick soft safety
    if (isDenied(query)) {
      return res.json({ status: "ok", source: "denylist", drink: FALLBACK_DENY(query) });
    }

    // Call Responses API
    const body = {
      model: MODEL,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Drink request: ${query}` }
      ],
      response_format: {
        type: "json_schema",
        json_schema: DrinkSchema
      }
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[SCP294] responses.create failed:", r.status, text);
      // graceful fallback OK (non-fatal)
      return res.json({ status: "ok", source: "fallback", drink: FALLBACK_OK(query) });
    }

    const data = await r.json();
    let drink = extractDrink(data);

    // Final guard: if model ever chose effectId not in enum, normalize to NONE
    if (!EFFECT_ENUM.includes(drink.effectId)) {
      drink.effectId = "NONE";
      drink.effectParams = { duration: 0, speedMultiplier: 1, jumpBoost: 0, glowBrightness: 0, power: 0, radius: 0 };
    }

    // Clamp numeric fields to safe ranges (belt & suspenders)
    const ep = drink.effectParams || {};
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
    ep.duration = clamp(ep.duration, 0, 60);
    ep.speedMultiplier = clamp(ep.speedMultiplier, 0.2, 3);
    ep.jumpBoost = clamp(ep.jumpBoost, 0, 80);
    ep.glowBrightness = clamp(ep.glowBrightness, 0, 20);
    ep.power = clamp(ep.power, 0, 10);
    ep.radius = clamp(ep.radius, 0, 30);
    drink.effectParams = ep;

    return res.json({ status: "ok", source: "model", drink });
  } catch (err) {
    console.error("[SCP294] POST error:", err);
    return res.status(500).json({ status: "error", code: 500, message: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`SCP-294 backend listening on :${PORT}`);
});
