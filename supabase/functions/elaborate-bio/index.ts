// supabase/functions/elaborate-bio/index.ts

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROVIDER = Deno.env.get("LLM_PROVIDER")?.toLowerCase();
const MODEL = Deno.env.get("LLM_MODEL") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
// OpenAI-compatible base URL (OpenAI, Groq, OpenRouter, DeepSeek, ...)
const OPENAI_BASE = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

function badRequest(detail: string, code = 400) {
  return new Response(JSON.stringify({ error: "bad_request", detail }), {
    status: code,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function callOpenAI(rawBio: string): Promise<string> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");
  if (!MODEL) throw new Error("LLM_MODEL missing for OpenAI");

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "Sen, hizmet sektörü iş arayanları için profesyonel biyografiler yazan deneyimli bir editörsün. Kullanıcının ham metnini pozitif, akıcı ve hizmet odaklı 4-5 cümlelik profesyonel bir biyografiye dönüştür.",
        },
        {
          role: "user",
          content: `Ham biyo: "${rawBio}"\n\nLütfen yalnızca son metni döndür.`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";
  if (!text) throw new Error("OpenAI empty response");
  return text.trim();
}

async function callGemini(rawBio: string): Promise<string> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY missing");
  if (!MODEL) throw new Error("LLM_MODEL missing for Gemini");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Sen, hizmet sektörü iş arayanları için profesyonel biyografiler yazan deneyimli bir editörsün. Kullanıcının ham metnini 4-5 cümlelik, pozitif ve hizmet odaklı bir biyografiye dönüştür.",
            },
            { text: `Ham biyo: "${rawBio}"\n\nLütfen yalnızca son metni döndür.` },
          ],
        },
      ],
      generationConfig: { temperature: 0.7, maxOutputTokens: 180 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error("Gemini empty response");
  return text.trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return badRequest("Only POST is allowed", 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const rawBio = (body?.rawBio ?? "").toString().trim();
    if (!rawBio) return badRequest("`rawBio` is required in JSON body");
    if (!PROVIDER) return badRequest("LLM_PROVIDER is missing (openai|gemini)");

    let improved = "";
    if (PROVIDER === "openai") {
      improved = await callOpenAI(rawBio);
    } else if (PROVIDER === "gemini") {
      improved = await callGemini(rawBio);
    } else {
      return badRequest("Unsupported LLM_PROVIDER (use openai or gemini)");
    }

    return ok({ improvedBio: improved });
  } catch (err: unknown) {
    console.error("elaborate-bio error:", err);
    let detail = "unknown";
    try {
      // @ts-ignore
      detail = err?.message ?? String(err);
      // @ts-ignore
      if (err?.response) {
        try {
          // @ts-ignore
          const txt = await err.response.text?.();
          if (txt) detail = txt;
        } catch {
          // @ts-ignore
          const js = await err.response.json?.();
          if (js) detail = JSON.stringify(js);
        }
      }
    } catch {
      // ignore
    }
    return new Response(JSON.stringify({ error: "Biyo geliştirilemedi", detail }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
