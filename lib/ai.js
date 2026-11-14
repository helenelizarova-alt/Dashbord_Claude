// ИИ-ассистент: отвечает на вопросы по данным дашборда через Claude API.
// Ключ берётся из переменной окружения ANTHROPIC_API_KEY (или профиля `ant auth login`).
import Anthropic from '@anthropic-ai/sdk';

let client;
const getClient = () => (client ||= new Anthropic());

const SYSTEM = `Ты аналитик маркетплейсов Wildberries и Ozon. Тебе дают сводку дашборда продавца в JSON:
KPI, P&L по каналам, юнит-экономику по артикулам, рекламу, остатки, список решений.
Отвечай по-русски, коротко и по делу, опираясь только на цифры из сводки. Суммы — в рублях с пробелами между разрядами.
Если данных для ответа нет, так и скажи и подскажи, какой отчёт загрузить. Если канал помечен demo: true, напомни, что цифры демонстрационные.`;

export async function askAssistant(history, context) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return 'ИИ-ассистент не настроен: задайте переменную окружения ANTHROPIC_API_KEY и перезапустите сервер.';
  }
  const messages = history.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 4000) }));
  messages[messages.length - 1].content = `Сводка дашборда:\n${JSON.stringify(context)}\n\nВопрос: ${messages[messages.length - 1].content}`;
  try {
    const res = await getClient().beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages,
    });
    if (res.stop_reason === 'refusal') return 'Ассистент не смог ответить на этот вопрос. Переформулируйте его.';
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Пустой ответ.';
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return 'Ключ ANTHROPIC_API_KEY не принят. Проверьте его.';
    if (e instanceof Anthropic.RateLimitError) return 'Слишком много запросов к ИИ. Попробуйте через минуту.';
    if (e instanceof Anthropic.APIError) return `Ошибка ИИ (${e.status}): ${e.message}`;
    return `Ошибка ИИ: ${e.message}`;
  }
}
