// supabase/functions/jobseeker-wizard/index.ts

// ==== Ortak CORS / LLM Ayarları ====
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
    status: code,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

// ==== Küfür Filtresi (elaborate-bio ile aynı) ====

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
  cleaned = cleaned.replace(
    /(\p{L})([^\p{L}]*)?(\p{L})([^\p{L}]*)?(\p{L})([^\p{L}]*)?(\p{L})?/gu,
    (m) => {
      const lettersOnly = normalizeLettersOnly(m);
      if (lettersOnly && shortBanneds.includes(lettersOnly)) {
        matched.push(m);
        return "***";
      }
      return m;
    },
  );
  return { cleaned, matched };
}

function fullSanitize(text: string): string {
  let out = sanitizeProfanity(text).cleaned;
  out = sanitizeProfanityFuzzy(out).cleaned;
  return out;
}

// ==== Form state tipi ve sabitler ====

type WizardFormState = {
  p_name?: string;
  p_birthday_year?: string;
  p_gender?: string;
  p_start_day?: string;
  p_shift_prefs?: string[];
  p_benefits?: string[];
  p_attributes?: string[];
  p_salary_min?: number | null;
  p_salary_max?: number | null;
  p_tip_preference?: string;
  p_bio?: string;
  p_experience?: string;
  p_interests?: string[];
};

const STEP_FIELDS: (keyof WizardFormState)[] = [
  "p_name",
  "p_birthday_year",
  "p_gender",
  "p_start_day",
  "p_shift_prefs",
  "p_benefits",
  "p_attributes",
  "p_salary_min",   // salary_max beraber set edilecek
  "p_tip_preference",
  "p_experience",
];

const ENUMS = {
  startDays: ["yarın", "3 gün içinde", "1 hafta içinde"],
  shifts: ["sabah", "öğle", "akşam"],
  benefits: ["yemek", "ulaşım", "özel gün izni"],
  attributes: [
    "insan ilişkileri iyi",
    "sorun çözen",
    "konuşkan",
    "titiz",
    "çabuk öğrenen",
    "zamanında işe gelen",
  ],
  genders: ["kadın", "erkek", "belirtmek istemiyorum"],
  tips: ["bahşiş çalışana ait", "ortak bahşiş", "bahşiş yok"],
};

// TR / EN soru metinleri – SAMİMİ ama kısa
const QUESTIONS_TR: string[] = [
  "Merhaba! Önce seni tanıyalım. Adın ne, seni nasıl çağıralım?",
  "Doğum yılın nedir?",
  "Cinsiyetini seçelim: kadın, erkek veya belirtmek istemiyorum.",
  "Ne zaman işe başlayabilirsin? 'yarın', '3 gün içinde' veya '1 hafta içinde' diyebilirsin.",
  "Hangi vardiyalarda çalışmak istersin? Sabah, öğle, akşam; birden fazlasını da söyleyebilirsin.",
  "İş yerinden hangi yan hakları beklersin? Örneğin yemek, ulaşım, özel gün izni.",
  "Seni en iyi anlatan özellikleri söyle: insan ilişkileri iyi, sorun çözen, konuşkan, titiz, çabuk öğrenen, zamanında işe gelen.",
  "Aylık yaklaşık kaç TL net maaş bekliyorsun?",
  "Bahşiş politikası nasıl olsun istersin? 'bahşiş çalışana ait', 'ortak bahşiş' veya 'bahşiş yok' diyebilirsin.",
  "Kısaca deneyiminden bahseder misin? Nerede, ne kadar süre çalıştın, neler yaptın?",
];

const QUESTIONS_EN: string[] = [
  "Hi! Let’s start with your name. How should we call you?",
  "What is your year of birth?",
  "What is your gender: female, male or prefer not to say?",
  "When can you start working? You can say 'tomorrow', 'in 3 days' or 'within 1 week'.",
  "Which shifts can you work? Morning, noon, evening – you can mention more than one.",
  "Which benefits do you expect from the workplace? For example: meal, transportation, special day leave.",
  "Which traits describe you best: good with people, problem solver, talkative, tidy, fast learner, always on time?",
  "Approximately how much net monthly salary (in TL) do you expect?",
  "How should the tip policy be for you? Tips for employee, shared tip, or no tip?",
  "Can you briefly describe your work experience? Where did you work, how long and what did you do?",
];

