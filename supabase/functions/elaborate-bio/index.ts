// supabase/functions/elaborate-bio/index.ts
// Minimal OpenAI-compatible endpoint (Groq destekli) + "yoğun saat" koruması + deterministik ayarlar

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Groq için base; OpenAI kullanacaksan OPENAI_BASE_URL'i boş bırakabilirsin
const BASE  = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.groq.com/openai/v1";
const KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";                // Groq: gsk_...
const MODEL = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant"; // instant varsayılan

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
  if (req.method !== "POST")    return bad("Only POST is allowed", 405);
  if (!KEY)                     return bad("OPENAI_API_KEY is missing (Edge Function Secrets)", 500);

  // Body al
  let rawBio = "";
  try {
    const body = await req.json();
    rawBio = (body?.rawBio ?? "").toString().trim();
  } catch { /* ignore */ }
  if (!rawBio) return bad("`rawBio` is required in JSON body");

  // Girdide "yoğun/kalabalık/pik/rush" var mı? Varsa çıktıda şart koşacağız
  const rush = /(?:yoğun|kalabalık|pik|rush)/i.test(rawBio);

  // Sistem yönergesi (sade ve gerçekçi)
  const systemPrompt: string[] = [
    "Türkçe yazan bir editörsün.",
    "Görev: Ham biyoyu YALIN ve GERÇEKÇİ bir üslupla en fazla 3 cümleye dönüştür.",
    "Tarz: Basit ve anlaşılır Türkçe kullan; karmaşık/edebi ifadelerden kaçın.",
    "KURALLAR:",
    "- SADECE verilen bilgilere dayan; yeni unvan/eğitim/başarı uydurma.",
    "- Abartı ve öznel övgü YOK (örn: severim, seviyorum, tutkuluyum, mükemmel, lider, uzman).",
    "- Başlık/emoji/kod bloğu/tırnak YOK.",
    "- Yazım hatalarını düzelt; terimleri doğru yaz (örn. 'restoranda', 'ocakbaşı').",
    "- 1. cümle: süre + rol + yer (örn. 'X yıl restoranda garsonluk yaptım').",
    "- 2. cümle: verilen beceri/alışkanlıkları NÖTR ifade et (örn. 'Yoğun saatlerde çalışmaya alışığım; müşterilerle iyi iletişim kurarım.').",
    "- ÇIKTI: yalnızca düz metin; 2–3 kısa cümle; toplam yaklaşık 25–40 kelime.",
  ];
  if (rush) {
    systemPrompt.push(
      "- Girişte 'yoğun/kalabalık/pik/rush' geçtiği için, çıktıda bu bilgi NET olarak yer almalı (örn. 'Yoğun saatlerde çalışmaya alışığım.')."
    );
  }

  // Few-shot örnek (yoğun saat bilgisini koruma eğitimi)
  const fewShot = [
    {
      role: "user",
      content:
        "Ham biyo:\n3 yıl restoranda garson oldum. yoğun saatlerde çalıştım; müşterilerle iyi anlaştım",
    },
    {
      role: "assistant",
      content:
        "3 yıl restoranda garsonluk yaptım. Yoğun saatlerde çalışmaya alışığım; müşterilerle iyi iletişim kurarım.",
    },
  ];

  // İstek payload'ı (deterministik ve kısa)
  const bodyPayload = {
    model: MODEL,
    temperature: 0.0,                 // mümkün olan en deterministik
    max_tokens: 90,                    // kısa ve net
    stop: ["\n\n", "```", "Biyografi"], // gereksiz blok/başlık kes
    messages: [
      { role: "system", content: systemPrompt.join("\n") },
      ...fewShot,
      {
        role: "user",
        content:
          `Ham biyo:\n${rawBio}\n\nYukarıdaki kurallara TAM uy ve yalnızca düz metin döndür.`,
      },
    ],
  };

  // LLM çağrısı
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload),
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
