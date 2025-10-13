// supabase/functions/elaborate-bio/index.ts
// Küfür temizlikli, deterministik, OpenAI-compatible (Groq) Edge Function

// ---------- CORS ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- ENV ----------
const API_BASE = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
const API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL   = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant";

const bad = (detail: unknown, code = 400) =>
  new Response(JSON.stringify({ error: "bad_request", detail }), {
    status: code, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
  });

// ---------- Küfür listesi (örnek; genişletebilirsin) ----------
const BANNED_WORDS = [
  "amk","amına","amını","amina","orospu","piç","sıç","sik","sikerim","sikeyim",
  "s.ktir","s.kerim","salak","aptal","gerizekalı","gerizekali","mal","oç",
  "yarrak","ibne","top","şerefsiz","serefsiz","kahpe",
];

// TR normalizasyonu
function normalize(tr: string): string {
  return tr
    .toLocaleLowerCase("tr")
    .replaceAll(/ç/g,"c").replaceAll(/ğ/g,"g").replaceAll(/ı/g,"i")
    .replaceAll(/i̇/g,"i").replaceAll(/ö/g,"o").replaceAll(/ş/g,"s").replaceAll(/ü/g,"u");
}
const bannedSet = new Set(BANNED_WORDS.map(w => normalize(w)));

// Metindeki yalnızca harf gruplarını yakalayıp küfürleri *** ile maskeler.
// Punct/boşlukları aynen korur; “amk.”, “AMK!”, “aMk,” vs. hepsi maskelenir.
function sanitizeProfanity(text: string): { cleaned: string; replaced: string[] } {
  const replaced = new Set<string>();
  const cleaned = text.replace(/\p{L}+/gu, (word) => {
    const norm = normalize(word);
    if (bannedSet.has(norm)) {
      replaced.add(word);
      return "***";
    }
    return word;
  });
  return { cleaned, replaced: Array.from(replaced) };
}

// ---------- LLM çağrısı ----------
async function callLLM(rawBio: string): Promise<string> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY missing");

  const system = [
    "Türkçe yazan bir editörsün.",
    "Girdi hangi dilde olursa olsun, çıktı dili daima Türkçe olacak.",
    "Sade ve anlaşılır yaz.",
    "Görev: Ham biyoyu YALIN ve GERÇEKÇİ en fazla 3 cümleye dönüştür.",
    "KURALLAR:",
    "- SADECE verilen bilgilere dayan; yeni unvan/eğitim/başarı uydurma.",
    "- Abartı ve öznel övgü YOK (örn: severim, seviyorum, tutkuluyum, mükemmel, lider, uzman).",
    "- Başlık/emoji/kod bloğu/tırnak YOK.",
    "- Yazım hatalarını düzelt; terimleri doğru yaz (örn. 'restoranda', 'ocakbaşı').",
    "- 1. cümle: süre + rol + yer (örn. 'X yıl restoranda garsonluk yaptım').",
    "- 2. cümle: verilen beceri/alışkanlıkları NÖTR ifade et (örn. 'Yoğun saatlerde çalışmaya alışığım; müşterilerle düzgün iletişim kurarım.').",
    "- ÇIKTI: yalnızca düz metin; 2–3 kısa cümle; toplam ≈25–40 kelime.",
  ].join("\n");

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.0,     // deterministik
      max_tokens: 120,      // hafif
      stop: ["\n\n","```","Biyografi"],
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Ham biyo:\n${rawBio}\n\nYalnızca düz metin döndür.` },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Upstream ${res.status}: ${await res.text().catch(()=> "")}`);
  const data = await res.json();
  let text: string = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  text = text.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("“") && text.endsWith("”"))) {
    text = text.slice(1, -1).trim();
  }
  if (!text) throw new Error("Empty LLM response");
  return text;
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return bad("Only POST is allowed", 405);

  try {
    const body = await req.json().catch(() => ({}));
    const rawBioInput = (body?.rawBio ?? "").toString().trim();
    if (!rawBioInput) return bad("`rawBio` is required in JSON body");

    // 1) Girdi küfür temizliği
    const inSan = sanitizeProfanity(rawBioInput);
    const cleanedInput = inSan.cleaned;

    // 2) LLM (temizlenmiş girişle)
    const llmText = await callLLM(cleanedInput);

    // 3) Çıkış küfür temizliği (olasılık düşük ama garanti için)
    const outSan = sanitizeProfanity(llmText);
    const improvedBio = outSan.cleaned;

    return ok({ improvedBio });
  } catch (err: unknown) {
    const detail = typeof err === "object" && err && "message" in err
      // @ts-ignore
      ? err.message as string
      : String(err);
    return new Response(JSON.stringify({ error: "internal_error", detail }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
