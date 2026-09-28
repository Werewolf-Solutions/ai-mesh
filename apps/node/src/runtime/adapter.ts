import type { ChatMessage, FinishReason, GenerationSettings, Usage } from '@werewolf-mesh/protocol';

export type GenEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; finishReason: FinishReason; usage: Usage };

export interface RuntimeStatus {
  ready: boolean;
  state: 'stopped' | 'loading' | 'ready' | 'failed';
  detail: string;
}

/**
 * Local inference engine boundary. Implementations execute ONE generation per
 * call; admission control and queueing live in WorkerPool, not here.
 *
 * `generate` must stop work in the underlying runtime when `signal` aborts.
 */
export interface InferenceAdapter {
  readonly kind: 'llama.cpp' | 'fake';
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): RuntimeStatus;
  /** Exact prompt token count after applying the model's chat template. */
  countPromptTokens(messages: ChatMessage[], signal?: AbortSignal): Promise<number>;
  generate(messages: ChatMessage[], settings: GenerationSettings, signal: AbortSignal): AsyncIterable<GenEvent>;
}
