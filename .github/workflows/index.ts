const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROVIDER = Deno.env.get("LLM_PROVIDER")?.toLowerCase();
const MODEL = Deno.env.get("LLM_MODEL") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");

function badRequest(detail: string, code = 400) {
  return new Response(JSON.stringify({ error: "bad_request", detail }), {
    status: code, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function callOpenAI(rawBio: string): Promise<string> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");
  if (!MODEL) throw new Error("LLM_MODEL missing for OpenAI");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0.7, max_tokens: 180,
      messages: [
        { role: "system", content: "Hizmet sektöründe iş arayanlar için profesyonel biyo yazan editörsün. Ham metni 4-5 cümlelik, pozitif ve hizmet odaklı bir biyoya dönüştür." },
        { role: "user", content: `Ham biyo: "${rawBio}"\n\nLütfen sadece son metni döndür.` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
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
      contents: [{
        role: "user",
        parts: [
          { text: "Hizmet sektöründe iş arayanlar için profesyonel biyo yazan editörsün." },
          { text: `Ham biyo: "${rawBio}"\n\nLütfen sadece son metni döndür.` },
        ],
      }],
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return badRequest("Only POST is allowed", 405);

  try {
    const body = await req.json().catch(() => ({}));
    const rawBio = (body?.rawBio ?? "").toString().trim();
    if (!rawBio) return badRequest("`rawBio` is required in JSON body");
    if (!PROVIDER) return badRequest("LLM_PROVIDER is missing (openai|gemini)");

    const improved = PROVIDER === "openai"
      ? await callOpenAI(rawBio)
      : PROVIDER === "gemini"
      ? await callGemini(rawBio)
      : (() => { throw new Error("Unsupported LLM_PROVIDER"); })();

    return ok({ improvedBio: improved });
  } catch (err: unknown) {
    console.error("elaborate-bio error:", err);
    // Güçlü hata çıktısı
    let detail = "unknown";
    try {
      // @ts-ignore
      if (err?.response) {
        // @ts-ignore
        detail = await err.response.text?.() ?? JSON.stringify(await err.response.json?.());
      } else {
        // @ts-ignore
        detail = err?.message ?? String(err);
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: "Biyo geliştirilemedi", detail }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
