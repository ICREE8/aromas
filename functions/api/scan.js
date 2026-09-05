export async function onRequestPost(context) {
  const apiKey = context.env?.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "GEMINI_API_KEY environment variable is not configured in Cloudflare Pages."
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  try {
    const { imageBase64 } = await context.request.json();
    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "Missing imageBase64 payload" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const systemPrompt = `You are a forensic luxury fragrance inventory specialist and OCR cataloguer.
Your job is to inspect dense photographs of perfume boxes, bottles, and wholesale deliveries.
CRITICAL SEGMENTATION RULES:
1. Systematically scan row-by-row, from top-left to bottom-right across the ENTIRE frame.
2. Identify EVERY distinct bottle or box visible, even if partially occluded or in the background.
3. Actively search for and extract the stamped/embossed BATCH CODE or etching on each unit. If occluded, set batchCode to null.
4. If multiple identical bottles of the same fragrance and size are sitting together, increment "qty".
5. DO NOT estimate, predict, or guess retail prices or MSRP. Leave price fields completely out or null.
6. Accurately identify concentration: EDP, EDT, Parfum, Extrait, or Cologne.
Output a valid JSON object strictly adhering to the schema.`;

    const responseSchema = {
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

    const requestBody = {
      contents: [
        {
          parts: [
            { text: systemPrompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: imageBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema
      }
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const apiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const data = await apiRes.json();
    if (!apiRes.ok) {
      return new Response(
        JSON.stringify({ error: data?.error?.message || "Google Vision API error" }),
        {
          status: apiRes.status,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Serverless execution failed" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
