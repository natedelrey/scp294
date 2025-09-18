// index.js — SCP-294 backend (Railway, ESM)
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { RateLimiterMemory } from "rate-limiter-flexible";

// --- express app FIRST ---
const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(cors({ origin: "*" }));

// --- OpenAI + rate limit ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const limiter = new RateLimiterMemory({ points: 20, duration: 120 }); // 20 req / 2 min

// --- helpers ---
const SYSTEM_PROMPT = `You are SCP-294's describer. Given a requested drink name, return ONLY harmless cosmetics and a SAFE effectId from this enum:
["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP"].
Never invent new effectIds. Avoid real alcohol/drugs/poisons; if requested, map to "NONE" and include a safety-themed, in-universe message.
Use plausible colors and containers; keep it PG-13.`;

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
    effectId: { type: "string", enum: ["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP"] },
    message: { type: "string", maxLength: 120 }
  },
  required: ["displayName","colorHex","temperature","container","visual","effectId","message"]
};

// GET helper so you can open it in the browser
app.get("/api/scp294", (_req, res) => {
  res.json({ ok: true, hint: "POST here with JSON: { query: 'lemonade' }" });
});

// Main POST Roblox calls
app.post("/api/scp294", async (req, res) => {
  try {
    await limiter.consume(req.ip);

    const query = String(req.body?.query ?? "").slice(0, 50).trim();
    if (!query) return res.status(400).json({ error: "Missing query" });

    // Optional moderation (non-fatal if it errors)
    try {
      const mod = await openai.moderations.create({
        model: "omni-moderation-latest",
        input: query
      });
      if (mod.results?.[0]?.flagged) {
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
    } catch (e) {
      console.warn("Moderation warning:", e?.message || e);
    }

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Request: ${query}` }
      ],
      response_format: { type: "json_schema", json_schema: { name: "Drink", schema: DrinkSchema, strict: true } }
    });

    const text = resp.output?.[0]?.content?.[0]?.text ?? "{}";
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!data || !data.effectId) {
      data = {
        displayName: query || "Generic Beverage",
        colorHex: "#A0C4FF",
        temperature: "ambient",
        container: "paper_cup",
        visual: { foam: false, bubbles: true, steam: false },
        tasteNotes: ["mild"],
        effectId: "NONE",
        message: "A nondescript drink dispenses with a soft hum."
      };
    }

    res.json(data);
  } catch (e) {
    console.error("SCP294 POST error:", e?.response?.data || e?.message || e);
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

// health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SCP-294 backend on :" + PORT));
