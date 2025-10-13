// supabase/functions/elaborate-bio/index.ts
// Minimal, OpenAI-compatible (OpenAI / Groq / OpenRouter / DeepSeek)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE  = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1"; // Groq: https://api.groq.com/openai/v1
const KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("LLM_MODEL") ?? "gpt-4o-mini";

const bad = (detail: string, code = 400) =>
  new Response(JSON.stringify({ error: detail }), {
    status: code,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const ok = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return bad("Only POST is allowed", 405);
  if (!KEY) return bad("OPENAI_API_KEY is missing (set in Edge Function Secrets)", 500);

  // body al
  let rawBio = "";
  try {
    const body = await req.json();
    rawBio = (body?.rawBio ?? "").toString().trim();
  } catch { /* ignore */ }
  if (!rawBio) return bad("`rawBio` is required in JSON body");

  // çağrı
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,             // daha az abartı/yaratıcılık
        max_tokens: 140,              // kısa tut
        messages: [
          {
            role: "system",
            content:
              [
                "Sen Türkçe yazan bir editörsün.",
                "Görev: Kullanıcının ham biyosunu yalın ve gerçekçi bir üslupla 2–3 KISA cümleye dönüştür.",
                "KURALLAR:",
                "- SADECE verilen bilgilere dayan. Yeni unvan, eğitim, uzmanlık, başarı ekleme.",
                "- Abartılı sıfatlar kullanma (uzman, üst düzey, liderlik, mükemmel vb.).",
                "- 'Biyografi:', başlık, emoji, liste, tırnak işareti KULLANMA.",
                "- Yazım hatalarını düzelt, terimleri doğru yaz (örn. 'restoranda', 'ocakbaşı').",
                "- Sayıları çarpıtma; verildiyse süreleri doğru ifade et.",
                "- Çıktı sadece metin olsun."
              ].join("\n"),
          },
          {
            role: "user",
            content:
              `Ham biyo:\n${rawBio}\n\nLütfen yalnızca abartısız, doğal ve kısa bir metin döndür.`,
          },
        ],
      }),
    });

    if (!r.ok) return bad(`Upstream error ${r.status}: ${await r.text()}`, 500);

    const data = await r.json();
    let text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
    if (!text) return bad("Empty response from LLM", 500);

    // Uçtaki tırnak/boşluk/akıllı tırnakları temizle
    text = text.trim().replace(/^[\s"'“”„«»]+|[\s"'“”„«»]+$/g, "");

    return ok({ improvedBio: text });
  } catch (e) {
    return bad(`Runtime error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});
