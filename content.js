// ── AI Classifier ────────────────────────────────────────────────────────────
const AI_STORAGE_KEY = "funpayListsAI";
const AI_EXAMPLES_KEY = "funpayListsAIExamples";
const AI_MAX_EXAMPLES = 20;

const AI_SYSTEM_PROMPT = `Ты — ассистент для проверки заказов на платформе FunPay.
Отвечай ТОЛЬКО в формате JSON, без лишнего текста:
{
"list": "clean" | "dispute" | "excluded",
"confidence": 0.0-1.0,
"reason": "объяснение на русском, 1-2 предложения"
}`;

const AI_DEFAULT_RULES = `СПИСОК 1 — clean (✅ Проверенные):
Заказ выполнен, покупатель доволен, нет жалоб.
Признаки: "спасибо", "всё получил", "работает", "отлично", "всё ок", положительный отзыв, покупатель подтвердил получение, нет открытых вопросов, покупатель получил код/товар авто выдачей, получил код и тд тп.

СПИСОК 2 — dispute (⚠️ Спорные):
Заказ выполнен, но есть сомнения.
Признаки:
- покупатель не подтвердил получение товара
- покупатель не запросил код/данные от товара
- покупатель задал важный вопрос но не был в сети после ответа
- покупатель написал что-то негативное ("не работает", "не то", "верните", "обман") но арбитраж НЕ открыт
- покупатель долго молчит после выполнения
- есть вложение/скриншот с какой-то ошибкой входа или чего-то подобного
- неоднозначная ситуация, нужно внимание продавца

СПИСОК 3 — excluded (🚫 Арбитраж/Модератор):
Заказ НЕ включается ни в один список.
Признаки:
- в чате есть сообщения от сотрудника FunPay, модератора или арбитра
- слова "арбитраж открыт", "передано на рассмотрение", "модератор"
- сотрудник уже находится в чате
- открыт официальный спор через платформу

ВАЖНО:
- "не работает" без арбитража = dispute, не excluded
- вопрос без ответа от покупателя/продавца = dispute
- если есть фото — опиши что на нём и учти при решении
- язык чата: русский, английский или смешанный`;

async function getAiSettings() {
  const stored = await chrome.storage.local.get([AI_STORAGE_KEY]);
  return stored[AI_STORAGE_KEY] || { enabled: false, apiKey: "", rules: AI_DEFAULT_RULES, model: "moonshotai/kimi-k2.6" };
}

async function getAiExamples() {
  const stored = await chrome.storage.local.get([AI_EXAMPLES_KEY]);
  return stored[AI_EXAMPLES_KEY] || [];
}

async function imageUrlToBase64(url) {
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function callAiClassifier(chatData, aiSettings) {
  const { apiKey, rules, model } = aiSettings;
  if (!apiKey) return null;

  const examples = await getAiExamples();

  let examplesSection = "";
  if (examples.length > 0) {
    const recent = examples.slice(-AI_MAX_EXAMPLES);
    examplesSection = "\n\nТВОИ РЕШЕНИЯ (обучающие примеры — учитывай их при классификации):\n";
    examplesSection += recent.map((ex) =>
      `Чат: "${ex.chatText.slice(0, 200)}"\nТовар: "${(ex.productText || "").slice(0, 100)}"\n→ ${JSON.stringify({ list: ex.list, reason: ex.reason })}`
    ).join("\n\n");
  }

  const userPrompt = buildAiUserPrompt(chatData);

  const contentParts = [{ type: "text", text: `${rules}${examplesSection}\n\n---\n\n${userPrompt}` }];

  if (chatData.imageUrls && chatData.imageUrls.length > 0) {
    const imageLimit = chatData.imageUrls.slice(0, 3);
    for (const url of imageLimit) {
      const b64 = await imageUrlToBase64(url);
      if (b64) {
        contentParts.push({
          type: "image_url",
          image_url: { url: b64, detail: "low" }
        });
      }
    }
  }

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "moonshotai/kimi-k2.6",
        messages: [
          { role: "system", content: AI_SYSTEM_PROMPT },
          { role: "user", content: contentParts }
        ],
        temperature: 0.1,
        max_tokens: 256
      })
    });

    if (!response.ok) {
      console.warn("[FunPay AI] API error:", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!["clean", "dispute", "excluded"].includes(parsed.list)) return null;

    return { list: parsed.list, confidence: parsed.confidence || 0.8, reason: parsed.reason || "" };
  } catch (err) {
    console.warn("[FunPay AI] Error:", err);
    return null;
  }
}

function buildAiUserPrompt(chatData) {
  const lines = [];
  lines.push("Проанализируй этот заказ и определи список:");
  lines.push("");
  if (chatData.productText) {
    lines.push(`📦 ОПИСАНИЕ ТОВАРА:\n${chatData.productText.slice(0, 300)}`);
    lines.push("");
  }
  if (chatData.messages && chatData.messages.length > 0) {
    lines.push("💬 ЧАТ (последние сообщения):");
    const recent = chatData.messages.slice(-30);
    for (const msg of recent) {
      const role = msg.role === "buyer" ? "Покупатель" : msg.role === "seller" ? "Продавец" : "Система";
      const attachment = msg.hasAttachment ? " [📎 вложение]" : "";
      if (msg.text || msg.hasAttachment) {
        lines.push(`[${role}]${attachment}: ${(msg.text || "").slice(0, 200)}`);
      }
    }
    lines.push("");
  }
  if (chatData.ocrText) {
    lines.push(`🔍 OCR С ФОТО:\n${chatData.ocrText.slice(0, 400)}`);
    lines.push("");
  }
  if (chatData.imageUrls && chatData.imageUrls.length > 0) {
    lines.push(`🖼️ Фото в чате: ${chatData.imageUrls.length} шт. (прикреплены выше)`);
  }
  return lines.join("\n");
}
