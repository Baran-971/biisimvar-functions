// supabase/functions/elaborate-bio/index.ts
// FEW-SHOT EXAMPLES + Daha Sıkı Kontrol + Yazım Düzeltme Sözlüğü

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const API_BASE = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
const API_KEY  = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL    = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant";

const bad = (detail: unknown, code = 400) =>
  new Response(JSON.stringify({ error: "bad_request", detail }), {
    status: code, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const BANNED_WORDS = [
  "amk","amina","amına","amını","orospu","piç","sic","sıç","sik","sikerim","sikeyim",
  "s.ktir","s.kerim","salak","aptal","gerizekali","gerizekalı","mal","oç",
  "yarrak","ibne","top","serefsiz","şerefsiz","kahpe",
];

function normalizeText(tr: string): string {
  return tr
    .toLocaleLowerCase("tr")
    .replaceAll(/ç/g,"c").replaceAll(/ğ/g,"g").replaceAll(/ı/g,"i")
    .replaceAll(/i̇/g,"i").replaceAll(/ö/g,"o").replaceAll(/ş/g,"s").replaceAll(/ü/g,"u");
}

const BANNED_SET = new Set(BANNED_WORDS.map(w => normalizeText(w)));

function sanitizeProfanity(text: string): { cleaned: string; replaced: string[] } {
  const replaced = new Set<string>();
  const cleaned = text.replace(/\p{L}+/gu, (word) => {
    const norm = normalizeText(word);
    if (BANNED_SET.has(norm)) {
      replaced.add(word);
      return "***";
    }
    return word;
  });
  return { cleaned, replaced: Array.from(replaced) };
}

function normalizeLettersOnly(s: string): string {
  return normalizeText(s).replace(/[^\p{L}]+/gu, "");
}

function sanitizeProfanityFuzzy(text: string): { cleaned: string; matched: string[] } {
  const shortBanneds = Array.from(BANNED_SET).filter(w => w.length >= 2 && w.length <= 6);
  if (shortBanneds.length === 0) return { cleaned: text, matched: [] };

  let cleaned = text;
  const matched: string[] = [];
  cleaned = cleaned.replace(/(\p{L})([^\p{L}]*)?(\p{L})([^\p{L}]*)?(\p{L})([^\p{L}]*)?(\p{L})?/gu, (m) => {
    const lettersOnly = normalizeLettersOnly(m);
    if (lettersOnly && shortBanneds.includes(lettersOnly)) {
      matched.push(m);
      return "***";
    }
    return m;
  });
  return { cleaned, matched };
}

function splitSentences(t: string): string[] {
  return t.split(/(?<=[\.\!\?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

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

function enforceSentenceCap(text: string, maxSentences: number): string {
  const parts = splitSentences(text);
  if (parts.length <= maxSentences) return text;
  return parts.slice(0, maxSentences).join(" ");
}

// ========== YAZIM DÜZELTMELERİ SÖZLÜĞÜ ==========
const SPELLING_FIXES: Record<string, string> = {
  "öğrendm": "öğrendim",
  "biliyom": "bilirim",
  "yapıyom": "yaparım",
  "geliyom": "gelirim",
  "çalışıyom": "çalışırım",
  "hamacun": "lahmacun",
  "hamurcun": "lahmacun",
  "hamurcuğun": "lahmacun",
  "lahmacun": "lahmacun",
  "restorant": "restoran",
  "restarant": "restoran",
  "resturant": "restoran",
  "ocakbaşı": "ocakbaşı",
  "ockbaşı": "ocakbaşı",
};

function preCorrectSpelling(text: string): string {
  let corrected = text;
  for (const [wrong, right] of Object.entries(SPELLING_FIXES)) {
    const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
    corrected = corrected.replace(regex, right);
  }
  return corrected;
}

function neutralizeSubjectivity(text: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/\bçok\s+iyi\s+biliyorum\b/gi, "iyi bilirim"],
    [/\biyi\s+biliyorum\b/gi, "bilirim"],
    [/\bher zaman\b/gi, ""],
    [/\bsağlarım\b/gi, "destek olurum"],
    [/\bçok\b/gi, ""],
    [/\başırı\b/gi, ""],
    [/\bmükemmel\b/gi, ""],
    [/\bsüper(dir)?\b/gi, ""],
    [/\blider(im)?\b/gi, ""],
    [/\buzman(ıyım)?\b/gi, ""],
    [/\bbenim için önemlidir\b/gi, "önemserim"],
    [/\bhiç sorun teşkil etmiyor\b/gi, "alışığımdır"],
    [/\biş arkadaşlarımla uyumlu bir şekilde çalışıyorum\b/gi, "ekip çalışmasına uyum sağlarım"],
    [/\s{2,}/g, " "],
  ];
  let out = text;
  for (const [re, rep] of patterns) out = out.replace(re, rep);
  return out.replace(/\s([;,.!?:])/g, "$1").trim();
}

function mergeRedundant(text: string): string {
  let out = text
    .replace(
      /\b(erken saatlerde çalışmaya alışığım\.?)\s+(sabah 6 vardiyası.*?(sorun|problem).*?\.)/i,
      "Erken vardiyalara uyum sağlarım."
    )
    .replace(
      /\b(mutfaktaki tüm işleyişi .*?bilirim\.)\s+(aşçıların .*?(ürün|tedarik).*?sağlarım\.)/i,
      "Mutfak işleyişine ve ürün tedarikine destek olurum."
    );
  return out;
}

function ensureRushMention(text: string): string {
  const hasRush = /(yoğun|kalabalık)\s+saat/iu.test(text) || /\brush\b/i.test(text);
  if (hasRush) return text;
  const sentences = splitSentences(text);
  sentences.push("Yoğun saatlerde çalışmaya alışığım.");
  return sentences.join(" ");
}

// ========== FEW-SHOT PROMPT İLE LLM ==========
async function callLLM(cleanedInput: string, targetMax: number, inputCount: number, rush: boolean): Promise<string> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY missing");

  const system = `Sen bir Türkçe metin düzeltme botusun. Görevi SADECE yazım ve gramer hatalarını düzeltmek, cümleleri akıcı hale getirmek.

MUTLAKA UYULMASI GEREKEN KURALLAR:
1. KELİMELERİN ANLAMINI DEĞİŞTİRME - kişi ne demişse onu koru
2. YENİ BİLGİ EKLEME - sadece düzelt
3. TERİMLERİ OLDUĞU GİBİ KULLAN - farklı yorumlama
4. Maksimum ${targetMax} cümle

İZİN VERİLEN:
✓ Yazım düzeltme: öğrendm → öğrendim
✓ Gramer: yapıyom → yaparım
✓ Cümle birleştirme: kısa parçaları akıcı cümleler yap
✓ Gereksiz tekrar/dolgu silme

YASAKLAR:
❌ Anlam değiştirme
❌ Yeni unvan/beceri ekleme
❌ Kelime yorumlama (örn: tavuk yapmak ≠ tavuk yetiştiriciliği)`;

  // FEW-SHOT EXAMPLES
  const fewShotExamples = [
    {
      role: "user",
      content: "tavuk yapmayı öğrendm. bizim köyde. sonra istanbula geldim. burada hamacun yapayı öğrendim 4 sene."
    },
    {
      role: "assistant",
      content: "Köyde tavuk pişirmeyi öğrendim. İstanbul'a geldikten sonra 4 yıl lahmacun yaptım."
    },
    {
      role: "user",
      content: "restorantta çalıştım 3 sene. garsonluk yaptm. şimdi aşçı yardımcısıyım."
    },
    {
      role: "assistant",
      content: "3 yıl restoranda garsonluk yaptım. Şimdi aşçı yardımcısıyım."
    },
    {
      role: "user",
      content: "kahvaltı hazırlamayı biliyom. yumurta omlet menemen hepsi. yoğun saatlerde de çalıştım."
    },
    {
      role: "assistant",
      content: "Kahvaltı hazırlarım; yumurta, omlet, menemen yaparım. Yoğun saatlerde çalışmaya alışığım."
    }
  ];

  const maxTokens = Math.min(90 + inputCount * 10, 200);

  const messages = [
    { role: "system", content: system },
    ...fewShotExamples,
    { 
      role: "user", 
      content: cleanedInput
    },
  ];

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.0,
      max_tokens: maxTokens,
      stop: ["\n\n","```","Biyografi","Not"],
      messages,
    }),
  });

  if (!res.ok) throw new Error(`Upstream ${res.status}: ${await res.text().catch(()=> "")}`);
  const data = await res.json();
  let text: string = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";

  text = text.trim().replace(/^[\s"'""„«»]+|[\s"'""„«»]+$/g, "");
  text = text.replace(/^(Düzeltilmiş|Çıktı|Sonuç):\s*/i, "");
  
  if (!text) throw new Error("Empty LLM response");
  return text;
}

// ========== HANDLER ==========
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return bad("Only POST is allowed", 405);
  if (!API_KEY)                 return bad("OPENAI_API_KEY is missing", 500);

  try {
    const body = await req.json().catch(() => ({}));
    const rawBioInput = (body?.rawBio ?? "").toString().trim();
    if (!rawBioInput) return bad("`rawBio` is required in JSON body");

    // 1) Profanity temizliği
    const inSan = sanitizeProfanity(rawBioInput);
    let cleanedInput = inSan.cleaned;
    const inFuzzy = sanitizeProfanityFuzzy(cleanedInput);
    cleanedInput = inFuzzy.cleaned;

    // 2) Önce yazım düzeltmeleri yap (LLM'e göndermeden)
    cleanedInput = preCorrectSpelling(cleanedInput);

    // Dinamik hedefler
    const inputHadRush = /(?:yoğun|kalabalık|pik|rush)/i.test(cleanedInput);
    const inputSentenceCount = countSentences(cleanedInput);
    const target = pickTargetRange(inputSentenceCount);

    // 3) LLM çağrısı (few-shot ile)
    let llmText = await callLLM(cleanedInput, target.max, inputSentenceCount, inputHadRush);

    // 4) Post-processing
    llmText = neutralizeSubjectivity(llmText);
    llmText = mergeRedundant(llmText);
    if (inputHadRush) llmText = ensureRushMention(llmText);

    // Sıkı tavan: 4 cümle
    llmText = enforceSentenceCap(llmText, 4);

    // 5) Çıkış profanity temizliği
    const outSan = sanitizeProfanity(llmText);
    let improvedBio = outSan.cleaned;
    const outFuzzy = sanitizeProfanityFuzzy(improvedBio);
    improvedBio = outFuzzy.cleaned;

    return ok({ improvedBio });
  } catch (err: unknown) {
    const detail =
      typeof err === "object" && err !== null && "message" in err
        ? (err.message as string)
        : String(err);
    return new Response(JSON.stringify({ error: "internal_error", detail }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
