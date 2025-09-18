// ---- replace your DrinkSchema + SYSTEM_PROMPT with this ----
const SYSTEM_PROMPT = `You are SCP-294's describer. Choose a SAFE in-game effect from this enum:
["NONE","WARMTH","COOLING","SPEED_SMALL","JUMP_SMALL","GLOW","SHRINK_VFX","GROW_VFX","BURP","EXPLODE"].
Return color/visuals and ONE effect with optional params. Never invent new effectIds.
EXPLODE must be slapstick (no gore); only affect the requesting player. Keep output PG-13.`;

// JSON schema (now includes effectParams with strict keys + ranges)
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
        // generic
        duration: { type: "number", minimum: 0.5, maximum: 15 },

        // SPEED/JUMP
        speedMultiplier: { type: "number", minimum: 0.5, maximum: 2.0 },
        jumpBoost: { type: "number", minimum: 0, maximum: 50 },

        // GLOW
        glowBrightness: { type: "number", minimum: 0, maximum: 10 },

        // EXPLODE (bomb)
        power: { type: "number", minimum: 0, maximum: 1 },   // how strong to make VFX + sound
        radius: { type: "number", minimum: 0, maximum: 12 }  // purely cosmetic in our impl
      }
    },

    message: { type: "string", maxLength: 120 }
  },
  required: ["displayName","colorHex","temperature","container","visual","tasteNotes","effectId","message"]
};