function getQuestion(lang: string, step: number): string {
  const arr = lang === "en" ? QUESTIONS_EN : QUESTIONS_TR;
  if (step < 0 || step >= arr.length) return lang === "en"
    ? "All questions are completed. You can review your profile."
    : "Tüm soruları tamamladık. Profilini inceleyebilirsin.";
  return arr[step];
}

function computeNextStep(form: WizardFormState): { nextStep: number; isFinished: boolean } {
  for (let i = 0; i < STEP_FIELDS.length; i++) {
    const key = STEP_FIELDS[i];
    const value = (form as any)[key];

    if (value === undefined || value === null) {
      return { nextStep: i, isFinished: false };
    }
    if (typeof value === "string" && !value.trim()) {
      return { nextStep: i, isFinished: false };
    }
    if (Array.isArray(value) && value.length === 0) {
      return { nextStep: i, isFinished: false };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { nextStep: i, isFinished: false };
    }
  }
  // hepsi dolu
  return { nextStep: STEP_FIELDS.length, isFinished: true };
}

// ==== LLM – tek görevi: ilgili step için alanları parse etmek ====

async function callExtractorLLM(
  stepIndex: number,
  languageCode: string,
  userInput: string,
  formState: WizardFormState,
): Promise<Partial<WizardFormState>> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY missing");

  const lang = languageCode === "en" ? "en" : "tr";

  const system = `
You are a STRICT JSON generator for the "Bi İşim Var" job seeker wizard.

- Your ONLY job is to parse the user's free-text answer for the CURRENT STEP.
- You NEVER chat, never ask questions, never give explanations.
- You ALWAYS return ONLY a single JSON object without any extra text.

The internal field names are fixed and MUST be in Turkish:
- p_name (string)
- p_birthday_year (string, 4 digits if possible)
- p_gender ("kadın" | "erkek" | "belirtmek istemiyorum")
- p_start_day: one of ${JSON.stringify(ENUMS.startDays)}
- p_shift_prefs: array of ${JSON.stringify(ENUMS.shifts)}
- p_benefits: array of ${JSON.stringify(ENUMS.benefits)}
- p_attributes: array of ${JSON.stringify(ENUMS.attributes)}
- p_salary_min: number (approx net monthly TL)
- p_salary_max: number (approx net monthly TL)
- p_tip_preference: one of ${JSON.stringify(ENUMS.tips)}
- p_experience: short free-text string (max 2 sentences)
- p_interests: array of strings (optional)

If the answer is not clear for that step, return null for that field.

If the user writes in English, you STILL map to the Turkish codes above.
  `.trim();

  let stepInstruction = "";

  switch (stepIndex) {
    case 0:
      stepInstruction = `
STEP 0: Extract the person's preferred name from the answer.
Return JSON like: {"p_name": "Baran"}.
If you are unsure, return {"p_name": null}.`;
      break;
    case 1:
      stepInstruction = `
STEP 1: Extract the year of birth as 4 digits if possible.
Return JSON: {"p_birthday_year": "1986"} or {"p_birthday_year": null}.`;
      break;
    case 2:
      stepInstruction = `
STEP 2: Extract gender.

If the user indicates female/woman → "kadın".
If male/man → "erkek".
If they say they don't want to share → "belirtmek istemiyorum".

Return JSON: {"p_gender": "kadın"} or null.`;
      break;
    case 3:
      stepInstruction = `
STEP 3: Extract start day preference.

Map the answer to one of:
${ENUMS.startDays.join(" , ")}

Return JSON: {"p_start_day": "yarın"} or null.`;
      break;
    case 4:
      stepInstruction = `
STEP 4: Extract shift preferences.

Allowed values (Turkish codes):
${ENUMS.shifts.join(" , ")}

The user may say one or more shifts. Map and deduplicate.
Return JSON: {"p_shift_prefs": ["sabah","akşam"]} or {"p_shift_prefs": []}.`;
      break;
    case 5:
      stepInstruction = `
STEP 5: Extract job benefits.

Allowed values (Turkish codes):
${ENUMS.benefits.join(" , ")}

Return JSON: {"p_benefits": [...]} or an empty array if none.`;
      break;
    case 6:
      stepInstruction = `
STEP 6: Extract personal attributes.

Allowed values (Turkish codes):
${ENUMS.attributes.join(" , ")}

Return JSON: {"p_attributes": [...]} or empty array.`;
      break;
    case 7:
      stepInstruction = `
STEP 7: Extract expected net monthly salary in Turkish Lira.

If a range is given, take the middle value.
Return JSON: {"p_salary_min": 25000, "p_salary_max": 25000} or both null.`;
      break;
    case 8:
      stepInstruction = `
STEP 8: Extract tip preference.

Map to one of:
${ENUMS.tips.join(" , ")}

Return JSON: {"p_tip_preference": "bahşiş çalışana ait"} or null.`;
      break;
    case 9:
      stepInstruction = `
STEP 9: Extract a SHORT experience description (max 2 sentences).

Return JSON: {"p_experience": "…"} or null.`;
      break;
    default:
      // Outside normal steps: nothing to change
      return {};
  }

  const userPayload = {
    language_code: lang,
    step_index: stepIndex,
    answer: userInput,
    current_form_state: formState,
  };

  const messages = [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `${stepInstruction}\n\nUSER_ANSWER_PAYLOAD:\n${JSON.stringify(userPayload)}`,
    },
  ];

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.0,
      max_tokens: 256,
      messages,
    }),
  });

  if (!res.ok) {
    throw new Error(`Upstream ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const data = await res.json();
  let text: string =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";

  text = text.trim();

  // Sadece JSON bekliyoruz
  try {
    const parsed = JSON.parse(text);
    return parsed as Partial<WizardFormState>;
  } catch {
    // Model saçmalarsa formu bozmamak için boş döneriz
    return {};
  }
}

// ==== Handler ====

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return bad("Only POST is allowed", 405);
  }
  if (!API_KEY) {
    return bad("OPENAI_API_KEY is missing", 500);
  }

  try {
    const body = await req.json().catch(() => ({}));

    const userId = (body?.user_id ?? "").toString().trim();
    const languageCode = (body?.language_code ?? "tr").toString().toLowerCase();
    const userInputRaw = (body?.user_input_text ?? "").toString();
    const stepIndexRaw = Number(body?.step_index ?? 0);
    const stepIndex = Number.isFinite(stepIndexRaw) && stepIndexRaw >= 0
      ? Math.floor(stepIndexRaw)
      : 0;

    const formState: WizardFormState = (body?.form_state ?? {}) as WizardFormState;

    if (!userId) return bad("user_id is required");
    if (!userInputRaw) return bad("user_input_text is required");

    // Kullanıcı cevabındaki küfürleri maskele
    const cleanedInput = fullSanitize(userInputRaw);

    // İlgili step için LLM ile parse et
    const updates = await callExtractorLLM(stepIndex, languageCode, cleanedInput, formState);

    // Güncel form state
    const newForm: WizardFormState = { ...formState, ...updates };

    // Özellikle deneyim alanında küfür varsa tekrar temizle
    if (newForm.p_experience) {
      newForm.p_experience = fullSanitize(newForm.p_experience);
    }
    if (newForm.p_bio) {
      newForm.p_bio = fullSanitize(newForm.p_bio);
    }

    // Sıradaki adımı ve bitiş durumunu hesapla
    const { nextStep, isFinished } = computeNextStep(newForm);

    let assistant_reply: string;

    if (isFinished) {
      assistant_reply = languageCode === "en"
        ? "Great, I have all the basic info I need. You can review your profile below and tap 'Let's Find A Job' when you’re ready."
        : "Harika, temel bilgilerin tamam. Aşağıdaki profilini kontrol edebilirsin; hazırsan 'Let's Find A Job' butonuna basabilirsin.";
    } else {
      assistant_reply = getQuestion(languageCode, nextStep);
    }

    return ok({
      assistant_reply,
      is_finished: isFinished,
      step_index: nextStep,
      form_state: newForm,
    });
  } catch (err: unknown) {
    const detail =
      typeof err === "object" && err !== null && "message" in err
        ? (err as any).message
        : String(err);
    return new Response(JSON.stringify({ error: "internal_error", detail }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
