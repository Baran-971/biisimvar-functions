// deno-lint-ignore-file no-explicit-any
// Hybrid (optimize) wizard – parse + chat + token optimization

// ==== Ortak CORS / LLM Ayarları ====
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const API_BASE =
  Deno.env.get("OPENAI_BASE_URL") ?? "https://api.groq.com/openai/v1";
const API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("LLM_MODEL") ?? "llama-3.1-8b-instant";

const bad = (detail: any, code = 400) =>
  new Response(
    JSON.stringify({
      error: "bad_request",
      detail,
    }),
    {
      status: code,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    },
  );

const ok = (body: any) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });

// ==== Küfür Filtresi (Profanity Filter) ====

const BANNED_WORDS = [
  "amk",
  "amina",
  "amına",
  "amını",
  "orospu",
  "piç",
  "sic",
  "sıç",
  "sik",
  "sikerim",
  "sikeyim",
  "s.ktir",
  "s.kerim",
  "salak",
  "aptal",
  "gerizekali",
  "gerizekalı",
  "mal",
  "oç",
  "yarrak",
  "ibne",
  "top",
  "serefsiz",
  "şerefsiz",
  "kahpe",
];

function normalizeText(tr: string): string {
  return tr
    .toLocaleLowerCase("tr")
    .replaceAll(/ç/g, "c")
    .replaceAll(/ğ/g, "g")
    .replaceAll(/ı/g, "i")
    .replaceAll(/i̇/g, "i")
    .replaceAll(/ö/g, "o")
    .replaceAll(/ş/g, "s")
    .replaceAll(/ü/g, "u");
}

const BANNED_SET = new Set(BANNED_WORDS.map((w) => normalizeText(w)));

function sanitizeProfanity(
  text: string,
): { cleaned: string; replaced: string[] } {
  const replaced = new Set<string>();
  const cleaned = text.replace(/\p{L}+/gu, (word) => {
    const norm = normalizeText(word);
    if (BANNED_SET.has(norm)) {
      replaced.add(word);
      return "***";
    }
    return word;
  });
  return {
    cleaned,
    replaced: Array.from(replaced),
  };
}

function normalizeLettersOnly(s: string): string {
  // Sadece harfleri tutar ve normalleştirir.
  return normalizeText(s).replace(/[^\p{L}]+/gu, "");
}

function sanitizeProfanityFuzzy(
  text: string,
): { cleaned: string; matched: string[] } {
  // 2-6 karakterli yasak kelimeleri harf aralarına başka karakterler girmiş olsa bile yakalamaya çalışır.
  const shortBanneds = Array.from(BANNED_SET).filter((w) =>
    w.length >= 2 && w.length <= 6
  );
  if (shortBanneds.length === 0) {
    return {
      cleaned: text,
      matched: [],
    };
  }
  let cleaned = text;
  const matched: string[] = [];
  cleaned = cleaned.replace(
    /(\p{L})([^\p{L}]*)?(\p{L})([^\p{L}]*)?(\p{L})?([^\p{L}]*)?(\p{L})?/gu,
    (m) => {
      const lettersOnly = normalizeLettersOnly(m);
      if (lettersOnly && shortBanneds.includes(lettersOnly) &&
        lettersOnly.length >= 2) {
        matched.push(m);
        return "***";
      }
      return m;
    },
  );
  return {
    cleaned,
    matched,
  };
}

function fullSanitize(text: string): string {
  let out = sanitizeProfanity(text).cleaned;
  out = sanitizeProfanityFuzzy(out).cleaned;
  return out;
}

// Sigorta kelimesi tespiti (benefits step için)
function mentionsSigorta(text: string): boolean {
  if (!text) return false;
  const norm = normalizeText(text);
  return norm.includes("sigorta") || norm.includes("sgk");
}

// ==== Form / Enum / Maaş limitleri ====

const STEP_FIELDS = [
  "p_name",
  "p_birthday_year",
  "p_gender",
  "p_start_day",
  "p_shift_prefs",
  "p_benefits",
  "p_attributes",
  "p_salary_min",
  "p_tip_preference",
  "p_experience",
  "p_bio",
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

// Maaş aralığı (hard limitler)
const MIN_SALARY = 22104; // Asgari ücret
const MAX_SALARY = 100000; // Üst sınır

// Küçük yardımcılar (server-side sanitization)
function ensureStringArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) =>
      v !== null && v !== undefined ? String(v).trim() : ""
    )
    .filter((s) => s.length > 0);
}

function coerceNumberOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  // Virgül, nokta, TL simgeleri vs temizle
  const s = String(v).replace(/[,.]/g, "").replace(/[^\d]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function coerceEnum(value: any, allowed: string[]): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const match = allowed.find((opt) => opt.toLowerCase() === s.toLowerCase());
  return match;
}

// Sadece ilgili step için enum gönderimi (token optimizasyonu)
function getRelevantEnums(stepIndex: number): Record<string, string[]> {
  switch (stepIndex) {
    case 2:
      return { p_gender: ENUMS.genders };
    case 3:
      return { p_start_day: ENUMS.startDays };
    case 4:
      return { p_shift_prefs: ENUMS.shifts };
    case 5:
      return { p_benefits: ENUMS.benefits };
    case 6:
      return { p_attributes: ENUMS.attributes };
    case 8:
      return { p_tip_preference: ENUMS.tips };
    default:
      return {};
  }
}

// TR / EN soru metinleri
const QUESTIONS_TR = [
  "Merhaba! Önce seni tanıyalım. Adını ve soyadını yazabilir misin? Sana nasıl hitap edeyim?",
  "Doğum yılın nedir?",
  "Doğrulamak için soruyorum. Cinsiyet belirtebilirsen sevinirim: kadın, erkek veya belirtmek istemiyorum.",
  "Ne zaman işe başlayabilirsin? 'Yarın', '3 Gün İçinde' veya '1 Hafta İçinde' yazman yeterli.",
  "Hangi vardiyalarda çalışmak istersin? Sabah, Öğle, Akşam; hatta birden fazlasını da söyleyebilirsin.",
  "İş yerinden hangi yan hakları beklersin? Örneğin Yemek, Ulaşım, Özel Gün İzni.",
  "Seni en iyi anlatan özelliklerden 2 tanesini yazar mısın? Örneğin: insan ilişkileri iyi, sorun çözen, konuşkan, titiz, çabuk öğrenen, zamanında işe gelen.",
  "Aylık maaş beklentin nedir? Bir maaş aralığını rakamla yazarsan sevinirim.",
  "Bahşiş nasıl olsun istersin? 'Bahşiş Çalışana Ait', 'Ortak Bahşiş' veya 'Bahşiş Yok' diyebilirsin.",
  "Kısaca deneyiminden bahseder misin? Nerede, ne kadar süre çalıştın, neler yaptın, uzmanlıkların neler?",
  "Son olarak, topladığım tüm bu bilgileri kullanarak senin için profesyonel bir biyografi oluşturacağım. 'Tamam, oluştur' demen yeterli mi?",
];

const QUESTIONS_EN = [
  "Hi! Let’s get to know you. Could you write your first and last name? How should I address you?",
  "What is your year of birth?",
  "Just to confirm, could you share your gender: female, male or prefer not to say?",
  "When can you start working? Typing 'Tomorrow', 'Within 3 Days' or 'Within 1 Week' is enough.",
  "Which shifts would you like to work? Morning, Noon, Evening; you can also mention more than one.",
  "Which benefits do you expect from the workplace? For example: Meal, Transportation, Special Day Off.",
  "Could you write 2 traits that describe you best? For example: good with people, problem solver, talkative, tidy, fast learner, always on time.",
  "What is your monthly salary expectation? It would be great if you could write a numeric range.",
  "How would you like the tip policy to be? You can say 'Tips Belong to Employee', 'Shared Tips' or 'No Tips'.",
  "Can you briefly describe your experience? Where did you work, for how long, what did you do, what are your specialties?",
  "Finally, I’ll use all this information to create a professional biography for you. Is it okay if I go ahead and create it now? Just say 'Yes, create it'.",
];

function getQuestion(lang: string, step: number): string {
  const arr = lang === "en" ? QUESTIONS_EN : QUESTIONS_TR;
  if (step < 0 || step >= arr.length) {
    return lang === "en"
      ? "All questions are completed. You can review your profile."
      : "Tüm soruları tamamladık. Profilini inceleyebilirsin.";
  }
  return arr[step];
}

