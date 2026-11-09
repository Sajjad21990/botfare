import type Anthropic from "@anthropic-ai/sdk";

/**
 * The slice of the Anthropic client BotFare's AI modules use: `beta.messages.create` and
 * `beta.messages.stream`. The Anthropic SDK client satisfies it as it is; the OpenAI-compatible
 * adapter (./openai-compatible) implements it for every other provider, so the research agent,
 * Fare Court, Fare Advisor and the analytics assistant keep one code path.
 */

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type BetaUsage = Anthropic.Beta.Messages.BetaUsage;
export type BetaStopReason = Anthropic.Beta.Messages.BetaStopReason;
export type BetaRawStreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
export type ModelCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelStreamParams = Omit<ModelCreateParams, "stream">;

export interface ModelRequestOptions {
  signal?: AbortSignal;
  /** Milliseconds for this request (overrides the client's default). */
  timeout?: number;
}

/** A streamed turn: raw Messages stream events, then the complete message. */
export interface ModelStream extends AsyncIterable<BetaRawStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}

export interface ModelClient {
  beta: {
    messages: {
      create(params: ModelCreateParams, options?: ModelRequestOptions): PromiseLike<BetaMessage>;
      stream(params: ModelStreamParams, options?: ModelRequestOptions): ModelStream;
    };
  };
}
