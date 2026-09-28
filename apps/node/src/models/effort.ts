/**
 * Effort → generation plan.
 *
 * Uses OpenAI's `reasoning_effort` values. For models with a thinking mode,
 * effort decides whether the model thinks first and for how long (a token
 * budget the runtime enforces). For models without one, effort only changes
 * the default answer length. Everything is clamped to the model's context.
 */
import { MeshError, type GenerationSettings } from '@werewolf-mesh/protocol';
import type { CatalogEntry } from '../model.js';

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** Thinking budget per effort (tokens). */
export const THINKING_BUDGET: Record<Effort, number> = { none: 0, minimal: 0, low: 512, medium: 1536, high: 4096 };
/** Default answer length per effort (tokens) when the request sets no max_tokens. */
export const ANSWER_DEFAULT: Record<Effort, number> = { none: 512, minimal: 512, low: 768, medium: 1024, high: 2048 };

/** Room kept for the prompt when sizing thinking + answer. */
const PROMPT_RESERVE = 1024;

export function planGeneration(e: CatalogEntry, effort: Effort | undefined, requestedMax: number | undefined): Pick<GenerationSettings, 'maxTokens' | 'thinking'> & { effort: Effort } {
  const think = e.capabilities.thinking;
  const eff: Effort = effort ?? (think === 'none' ? 'medium' : 'low');
  const ctx = e.serving.contextTokens;
  const room = Math.max(64, ctx - Math.min(PROMPT_RESERVE, Math.floor(ctx / 2)));
  if (requestedMax !== undefined && requestedMax > e.serving.maxOutputTokens) {
    throw new MeshError('bad_request', `max_tokens must be <= ${e.serving.maxOutputTokens} for ${e.id}`);
  }
  const answer = Math.min(requestedMax ?? ANSWER_DEFAULT[eff], e.serving.maxOutputTokens, room);
  if (think === 'none') return { maxTokens: answer, effort: eff };
  const wantsThinking = think === 'always' || (eff !== 'none' && eff !== 'minimal');
  if (!wantsThinking) return { maxTokens: answer, thinking: { mode: 'off' }, effort: eff };
  const budget = Math.max(64, Math.min(THINKING_BUDGET[eff] || 256, room - answer));
  return { maxTokens: answer, thinking: { mode: 'on', budget }, effort: eff };
}