// Form state içinde sıradaki eksik alanı bulma
function computeNextStep(
  form: any,
): { nextStep: number; isFinished: boolean } {
  for (let i = 0; i < STEP_FIELDS.length; i++) {
    const key = STEP_FIELDS[i];
    const value = form[key];

    if (value === undefined || value === null) {
      return { nextStep: i, isFinished: false };
    }

    if (typeof value === "string" && !value.trim()) {
      return { nextStep: i, isFinished: false };
    }

    if (Array.isArray(value) && value.length === 0) {
      if (key === "p_shift_prefs" || key === "p_benefits" ||
        key === "p_attributes") {
        continue; // boş dizi kabul
      }
      return { nextStep: i, isFinished: false };
    }

    if (key === "p_salary_min") {
      const minVal = value;
      const maxVal = form.p_salary_max;
      const isMinValid = typeof minVal === "number" &&
        Number.isFinite(minVal) &&
        minVal >= MIN_SALARY &&
        minVal <= MAX_SALARY;
      const isMaxValid = typeof maxVal === "number" &&
        Number.isFinite(maxVal) &&
        maxVal >= MIN_SALARY &&
        maxVal <= MAX_SALARY;

      if (
        !isMinValid ||
        !isMaxValid ||
        (isMinValid && isMaxValid && minVal > maxVal)
      ) {
        return { nextStep: i, isFinished: false };
      }
    }
  }
  return { nextStep: STEP_FIELDS.length, isFinished: true };
}

const STEP_CONFIGS: Record<number, any> = {
  0: { field: "p_name", label: "name", kind: "name" },
  1: { field: "p_birthday_year", label: "birth year", kind: "birth_year" },
  2: {
    field: "p_gender",
    label: "gender",
    kind: "gender",
    vagueHintTr:
      "Kadın / erkek / belirtmek istemiyorum arasından birini seçmen gerekiyor.",
    vagueHintEn:
      "You need to choose one of: female / male / prefer not to say.",
  },
  3: {
    field: "p_start_day",
    label: "start day",
    kind: "start_day",
    vagueHintTr:
      "Başlangıç için yarın, 3 gün içinde veya 1 hafta içinde gibi net bir zaman söylemen iyi olur.",
    vagueHintEn:
      "Please choose a clear option like tomorrow, in 3 days or within 1 week.",
  },
  4: {
    field: "p_shift_prefs",
    label: "shift preferences",
    kind: "shift",
    vagueHintTr:
      "Daha fazla vardiya seçmek sana daha çok ilan gösterebilir, ama son karar senin.",
    vagueHintEn:
      "Choosing more shifts can show you more jobs, but the final decision is yours.",
  },
  5: {
    field: "p_benefits",
    label: "benefits",
    kind: "benefits",
    vagueHintTr:
      "Sana gerçekten önemli olan yan hakları seçmen, eşleşmelerin daha doğru olmasını sağlar.",
    vagueHintEn:
      "Choosing benefits that really matter to you helps with better matches.",
  },
  6: {
    field: "p_attributes",
    label: "attributes",
    kind: "attributes",
    vagueHintTr:
      "Seni en iyi anlatan 2-3 özelliği seçmen, işverenin seni daha iyi tanımasına yardım eder.",
    vagueHintEn:
      "Picking 2–3 traits that describe you best helps employers understand you.",
  },
  7: {
    field: "p_salary_min",
    label: "salary expectation",
    kind: "salary",
    vagueHintTr:
      "Kabaca bir maaş aralığı söylemen, sana uygun ilanları filtrelememiz için önemli.",
    vagueHintEn:
      "Giving at least an approximate salary range helps us filter better jobs for you.",
  },
  8: {
    field: "p_tip_preference",
    label: "tip preference",
    kind: "tip",
    vagueHintTr:
      "Bahşiş konusunda net olman, iş yeri beklentilerinle uyumu artırır.",
    vagueHintEn:
      "Being clear about tip policy helps align with workplace expectations.",
  },
  9: {
    field: "p_experience",
    label: "experience",
    kind: "experience",
    vagueHintTr:
      "Kısaca nerede, ne kadar süre çalıştığını yazman yeterli, çok uzun olmasına gerek yok.",
    vagueHintEn:
      "A short summary of where and how long you worked is enough, no need for long stories.",
  },
  10: {
    field: "p_bio",
    label: "professional biography",
    kind: "bio_generation",
    vagueHintTr:
      "Sana profesyonel bir biyografi hazırlamam için onay vermen gerekiyor. Bu metin işverenlere gösterilecek.",
    vagueHintEn:
      "You need to approve the creation of your professional biography. This text will be shown to employers.",
  },
};

