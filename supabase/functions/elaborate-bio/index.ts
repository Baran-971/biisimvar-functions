// supabase/functions/elaborate-bio/index.ts
// Profanity-temizlemeli + dinamik cümle hedefli + OpenAI-compatible (Groq) Edge Function

// ---------- CORS ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- ENV ----------
const API_BASE = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1"; 
const API_KEY  = Deno.env.get("OPENAI_API_KEY") ?? ""; 
const MODEL    = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant";

const bad = (detail: unknown, code = 400) =>
  new Response(JSON.stringify({ error: "bad_request", detail }), {
    status: code, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
  });

// ---------- Küfür listesi (genişletilebilir) ----------
const BANNED_WORDS = [
  "amk","amina","amına","amını","orospu","piç","sic","sıç","sik","sikerim","sikeyim",
  "s.ktir","s.kerim","salak","aptal","gerizekali","gerizekalı","mal","oç",
  "yarrak","ibne","top","serefsiz","şerefsiz","kahpe",
];

// TR normalizasyonu
function normalizeText(tr: string): string {
  return tr
    .toLocaleLowerCase("tr")
    .replaceAll(/ç/g,"c").replaceAll(/ğ/g,"g").replaceAll(/ı/g,"i")
    .replaceAll(/i̇/g,"i").replaceAll(/ö/g,"o").replaceAll(/ş/g,"s").replaceAll(/ü/g,"u");
}
const bannedSet = new Set(BANNED_WORDS.map(w => normalizeText(w)));

// Küfürleri *** ile maskeler (noktalama ve boşluklar korunur)
function sanitizeProfanity(text: string): { cleaned: string; replaced: string[] } {
  const replaced = new Set<string>();
  // Unicode Karakter Sınıfı \p{L} ile tüm dillerdeki harfleri yakalama
  const cleaned = text.replace(/\p{L}+/gu, (word) => { 
    const norm = normalizeText(word);
    if (bannedSet.has(norm)) {
      replaced.add(word);
      return "***";
    }
    return word;
  });
  return { cleaned, replaced: Array.from(replaced) };
}

// ---------- Yardımcılar: cümle sayımı ve hedef aralık ----------
function countSentences(t: string): number {
  const parts = t.split(/[\.\!\?\;\n]+/).map(s => s.trim()).filter(Boolean);
  return parts.length || 1;
}
function pickTargetRange(n: number): { min: number; max: number } {
  if (n <= 3) return { min: 2, max: 3 };
  if (n <= 5) return { min: 3, max: 4 };
  if (n <= 8) return { min: 4, max: 6 };
  return { min: 5, max: 8 };
}

// ---------- LLM çağrısı ----------
async function callLLM(cleanedInput: string): Promise<string> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY missing");

  const inputSentenceCount = countSentences(cleanedInput);
  const target = pickTargetRange(inputSentenceCount);
  const rush = /(?:yoğun|kalabalık|pik|rush)/i.test(cleanedInput);

  const systemLines: string[] = [
    "Türkçe yazan bir editörsün.",
    "Girdi hangi dilde olursa olsun, çıktı dili daima Türkçe olacak.",
    "Görev: Ham biyoyu YALIN ve GERÇEKÇİ bir üslupla toparla; bilgileri koru.",
    `Girdi yaklaşık ${inputSentenceCount} cümle; çıktıda ${target.min}-${target.max} cümleyi hedefle.`,
    "KURALLAR:",
    "- SADECE verilen bilgilere dayan; yeni unvan/eğitim/başarı uydurma.",
    "- Abartı ve öznel övgü yok (örn: severim, seviyorum, tutkuluyum, mükemmel, lider, uzman).",
    "- Başlık/emoji/kod bloğu/tırnak yok.",
    "- Yazım hatalarını düzelt; terimleri doğru yaz (örn. 'restoranda', 'ocakbaşı').",
    "- Bilgi kaybı olmasın; sadece tekrarları ve dolgu sözcükleri temizle.",
    "- Cümleleri kısa tut; akıcı bir paragraf halinde döndür.",
  ];
  if (rush) {
    systemLines.push(
      "- Girişte 'yoğun/kalabalık/pik/rush' bilgisi var; çıktı bunu net şekilde içermeli (örn. 'Yoğun saatlerde çalışmaya alışığım.')."
    );
  }
  const system = systemLines.join("\n");

  const maxTokens = Math.min(90 + inputSentenceCount * 10, 220);

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.0,
      max_tokens: maxTokens,
      stop: ["\n\n","```","Biyografi"],
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Ham biyo:\n${cleanedInput}\n\nLütfen yalnızca düz metin döndür.` },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Upstream ${res.status}: ${await res.text().catch(()=> "")}`);
  const data = await res.json();
  let text: string = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  
  // GÜNCELLEME: Çıktıdaki tüm dış tırnak ve boşlukları temizle
  text = text.trim().replace(/^[\s"'“”„«»]+|[\s"'“”„«»]+$/g, "");
  
  if (!text) throw new Error("Empty LLM response");
  return text;
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return bad("Only POST is allowed", 405);

  try {
    const body = await req.json().catch(() => ({}));
    const rawBioInput = (body?.rawBio ?? "").toString().trim();
    if (!rawBioInput) return bad("`rawBio` is required in JSON body");

    // 1) Girdi küfür temizliği
    const inSan = sanitizeProfanity(rawBioInput);
    const cleanedInput = inSan.cleaned;

    // 2) LLM (temizlenmiş girişle)
    const llmText = await callLLM(cleanedInput);

    // 3) Çıkış küfür temizliği (garanti)
    const outSan = sanitizeProfanity(llmText);
    const improvedBio = outSan.cleaned;

    return ok({ improvedBio });
  } catch (err: unknown) {
    // Hata yakalama bloğu daha sağlam hale getirildi
    const detail =
      typeof err === "object" && err !== null && "message" in err
        // @ts-ignore
        ? (err.message as string)
        : String(err);
    return new Response(JSON.stringify({ error: "internal_error", detail }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
