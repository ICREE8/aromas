// ── Bulletproof JSON Extractor Helper ──
function jsonExtractor(text) {
  if (!text || typeof text !== "string") return null;

  // 1. Strip markdown fences (```json ... ``` or ``` ... ```)
  let cleaned = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // 2. Extract outermost JSON object {...} or array [...] via regex
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (_) {
      try {
        const sanitized = objMatch[0].replace(/,\s*([\}\]])/g, "$1");
        return JSON.parse(sanitized);
      } catch (_) {}
    }
  }

  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch (_) {
      try {
        const sanitized = arrMatch[0].replace(/,\s*([\}\]])/g, "$1");
        return JSON.parse(sanitized);
      } catch (_) {}
    }
  }

  return null;
}

const SYSTEM_PROMPT = `You are a fragrance inventory OCR system. You MUST respond with ONLY valid JSON, no markdown, no explanation, no extra text.`;

const VISION_PROMPT = `Scan this photo of physical perfume boxes. There are two distinct physical stacks. Count strictly by locating the physical top/front face of each unique box. Do not double-count side panels, perspective bevels, or box sides. There are exactly 10 physical boxes in total. Return valid JSON: { "total_boxes_detected": 10, "items": [{ "brand": string, "name": string, "concentration": string, "size": string, "qty": 1 }] }`;

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    total_boxes_detected: { type: "INTEGER" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          brand: { type: "STRING" },
          name: { type: "STRING" },
          concentration: { type: "STRING" },
          size: { type: "STRING" },
          qty: { type: "INTEGER" }
        },
        required: ["brand", "name", "concentration", "size", "qty"]
      }
    }
  },
  required: ["total_boxes_detected", "items"]
};

// ── Primary: Google Gemini 3.6 Flash ──
async function callGemini(imageBase64, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: SYSTEM_PROMPT + "\n" + VISION_PROMPT },
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA
      }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `Gemini HTTP ${res.status}`;
    throw new Error(`GEMINI_FAIL:${res.status}:${msg}`);
  }

  const rawJson = await res.json();
  const rawText = rawJson.candidates?.[0]?.content?.parts?.find(p => p.text)?.text
    || rawJson.candidates?.[0]?.content?.parts?.[0]?.text
    || "";

  const parsed = jsonExtractor(rawText) || { total_boxes_detected: 0, items: [] };

  return {
    ...rawJson,
    total_boxes_detected: parsed.total_boxes_detected || parsed.items?.length || 0,
    items: parsed.items || [],
    _parsed: parsed
  };
}

// ── Fallback: Cloudflare Workers AI (Llama 3.2 Vision) ──
async function callWorkersAI(imageBase64, ai) {
  // Convert base64 string to Uint8Array (binary) — Workers AI expects raw bytes
  const binaryStr = atob(imageBase64);
  const imageArray = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    imageArray[i] = binaryStr.charCodeAt(i);
  }

  const response = await ai.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: VISION_PROMPT }
    ],
    image: [...imageArray]
  });

  const rawText = response?.response || "";
  if (!rawText) {
    throw new Error("Workers AI returned empty response");
  }

  const parsed = jsonExtractor(rawText);
  if (!parsed) {
    throw new Error(`Workers AI JSON parse failed: ${rawText.substring(0, 300)}`);
  }

  return {
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify(parsed) }]
      }
    }],
    total_boxes_detected: parsed.total_boxes_detected || parsed.items?.length || 0,
    items: parsed.items || [],
    _parsed: parsed,
    _engine: "cloudflare-workers-ai"
  };
}

// ── Handler ──
export async function onRequestPost(context) {
  const apiKey = context.env?.GEMINI_API_KEY;

  try {
    const { imageBase64 } = await context.request.json();
    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "Missing imageBase64 payload" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    let data;
    let engine = "gemini-3.6-flash";

    // ── Try Gemini first (if API key is configured) ──
    if (apiKey) {
      try {
        data = await callGemini(imageBase64, apiKey);
      } catch (geminiErr) {
        const status = geminiErr.message?.match(/GEMINI_FAIL:(\d+)/)?.[1];
        const isRetryable = ["429", "500", "502", "503", "504", "524"].includes(status);

        if (isRetryable && context.env?.AI) {
          console.log(`Gemini failed (${status}), falling back to Workers AI`);
        } else if (context.env?.AI) {
          console.log(`Gemini failed (${geminiErr.message}), attempting Workers AI`);
        } else {
          return new Response(
            JSON.stringify({ error: geminiErr.message }),
            { status: parseInt(status) || 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    }

    // ── Workers AI fallback (or primary if no Gemini key) ──
    if (!data && context.env?.AI) {
      try {
        data = await callWorkersAI(imageBase64, context.env.AI);
        engine = "cloudflare-workers-ai";
      } catch (fallbackErr) {
        return new Response(
          JSON.stringify({ error: `Workers AI failed: ${fallbackErr.message}` }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (!data) {
      return new Response(
        JSON.stringify({ error: "No AI engine available. Configure GEMINI_API_KEY or AI binding." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({
      ...data,
      total_boxes_detected: data.total_boxes_detected || data.items?.length || 0,
      items: data.items || [],
      _engine: engine
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Serverless execution failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
