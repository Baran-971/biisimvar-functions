// supabase/functions/elaborate-bio/index.ts

// ---------- CORS ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- ENV ----------
const API_BASE = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
const API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant";

function badRequest(detail: unknown, code = 400) {
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

// ---------- Yasaklı kelimeler ----------
// Not: Listeyi ihtiyacına göre genişlet.
// Basit ama etkili bir normalizasyon + bütün kelime eşleştirme yapılır.
const BANNED_WORDS = [
  // genel küfürler (TR karakterli varyantlar otomatik normalize edilecek)
  "amk", "amına", "amını", "amina", "orospu", "piç", "sıç", "sik", "sikerim", "sikeyim",
  "s.ktir", "s.kerim", "salak", "aptal", "gerizekalı", "gerizekali", "mal", "oç",
  // ırkçı/aşağılayıcı bazı yaygın örnekler
  "yarrak", "ibne", "top", "şerefsiz", "serefsiz", "kahpe",
];

// TR karakterlerini sadeleştirip küçük harfe çevir
function normalize(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replaceAll(/ç/g, "c")
    .replaceAll(/ğ/g, "g")
    .replaceAll(/ı/g, "i")
    .replaceAll(/i̇/g, "i")
    .replaceAll(/ö/g, "o")
    .replaceAll(/ş/g, "s")
    .replaceAll(/ü/g, "u");
}

// kelime sınırlarıyla eşleştir (Unicode)
const bannedRegex = new RegExp(
  `\\b(${BANNED_WORDS.map(w => normalize(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "iu"
);

function findBannedWords(input: string): string[] {
  const n = normalize(input);
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  const r = new RegExp(bannedRegex.source, bannedRegex.flags); // fresh regex for exec loop
  while ((m = r.exec(n)) !== null) {
    found.add(m[1]);
  }
  return Array.from(found);
}

// ---------- LLM çağrısı ----------
async function callLLM(rawBio: string): Promise<string> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY missing");

  const system = [
    "Türkçe yazan bir editörsün.",
    "Girdi hangi dilde olursa olsun, çıktı dili daima Türkçe olacak.",
    "Yazan kişinin eğitimi çok iyi olmayabilir; sade ve anlaşılır yaz.",
    "Görev: Ham biyoyu YALIN ve GERÇEKÇİ en fazla 4 cümleye dönüştür.",
    "KURALLAR:",
    "- SADECE verilen bilgilere dayan; yeni unvan/eğitim/başarı uydurma.",
    "- Abartı ve öznel övgü YOK (örn: severim, seviyorum, tutkuluyum, mükemmel, lider, uzman).",
    "- Başlık/emoji/kod bloğu/tırnak YOK.",
    "- Yazım hatalarını düzelt.",
    "- 1. cümle: süre + rol + yer (örn. 'X yıl restoranda garsonluk yaptım').",
    "- 2. cümle: verilen beceri/alışkanlıkları NÖTR ifade et (örn. 'Yoğun saatlerde çalışmaya alışığım; müşterilerle düzgün iletişim kurarım.').",
    "- ÇIKTI: yalnızca düz metin; en fazla 4 cümle; mümkünse 2–3 kısa cümle.",
  ].join("\n");

  const user = `Ham biyo: "${rawBio}"\n\nLütfen sadece düz metni döndür.`;

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.0,
      max_tokens: 160,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Upstream ${res.status}: ${t}`);
  }
  const data = await res.json();
  let text: string =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";

  text = text.trim();
  // Çoğu model bazen tırnaklarla döner; temizle:
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("“") && text.endsWith("”"))) {
    text = text.slice(1, -1).trim();
  }
  if (!text) throw new Error("Empty LLM response");
  return text;
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return badRequest("Only POST is allowed", 405);

  try {
    const body = await req.json().catch(() => ({}));
    const rawBio = (body?.rawBio ?? "").toString().trim();
    if (!rawBio) return badRequest("`rawBio` is required in JSON body");

    // Yasaklı içerik kontrolü
    const banned = findBannedWords(rawBio);
    if (banned.length > 0) {
      return new Response(
        JSON.stringify({
          error: "prohibited_content",
          message: "Metinde yasaklı/küfür içeren kelimeler tespit edildi.",
          words: banned,
        }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const improvedBio = await callLLM(rawBio);
    return ok({ improvedBio });
  } catch (err: unknown) {
    console.error("elaborate-bio error:", err);
    const detail =
      typeof err === "object" && err !== null && "message" in err
        ? // @ts-ignore
          err.message
        : String(err);
    return new Response(JSON.stringify({ error: "internal_error", detail }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
