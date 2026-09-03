exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "GEMINI_API_KEY environment variable is not configured in Netlify Site Settings."
      })
    };
  }

  try {
    const { imageBase64 } = JSON.parse(event.body || "{}");
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing imageBase64 payload" }) };
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

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const apiRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const data = await apiRes.json();
    if (!apiRes.ok) {
      return {
        statusCode: apiRes.status,
        body: JSON.stringify({ error: data?.error?.message || "Google Vision API error" })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Serverless execution failed" })
    };
  }
};
