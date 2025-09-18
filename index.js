import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { DrinkSchema } from "./schema.js";

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(cors({ origin: (origin, cb) => cb(null, true) })); // lock down later via env

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// simple per-IP limiter: 20 requests / 2 minutes
const limiter = new RateLimiterMemory({ points: 20, duration: 120 });

const SYSTEM_PROMPT = `
You are SCP-294's describer. Given a requested drink name, return ONLY harmless cosmetics and a SAFE effectId from this enum:
["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP"].
Never invent new effectIds. Avoid real alcohol/drugs/poisons; if requested, map to "NONE" and include a safety-themed, in-universe message.
Use plausible colors and containers; no trademarks. Keep output PG-13.
`;

app.post("/api/scp294", async (req, res) => {
  try {
    await limiter.consume(req.ip);

    const query = String(req.body?.query ?? "").slice(0, 50).trim();
    if (!query) return res.status(400).json({ error: "Missing query" });

    // 1) Moderate the INPUT (free, recommended). If flagged, refuse. 
    // Docs: Moderation endpoint and model: omni-moderation-latest
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

    // 2) Ask for structured output
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Request: ${query}` }
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "Drink", schema: DrinkSchema, strict: true }
      }
    });

    // The SDK may expose a parsed field in future; use text content now:
    const content = resp.output?.[0]?.content?.[0]?.text ?? "{}";
    let data;
    try { data = JSON.parse(content); } catch { data = null; }

    // Hard failover if parsing hiccups
    if (!data || !data.effectId) {
      data = {
        displayName: "Generic Beverage",
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
    // Rate limit or server error → safe fallback
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

app.get("/healthz", (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 3000, () =>
  console.log("SCP-294 backend listening on", process.env.PORT || 3000)
);
