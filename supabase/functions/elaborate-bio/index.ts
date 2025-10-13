// supabase/functions/elaborate-bio/index.ts

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROVIDER = Deno.env.get("LLM_PROVIDER")?.toLowerCase();
const MODEL = Deno.env.get("LLM_MODEL") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
// OpenAI-uyumlu taban URL (OpenAI, Groq, OpenRouter, DeepSeek vs.)
const OPENAI_BASE = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

function badRequest(detail: string, code = 400) {
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

async function callOpenAI(rawBio: string): Promise<string> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");
  if (!MODEL) throw new Error("LLM_MODEL missing for OpenAI");

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "Hizmet sektörü
