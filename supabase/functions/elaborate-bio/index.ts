// supabase/functions/elaborate-bio/index.ts
// Dinamik hedef + sıkı cümle tavanı + öznel/abartı nötrleştirme + tekrar birleştirme +
// rush garantisi + girdi/çıktı profanity temizliği + deterministik LLM (Groq/OpenAI-compatible)

// ---------- CORS ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- ENV ----------
const API_BASE = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1"; // Groq: https://api.groq.com/openai/v1
const API_KEY  = Deno.env.get("OPENAI_API_KEY") ?? ""; // gsk_...
const MODEL    = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant";

const bad = (detail: unknown, code = 400) =>
  new Response(JSON.stringify({ error: "bad_request", detail }), {
    status: code, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
  });

// ---------- Profanity listesi (genişletilebilir) ----------
const BANNED_WORDS = [
  "amk","amina","amına","amını","orospu","piç","sic","sıç","sik","sikerim","sikeyim",
  "s.ktir","s.kerim","salak","aptal","gerizekali","gerizekalı","mal","oç",
  "yarrak","ibne","top","serefsiz","şerefsiz","kahpe",
];

// ---------- Normalizasyon & profanity temizliği ----------
function normalizeText(tr: string): string {
  return tr
    .toLocaleLowerCase("tr")
    .replaceAll(/ç/g,"c").replaceAll(/ğ/g,"g").replaceAll(/ı/g,"i")
    .replaceAll(/i̇/g,"i").replaceAll(/ö/g,"o").replaceAll(/ş/g,"s").replaceAll(/ü/g,"u");
}
const bannedSet = new Set(BANNED_WORDS.map(w => normalizeText(w)));

// Kelime bloklarına bakıp küfürleri *** ile maskeler (noktalama/boşluk korunur)
function sanitizeProfanity(text: string): { cleaned: string; replaced: string[] } {
  const replaced = new Set<string>();
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

// (Opsiyonel) Fuzzy temizleme: a.m.k / a m k / am*k gibi kısa varyantlar
function normalizeLettersOnly(s: string): string {
  return normalizeText(s).replace(/[^\p{L}]+/gu, "");
}
function sanitizeProfanityFuzzy(text: string): { cleaned: string; matched: string[] } {
  const shortBanneds = Array.from(bannedSet).filter(w => w.length >= 2 && w.length <= 6);
  if (shortBanneds.length === 0) return { cleaned: text, matched: [] };

  // Hafif bir yaklaşım: küçük grupları tarayarak ayırıcıları at
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

// ---------- Cümle yardımcıları ----------
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

// ---------- Post-processing: öznel/abartı nötrleştirme + tekrar birleştirme + rush garantisi ----------
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

// ---------- LLM çağrısı ----------
async function callLLM(cleanedInput: string, targetMax: number, inputCount: number, rush: boolean): Promise<string> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY missing");

  const systemLines: string[] = [
    "Türkçe yazan bir editörsün.",
    "Girdi hangi dilde olursa olsun, çıktı dili daima Türkçe olacak.",
    "Görev: Ham biyoyu YALIN ve GERÇEKÇİ bir üslupla toparla; bilgileri koru.",
    `Girdi yaklaşık ${inputCount} cümle; çıktıda ${targetMax} cümleyi aşma.`,
    "KESİN UYULMASI GEREKEN KURALLAR:",
    "- SADECE verilen bilgilere dayan; yeni unvan/eğitim/başarı uydurma.",
    "- Abartı ve öznel övgü yok (örn: süperim, pozitif ayrılırım, çok iyi biliyorum, mükemmel, lider, uzman).",
    "- Başlık/emoji/kod bloğu/tırnak yok.",
    "- Yazım hatalarını düzelt; terimleri doğru yaz (örn. 'restoranda', 'ocakbaşı').",
    "- Bilgi kaybı olmasın; sadece tekrarları ve dolgu sözcükleri temizle.",
    "- Cümleleri kısa tut; tek paragraf halinde döndür.",
  ];
  if (rush) {
    systemLines.push(
      "- Girişte 'yoğun/kalabalık/pik/rush' bilgisi var; çıktı bunu net şekilde içermeli (örn. 'Yoğun saatlerde çalışmaya alışığım.')."
    );
  }
  const system = systemLines.join("\n");

  const maxTokens = Math.min(90 + inputCount * 10, 200); // üst sınırı 200'e çektik

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.0,             // deterministik
      max_tokens: maxTokens,
      stop: ["\n\n","```","Biyografi"],
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Ham biyo:\n${cleanedInput}\n\nYukarıdaki kurallara tam uyarak yalnızca düz metin döndür.` },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Upstream ${res.status}: ${await res.text().catch(()=> "")}`);
  const data = await res.json();
  let text: string = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";

  // Dış tırnak/boşluk temizliği
  text = text.trim().replace(/^[\s"'“”„«»]+|[\s"'“”„«»]+$/g, "");
  if (!text) throw new Error("Empty LLM response");
  return text;
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return bad("Only POST is allowed", 405);
  if (!API_KEY)                 return bad("OPENAI_API_KEY is missing (Edge Function Secrets)", 500);

  try {
    const body = await req.json().catch(() => ({}));
    const rawBioInput = (body?.rawBio ?? "").toString().trim();
    if (!rawBioInput) return bad("`rawBio` is required in JSON body");

    // 1) Girdi profanity temizliği
    const inSan = sanitizeProfanity(rawBioInput);
    let cleanedInput = inSan.cleaned;
    const inFuzzy = sanitizeProfanityFuzzy(cleanedInput);
    cleanedInput = inFuzzy.cleaned;

    // Dinamik hedefleri hesapla
    const inputHadRush = /(?:yoğun|kalabalık|pik|rush)/i.test(cleanedInput);
    const inputSentenceCount = countSentences(cleanedInput);
    const target = pickTargetRange(inputSentenceCount);

    // 2) LLM
    let llmText = await callLLM(cleanedInput, target.max, inputSentenceCount, inputHadRush);

    // 3) Yerel post-processing
    llmText = neutralizeSubjectivity(llmText);
    llmText = mergeRedundant(llmText);
    if (inputHadRush) llmText = ensureRushMention(llmText);

    // Sıkı tavan: en fazla 4 cümle
    llmText = enforceSentenceCap(llmText, 4);

    // 4) Çıkış profanity temizliği (garanti)
    const outSan = sanitizeProfanity(llmText);
    let improvedBio = outSan.cleaned;
    const outFuzzy = sanitizeProfanityFuzzy(improvedBio);
    improvedBio = outFuzzy.cleaned;

    return ok({ improvedBio });
  } catch (err: unknown) {
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