// Step instruction
function buildStepInstruction(
  stepIndex: number,
  lang: string,
  formState: any,
): string {
  const cfg = STEP_CONFIGS[stepIndex];
  if (!cfg) {
    return `
This step index is out of configured range. Do not change any field. Mark step_done as true and return empty updates and empty assistant_comment.
`.trim();
  }

  const enumsForStep = getRelevantEnums(stepIndex);
  const enumsSnippet = Object.keys(enumsForStep).length
    ? `Relevant enums for this step: ${JSON.stringify(enumsForStep)}.`
    : `This step does not use enums.`;
  const vagueHint = lang === "tr" ? cfg.vagueHintTr : cfg.vagueHintEn;

  switch (cfg.kind) {
    case "name":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (name).

- Extract the person's preferred name (can include surname) from the answer.
- If clear, set updates.p_name = "<name>" and step_done = true.
- If not clear, keep updates.p_name null/empty, set step_done = false.

TURKISH ASSISTANT COMMENT RULES:
- If language_code is "tr" AND step_done = true:
  - assistant_comment SHOULD be something like: "Merhaba, doğum yılın nedir?" or "Merhaba <isim>, doğum yılın nedir?".
  - Always talk to the user with "sen / senin", NEVER use "biz / bizim / ismimiz".
- If language_code is "tr" AND step_done = false:
  - assistant_comment MUST be: "Adını tekrar, daha net yazar mısın?"

ENGLISH ASSISTANT COMMENT RULES:
- If language_code is "en" AND step_done = true:
  - assistant_comment SHOULD be: "Nice to meet you. What is your year of birth?"
- If language_code is "en" AND step_done = false:
  - assistant_comment MUST be: "Could you please write your name again more clearly?"

${enumsSnippet}
`.trim();

    case "birth_year":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (birth year).

- Extract a 4-digit birth year if possible (e.g. "1986").
- The year must be reasonable (not in the future, not before 1900), but be tolerant.
- If clear, set updates.p_birthday_year and step_done = true.
- If unclear, leave p_birthday_year null/empty and step_done = false.

TURKISH ASSISTANT COMMENT RULE (CRITICAL):
- If language_code is "tr" AND step_done = false, assistant_comment MUST be EXACTLY:
  "Doğum yılını lütfen rakamla yazar mısın?"

ENGLISH ASSISTANT COMMENT RULE:
- If language_code is "en" AND step_done = false, assistant_comment MUST be EXACTLY:
  "Could you write your year of birth in numbers?"

${enumsSnippet}
`.trim();

    case "gender":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (gender).

- Map answer to one of: ${JSON.stringify(ENUMS.genders)}.
- If they say things like "doesn't matter / prefer not to say" map accordingly.
- If still vague, leave null, set step_done = false and ask clearly.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();

    case "start_day":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (start day).

- Map to one of: ${JSON.stringify(ENUMS.startDays)}.
- If vague, leave null, step_done = false and ask them to pick one of these.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();

    case "shift":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (shift preferences).

- Allowed values: ${JSON.stringify(ENUMS.shifts)} (array).
- User may choose one or more.
- If they clearly say they are fine with ALL shifts, you MAY set updates.p_shift_prefs = ["sabah","öğle","akşam"] and step_done = true.
- If they say things like "fark etmez / sen karar ver / you decide / whatever" without clearly indicating ALL shifts, set updates.p_shift_prefs = [] and step_done = false.
- In that case assistant_comment should EXPLAIN that choosing more shifts can show more jobs, but the final decision is theirs, and ask for their final choice.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();

    case "benefits":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (benefits).

- Allowed values: ${JSON.stringify(ENUMS.benefits)} (array).
- Extract all benefits they clearly mention that match these options.
- If they mention "sigorta", "SGK" or similar insurance words:
  - DO NOT add it as a benefit value.
  - In assistant_comment, remind them that insurance/social security is a legal requirement and should be discussed directly with the employer.
- If answer is vague, set empty array, step_done = false and ask them which ones really matter.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();

    case "attributes":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (attributes).

- Allowed values: ${JSON.stringify(ENUMS.attributes)} (array).
- Extract 1..3 traits they clearly mention if possible.
- If vague, set empty array, step_done = false and ask them to pick a few.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();

    case "salary": {
      const salaryMsgTr =
        "Ben yapay zeka olduğum için bir gelirim yok. Ama senin maaşının senin için ne kadar önemli olduğunu biliyorum. Tutar hakkında yorum yapamam; maaş beklentini lütfen sadece rakamlarla ve mümkünse bir aralık olarak yaz.";
      const salaryMsgEn =
        "Since I’m an AI, I don’t have an income. But I know your salary is very important for you. I can’t comment on the amount; please write your expected salary only as numbers and preferably as a range.";
      return `
Current STEP = ${stepIndex} for fields "p_salary_min" and "p_salary_max" (salary expectation).

PARSING:
- Extract net monthly salary in Turkish Lira.
- If they give a single value, set BOTH p_salary_min and p_salary_max to that numeric value.
- If they give a range (e.g. "20-25 bin", "30 ile 35 arası"), map that to numeric min and max.
- Server will later validate that both are between ${MIN_SALARY} and ${MAX_SALARY}.
- If the answer is vague ("farketmez", "you decide", "whatever"), set BOTH p_salary_min and p_salary_max to null, step_done = false and ask them to choose at least an approximate range.

ASSISTANT MESSAGE RULE (VERY IMPORTANT):
- assistant_comment MUST be very short and friendly.
- In ${lang === "tr" ? "Turkish" : "English"}, it MUST start with this fixed text:

  ${lang === "tr" ? salaryMsgTr : salaryMsgEn}

- After this text, you may add ONE short sentence asking them to write a numeric range (but DO NOT include any numbers).
- NEVER suggest or recommend any specific amount.
- NEVER include any digits or numbers in assistant_comment (no 0-9 anywhere), even if the user mentioned numbers.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();
    }

    case "tip":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (tip preference).

- Map answer to one of: ${JSON.stringify(ENUMS.tips)}.
- If vague, leave null, step_done = false and ask which one they prefer.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();

    case "experience":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (experience).

- Extract a SHORT description (max 2 sentences).
- If clear, set p_experience and step_done = true.
- If nothing relevant, leave null and step_done = false and ask them to briefly describe experience.

Vague hint for the user: ${vagueHint ?? ""}

${enumsSnippet}
`.trim();

    case "bio_generation":
      return `
Current STEP = ${stepIndex} for field "${cfg.field}" (Professional Biography Generation).

- Your task is to act as a professional career biography writer specializing in the service industry.
- You MUST use only the following fields from 'current_form_state' to write the bio:
  - p_start_day, p_shift_prefs, p_benefits, p_attributes, p_tip_preference, p_experience, p_interests
- You MUST NOT use or mention: p_name, p_birthday_year, p_gender, p_salary_min, p_salary_max.
- Write a single, cohesive, engaging, and professional first-person summary.
- Tone: suitable for a job application in the service sector.
- The user input for this step is just an "OK" signal (e.g., "Tamam", "Oluştur", "Yes"). Ignore its content for parsing.
- If 'current_form_state' is complete enough (all fields except p_bio filled), you must generate the bio.
- Set updates.p_bio = "<GENERATED_BIOGRAPHY>" and set step_done = true.
- If any critical fields (especially p_experience) are still empty, set step_done = false and ask the user to complete them first.

IMPORTANT BIO RULES:
1) DO NOT mention any salary figures or salary expectations.
2) DO NOT include any placeholder for salary (e.g. [X TL]).
3) DO NOT use the user's name in the biography. Use first-person perspective ("Ben" in Turkish, "I" in English).
4) Keep the biography between 3 and 7 sentences, maximum 7 sentences.

Collected Data to use for biography:
${JSON.stringify(formState, null, 2)}
`.trim();
  }

  return `
This step index is out of configured range. Do not change any field. Mark step_done as true and return empty updates and empty assistant_comment.
`.trim();
}

// ==== LLM – parse + konuşma (Hybrid – optimize) ====

async function callExtractorLLM(
  stepIndex: number,
  languageCode: string,
  userInput: string,
  formState: any,
): Promise<{ updates: any; step_done: boolean; assistant_comment: string }> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY missing");

  const lang = languageCode === "en" ? "en" : "tr";
  const currentField = STEP_FIELDS[stepIndex];
  const enumsForStep = getRelevantEnums(stepIndex);
  const cfg = STEP_CONFIGS[stepIndex];
  const isBioStep = cfg?.kind === "bio_generation";

  let system = "";

  if (isBioStep) {
    system = `
You are the professional biography generator for the "Bi İşim Var" job seeker wizard.

TASKS FOR THIS REQUEST ONLY:
1) GENERATE a single, professional, first-person biography text based on the provided 'current_form_state'.
2) TALK to the user with a SHORT, friendly message in ${lang === "tr" ? "Turkish" : "English"}, acknowledging the creation and/or asking for final confirmation.

GENERAL RULES:
- Use ONLY: p_start_day, p_shift_prefs, p_benefits, p_attributes, p_tip_preference, p_experience, p_interests.
- DO NOT use or mention: p_name, p_birthday_year, p_gender, p_salary_min, p_salary_max.
- ABSOLUTELY DO NOT mention any salary figures or salary expectations.
- DO NOT mention the user's name; always write in first person.
- The biography must be between 3 and 7 sentences, maximum 7 sentences.
- If the bio is successfully created, set updates.p_bio = "<GENERATED_BIOGRAPHY>" and set "step_done": true.
- If critical fields are missing (especially p_experience), set step_done = false and ask the user to complete them first.

LANGUAGE STYLE (CRITICAL):
- If language_code is "tr", always talk directly to the user in second person singular ("sen").
- NEVER use first person plural in Turkish: do NOT use "biz", "bizim", "yapıyoruz", "yapalım", "ismimiz", "doğum yılımız", etc.
- In Turkish assistant_comment, use sentences like "Biyografini hazırladım, aşağıdan kontrol edebilirsin." and always keep it short.

OUTPUT FORMAT (JSON ONLY, NO EXTRA TEXT):

{
  "updates": { "p_bio": "..." },
  "step_done": true or false,
  "assistant_comment": "..."
}
`.trim();
  } else {
    system = `
You are the conversation brain for the "Bi İşim Var" job seeker wizard.

TASKS FOR THIS REQUEST ONLY:
1) PARSE the user's free-text answer for the CURRENT STEP (field: ${currentField ?? "unknown"}).
2) TALK to the user with a SHORT, friendly message in ${lang === "tr" ? "Turkish" : "English"}.

GENERAL RULES:
- Only touch fields related to the current step.
- Never invent values the user did not clearly choose.
- If the answer is vague ("farketmez", "sen karar ver", "you decide", "whatever"), keep the related field(s) null/empty and set "step_done": false. Ask a follow-up question to clarify.
- You may SUGGEST options (e.g. "more shifts = more jobs") but the final decision is always the user's, EXCEPT for salary step where you MUST NOT make suggestions about concrete amounts.
- DO NOT mention any hidden database values, system ranges or internal logic.
- Keep assistant_comment short, friendly and focused on this step (max 2 sentences, except salary which has its own rule).
- If you set "step_done": false, you MUST return a helpful assistant_comment (never leave it empty).

LANGUAGE STYLE (CRITICAL):
- If language_code is "tr", you MUST always talk directly to the user in second person singular ("sen").
- NEVER use first person plural in Turkish: do NOT say "biz", "bizim", "yapıyoruz", "yapalım", "ismimiz", "doğum yılımız".
- In Turkish you should prefer sentences like "Adın ne?", "Doğum yılın nedir?", "Maaş beklentini yazar mısın?".

OUTPUT FORMAT (JSON ONLY, NO EXTRA TEXT):

{
  "updates": { ... },
  "step_done": true or false,
  "assistant_comment": "..."
}

Internal field names (must stay in Turkish): p_name, p_birthday_year, p_gender,
p_start_day, p_shift_prefs, p_benefits, p_attributes, p_salary_min, p_salary_max,
p_tip_preference, p_experience, p_bio, p_interests.

Current step enums (if any): ${JSON.stringify(enumsForStep)}
`.trim();
  }

  const stepInstruction = buildStepInstruction(stepIndex, lang, formState);
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
      content:
        `${stepInstruction}\n\nUSER_ANSWER_PAYLOAD:\n${JSON.stringify(userPayload)}`,
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
      temperature: 0.2,
      max_tokens: 512,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Upstream ${res.status}: ${
        await res.text().catch(() => "")
      }`,
    );
  }

  const data = await res.json();
  let text: string =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";
  text = text.trim();

  try {
    const parsed = JSON.parse(text);
    return {
      updates: parsed.updates ?? {},
      step_done: parsed.step_done === true,
      assistant_comment: (parsed.assistant_comment ?? "").toString(),
    };
  } catch {
    // LLM'den geçersiz JSON gelirse hata mesajı
    return {
      updates: {},
      step_done: false,
      assistant_comment: lang === "en"
        ? "Sorry, I couldn’t fully understand that. Could you write it a bit more clearly?"
        : "Üzgünüm, tam anlayamadım. Cevabını biraz daha net yazar mısın?",
    };
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

  const requestStart = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const userId = (body?.user_id ?? "").toString().trim();
    const languageCode = (body?.language_code ?? "tr").toString().toLowerCase();
    const userInputRaw = (body?.user_input_text ?? "").toString();
    const stepIndexRaw = Number(body?.step_index ?? 0);
    const stepIndex = Number.isFinite(stepIndexRaw) && stepIndexRaw >= 0
      ? Math.floor(stepIndexRaw)
      : 0;
    const formState = body?.form_state ?? {};

    if (!userId) return bad("user_id is required");

    const isBioGenerationStep = STEP_FIELDS[stepIndex] === "p_bio";
    if (!isBioGenerationStep && !userInputRaw) {
      // Biyografi adımı hariç, kullanıcı girişi olmalı
      return bad("user_input_text is required");
    }

    // Gelen kullanıcı girdisini küfür ve hassas içerik açısından temizle
    const cleanedInput = fullSanitize(userInputRaw);

    // LLM'i çağır ve sonucu al
    const llmResult = await callExtractorLLM(
      stepIndex,
      languageCode,
      cleanedInput,
      formState,
    );

    const rawUpdates = llmResult.updates ?? {};
    const safeUpdates: any = { ...rawUpdates };

    // SAYISAL ALAN GÜVENLİĞİ
    if ("p_salary_min" in safeUpdates) {
      safeUpdates.p_salary_min = coerceNumberOrNull(safeUpdates.p_salary_min);
    }
    if ("p_salary_max" in safeUpdates) {
      safeUpdates.p_salary_max = coerceNumberOrNull(safeUpdates.p_salary_max);
    }

    // DİZİ ALANLAR GÜVENLİĞİ
    if ("p_shift_prefs" in safeUpdates) {
      safeUpdates.p_shift_prefs = ensureStringArray(safeUpdates.p_shift_prefs);
    }
    if ("p_benefits" in safeUpdates) {
      safeUpdates.p_benefits = ensureStringArray(safeUpdates.p_benefits);
    }
    if ("p_attributes" in safeUpdates) {
      safeUpdates.p_attributes = ensureStringArray(safeUpdates.p_attributes);
    }
    if ("p_interests" in safeUpdates) {
      safeUpdates.p_interests = ensureStringArray(safeUpdates.p_interests);
    }

    // ENUM ALANLAR GÜVENLİĞİ
    if ("p_gender" in safeUpdates) {
      const v = coerceEnum(safeUpdates.p_gender, ENUMS.genders);
      if (!v) delete safeUpdates.p_gender;
      else safeUpdates.p_gender = v;
    }
    if ("p_start_day" in safeUpdates) {
      const v = coerceEnum(safeUpdates.p_start_day, ENUMS.startDays);
      if (!v) delete safeUpdates.p_start_day;
      else safeUpdates.p_start_day = v;
    }
    if ("p_tip_preference" in safeUpdates) {
      const v = coerceEnum(safeUpdates.p_tip_preference, ENUMS.tips);
      if (!v) delete safeUpdates.p_tip_preference;
      else safeUpdates.p_tip_preference = v;
    }

    // Yeni formu oluştur
    const newForm: any = { ...formState, ...safeUpdates };

    // Deneyim ve Biyografi alanlarını son bir küfür filtresinden geçir
    if (newForm.p_experience) {
      newForm.p_experience = fullSanitize(newForm.p_experience);
    }
    if (newForm.p_bio) {
      newForm.p_bio = fullSanitize(newForm.p_bio);
    }

    const lang = languageCode === "en" ? "en" : "tr";
    let stepDone = llmResult.step_done === true;

    // Maaş aralığı için gerçekçilik + limit kontrolü
    const isSalaryStep = STEP_FIELDS[stepIndex] === "p_salary_min";
    let forcedSalaryMessage: string | null = null;

    if (
      isSalaryStep &&
      stepDone &&
      newForm.p_salary_min != null &&
      newForm.p_salary_max != null
    ) {
      const minSalary = newForm.p_salary_min as number;
      const maxSalary = newForm.p_salary_max as number;
      const MIN_REASONABLE = MIN_SALARY;
      const MAX_REASONABLE = MAX_SALARY;

      if (
        minSalary < MIN_REASONABLE ||
        maxSalary > MAX_REASONABLE ||
        minSalary > maxSalary
      ) {
        // Aralık dışı veya saçma değerler -> sıfırla, tekrar iste
        newForm.p_salary_min = null;
        newForm.p_salary_max = null;
        stepDone = false;

        forcedSalaryMessage = lang === "tr"
          ? `Yazdığın maaş rakamı biraz gerçek dışı görünüyor. Maaş beklentini lütfen asgari ücret olan ${MIN_SALARY} TL ile ${MAX_SALARY} TL arasında, sadece rakamlarla ve bir aralık olarak tekrar yazar mısın?`
          : `The salary number you wrote looks a bit unrealistic. Please enter your expected monthly salary again as numbers only, with a range between ${MIN_REASONABLE} and ${MAX_REASONABLE} TL.`;
      }
    }

    // Yeni form durumuna göre sıradaki adımı belirle
    const { nextStep, isFinished } = computeNextStep(newForm);
    let assistant_reply = (llmResult.assistant_comment ?? "").trim();

    // Eğer maaş adımında range out-of-bounds sebebiyle override ettiysek, LLM yorumunu ez
    if (forcedSalaryMessage) {
      assistant_reply = forcedSalaryMessage;
    }

    let responseStepIndex: number;
    let responseIsFinished = false;

    if (!stepDone) {
      // Adım tamamlanmadıysa, mevcut adımda kal
      responseStepIndex = stepIndex;
      responseIsFinished = false;
      if (!assistant_reply) {
        assistant_reply = getQuestion(lang, stepIndex);
      }
    } else {
      // Adım tamamlandıysa, bir sonraki adıma geç
      responseStepIndex = nextStep;
      responseIsFinished = isFinished;

      let tail: string;
      if (isFinished) {
        tail = lang === "en"
          ? "Great, I have all the basic info I need. You can review your profile below and tap 'Let's Find A Job' when you’re ready."
          : "Harika, temel bilgilerin tamam. Aşağıdaki profilini kontrol edebilirsin; hazırsan 'İş Bulmaya Başlayalım' butonuna basabilirsin.";
      } else {
        tail = getQuestion(lang, nextStep);
      }

      if (assistant_reply) {
        assistant_reply = `${assistant_reply} ${tail}`;
      } else {
        assistant_reply = tail;
      }
    }

    // SIGORTA MESAJI EKLEME (benefits adımı için)
    if (stepIndex === 5 && mentionsSigorta(userInputRaw)) {
      const sigMsg = lang === "tr"
        ? " Sigorta (SGK) konusu yasal bir zorunluluktur; bunu mutlaka iş görüşmesinde işverenle netleştirmeni öneriyorum. Biz sigortasız çalışmayı teşvik etmiyoruz."
        : " Insurance/social security is a legal requirement; you should always clarify it directly with the employer during the interview. We do not encourage working without insurance.";
      assistant_reply = assistant_reply
        ? assistant_reply + sigMsg
        : sigMsg;
    }

    const durationMs = Date.now() - requestStart;

    // Basit logging & analytics
    try {
      const logPayload = {
        type: "wizard_step_log",
        ts: new Date().toISOString(),
        user_id: userId,
        lang,
        step_index: stepIndex,
        step_field: STEP_FIELDS[stepIndex] ?? null,
        step_done,
        next_step: responseStepIndex,
        is_finished: responseIsFinished,
        has_experience: Boolean(newForm.p_experience),
        has_bio: Boolean(newForm.p_bio),
        has_salary: Boolean(
          newForm.p_salary_min && newForm.p_salary_max,
        ),
        assistant_reply_preview: assistant_reply.slice(0, 180),
        duration_ms: durationMs,
      };
      console.log(JSON.stringify(logPayload));
    } catch {
      // Logging başarısız olsa bile akışı bozma
    }

    // Nihai yanıtı döndür
    return ok({
      assistant_reply,
      is_finished: responseIsFinished,
      step_index: responseStepIndex,
      form_state: newForm,
    });
  } catch (err: any) {
    const detail = typeof err === "object" && err !== null && "message" in err
      ? err.message
      : String(err);

    return new Response(
      JSON.stringify({
        error: "internal_error",
        detail,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }
});
