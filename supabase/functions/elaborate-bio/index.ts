// --- cümle say, hedef aralığı seç ---
function countSentences(t: string): number {
  // nokta, ünlem, soru, noktalı virgül ve satır sonlarını kaba ayraç say
  const parts = t.split(/[\.\!\?\;\n]+/).map(s => s.trim()).filter(Boolean);
  return parts.length || 1;
}
function pickTargetRange(n: number): {min: number; max: number} {
  if (n <= 3) return { min: 2, max: 3 };
  if (n <= 5) return { min: 3, max: 4 };
  if (n <= 8) return { min: 4, max: 6 };
  return { min: 5, max: 8 };
}
const inputSentenceCount = countSentences(cleanedInput);
const target = pickTargetRange(inputSentenceCount);

// “yoğun/kalabalık/pik/rush” bilgisi varsa zorunlu kuralı koru
const rush = /(?:yoğun|kalabalık|pik|rush)/i.test(cleanedInput);

// --- system prompt’u dinamik hazırla ---
const systemLines: string[] = [
  "Türkçe yazan bir editörsün.",
  "Girdi hangi dilde olursa olsun, çıktı dili daima Türkçe olacak.",
  "Görev: Ham biyoyu YALIN ve GERÇEKÇİ bir üslupla toparla; bilgileri koru.",
  `Girdi yaklaşık ${inputSentenceCount} cümle; çıktıda ${target.min}–${target.max} cümleyi hedefle.`,
  "KURALLAR:",
  "- SADECE verilen bilgilere dayan; yeni unvan/eğitim/başarı uydurma.",
  "- Abartı ve öznel övgü YOK (örn: severim, seviyorum, tutkuluyum, mükemmel, lider, uzman).",
  "- Başlık/emoji/kod bloğu/tırnak YOK.",
  "- Yazım hatalarını düzelt; terimleri doğru yaz (örn. 'restoranda', 'ocakbaşı').",
  "- Bilgi kaybı olmasın; sadece gereksiz tekrarları ve dolgu sözcükleri temizle.",
  "- Cümleleri kısa tut; akıcı bir paragraf halinde döndür.",
];
if (rush) {
  systemLines.push(
    "- Girişte ‘yoğun/kalabalık/pik/rush’ bilgisi var; çıktı bunu NET şekilde içermeli (örn. ‘Yoğun saatlerde çalışmaya alışığım.’)."
  );
}
const system = systemLines.join("\n");

// --- LLM istek gövdesi (mevcut fetch'te kullan) ---
const bodyPayload = {
  model: MODEL,
  temperature: 0.0,                  // deterministik
  // girdi uzun olduğunda biraz daha token ver; yine de makul sınırda tut
  max_tokens: Math.min(90 + inputSentenceCount * 10, 220),
  stop: ["\n\n","```","Biyografi"],
  messages: [
    { role: "system", content: system },
    // küçük bir örnek (few-shot) istersen ekleyebilirsin:
    // { role: "user", content: "Ham biyo:\n3 yıl restoranda garsonluk yaptım; yoğun saatlerde çalıştım." },
    // { role: "assistant", content: "3 yıl restoranda garsonluk yaptım. Yoğun saatlerde çalışmaya alışığım; müşterilerle iyi iletişim kurarım." },
    { role: "user", content: `Ham biyo:\n${cleanedInput}\n\nLütfen yalnızca düz metin döndür.` },
  ],
};

// fetch çağrında:
// body: JSON.stringify(bodyPayload)
