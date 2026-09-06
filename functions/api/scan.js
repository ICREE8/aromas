const SYSTEM_PROMPT = `You are a forensic luxury fragrance inventory specialist and OCR cataloguer.
Your job is to inspect dense photographs of perfume boxes, bottles, and wholesale deliveries.
CRITICAL SEGMENTATION RULES:
1. Systematically scan row-by-row, from top-left to bottom-right across the ENTIRE frame.
2. Identify EVERY distinct bottle or box visible, even if partially occluded or in the background.
3. Actively search for and extract the stamped/embossed BATCH CODE or etching on each unit. If occluded, set batchCode to null.
4. If multiple identical bottles of the same fragrance and size are sitting together, increment "qty".
5. DO NOT estimate, predict, or guess retail prices or MSRP. Leave price fields completely out or null.
6. Accurately identify concentration: EDP, EDT, Parfum, Extrait, or Cologne.
Output a valid JSON object with keys: "total_boxes_detected" (integer) and "items" (array of objects with: name, brand, concentration, size, qty, batchCode, condition).`;

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    total_boxes_detected: { type: "INTEGER" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          batchCode: { type: "STRING" },
          name: { type: "STRING" },
          brand: { type: "STRING" },
          concentration: { type: "STRING" },
          size: { type: "STRING" },
          condition: { type: "STRING" },
          qty: { type: "INTEGER" }
        },
        required: ["name", "brand", "concentration", "size", "qty"]
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
          { text: SYSTEM_PROMPT },
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
  return await res.json();
}

// ── Fallback: Cloudflare Workers AI (Llama 3.2 Vision) ──
async function callWorkersAI(imageBase64, ai) {
  const dataUri = `data:image/jpeg;base64,${imageBase64}`;
  const response = await ai.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Analyze this fragrance inventory photo. Return ONLY a valid JSON object with total_boxes_detected and items array." }
    ],
    image: dataUri
  });

  // Workers AI returns { response: "..." } — parse the JSON from the text
  const rawText = response?.response || "";
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Workers AI returned no parseable JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Normalize into Gemini-compatible envelope so client code stays unchanged
  return {
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify(parsed) }]
      }
    }],
    _engine: "cloudflare-workers-ai"
  };
}

// ── Handler ──
export async function onRequestPost(context) {
  const apiKey = context.env?.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY not configured in Cloudflare Pages." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

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

    // ── Try Gemini first ──
    try {
      data = await callGemini(imageBase64, apiKey);
    } catch (geminiErr) {
      const status = geminiErr.message?.match(/GEMINI_FAIL:(\d+)/)?.[1];
      const isRetryable = ["429", "500", "502", "503", "504", "524"].includes(status);

      // ── Failover to Workers AI if Gemini is throttled/down ──
      if (isRetryable && context.env?.AI) {
        try {
          data = await callWorkersAI(imageBase64, context.env.AI);
          engine = "cloudflare-workers-ai";
        } catch (fallbackErr) {
          // Both engines failed — return Gemini's original error
          return new Response(
            JSON.stringify({
              error: `Primary (Gemini): ${geminiErr.message}. Fallback (Workers AI): ${fallbackErr.message}`
            }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }
      } else {
        // Non-retryable Gemini error or no AI binding
        return new Response(
          JSON.stringify({ error: geminiErr.message }),
          { status: parseInt(status) || 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(JSON.stringify({ ...data, _engine: engine }), {
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
