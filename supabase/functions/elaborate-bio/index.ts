// supabase/functions/elaborate-bio/index.ts
// OpenAI-compatible minimal endpoint (Groq/Instant destekli) + sıkı doğruluk kuralları

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE  = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.groq.com/openai/v1";
const KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";                 // Groq: gsk_...
const MODEL = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant";  // instant varsayılan

const bad = (detail: string, code = 400) =>
  new Response(JSON.stringify({ error: detail }), { status: code, headers: { "Content-Type": "application/json", ...CORS } });
const ok = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json", ...CORS } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")   return bad("Only POST is allowed", 405);
  if (!KEY)                    return bad("OPENAI_API_KEY is missing (Edge Function Secrets)", 500);

  let rawBio = "";
  try {
    const body = await req.json();
    rawBio = (body?.rawBio ?? "").toString().trim();
  } catch {}
  if (!rawBio) return bad("`rawBio` is required in JSON body");

  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,           // minimum yaratıcılık
        max_tokens: 120,            // kısa
        stop: ["\n\n", "\"\"\"", "Biyografi", "```"], // gereksiz blokları kes
        messages: [
          {
            role: "system",
            content: [
              "Türkçe yazan bir editörsün.",
              "Görev: Kullanıcının ham biyosunu yalın ve GERÇEKÇİ bir üslupla 2 cümleye dönüştür.",
              "ZORUNLU DOĞRULUK KURALLARI:",
              "- SADECE verilen bilgilere dayan; yeni unvan/eğitim/başarı UYDURMA.",
              "- Metindeki TÜM ayrı gerçekleri koru: süreler (yıl/ay), rol(ler), iş türü (kafe/restoran vb.), beceriler.",
              "- Eğer girişte 'yoğun', 'kalabalık', 'pik', 'rush' gibi ifadeler geçiyorsa, 'yoğun saatlerde çalışmaya alışığım' benzeri net bir ifade içermek ZORUNLU.",
              "- Abartılı sıfatlar (uzman, lider, üst düzey, mükemmel vb.) KULLANMA.",
              "- Başlık/emoji/kod bloğu/tırnak ekleme.",
              "- Yazım hatalarını düzelt; terimleri doğru yaz (örn. 'restoranda', 'ocakbaşı').",
              "- Çıktı: yalnızca düz metin; 2 cümle; toplam ~25–40 kelime."
            ].join("\n")
          },

          // Few-shot örnek (modeli 'yoğun saatler' bilgisini taşıması için koşullandırır)
          {
            role: "user",
            content: "Ham biyo:\n3 yıl restoranda garson oldum. sonra 2 sene ustam ocakbaşında çalıştım; yoğun saatlerde çalıştım"
          },
          {
            role: "assistant",
            content: "3 yıl restoranda garsonluk yaptım; son 2 yıldır ocakbaşında çalışıyorum. Yoğun saatlerde çalışmaya alışığım ve ekip içinde düzenli çalışırım."
          },

          // Gerçek istek
          {
            role: "user",
            content: `Ham biyo:\n${rawBio}\n\nYukarıdaki kurallara sıkı şekilde uy ve sadece iki cümle döndür.`
          }
        ]
      })
    });

    if (!r.ok) return bad(`Upstream error ${r.status}: ${await r.text()}`, 500);

    const data = await r.json();
    let text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
    if (!text) return bad("Empty response from LLM", 500);

    // uç tırnak/boşluk/akıllı tırnak temizliği
    text = text.trim().replace(/^[\s"'“”„«»]+|[\s"'“”„«»]+$/g, "");
    return ok({ improvedBio: text });
  } catch (e) {
    return bad(`Runtime error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});
