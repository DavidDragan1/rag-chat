/* eslint-disable @typescript-eslint/no-explicit-any */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import type { BaseLanguageModelInterface } from "@langchain/core/language_models/base";
import type { Redis } from "@upstash/redis";
import { createStreamableValue } from "ai/rsc";
import { ContextService } from "./context";
import type { Database, VectorPayload } from "./database";
import { __InMemoryHistory } from "./history/__in-memory-history";
import { __UpstashRedisHistory } from "./history/__redis-custom-history";
import type { PrepareChatResult } from "./types";
import { sanitizeQuestion } from "./utils";
import type { IterableReadableStreamInterface } from "@langchain/core/utils/stream";

export type PromptParameters = { chatHistory?: string; question: string; context: string };

export type CustomPrompt = ({ question, chatHistory, context }: PromptParameters) => string;

export type Message = { id: string; content: string; role: "ai" | "user" };

export type UpstashMessage<TMetadata extends Record<string, unknown> = Record<string, unknown>> = {
  role: "assistant" | "user";
  content: string;
  metadata: TMetadata;
  id: string;
};

export class RAGChatBase {
  protected vectorService: Database; // internal
  context: ContextService; // exposed API
  history: __UpstashRedisHistory | __InMemoryHistory;

  #model: BaseLanguageModelInterface;

  constructor(
    vectorService: Database,
    historyConfig: { redis: Redis | undefined; metadata: Record<string, unknown> },
    config: { model: BaseLanguageModelInterface; prompt: CustomPrompt }
  ) {
    this.vectorService = vectorService;
    this.context = new ContextService(vectorService);

    this.history = historyConfig.redis
      ? new __UpstashRedisHistory({
          client: historyConfig.redis,
          metadata: historyConfig.metadata,
        })
      : new __InMemoryHistory();

    this.#model = config.model;
  }

  protected async prepareChat({
    question: input,
    similarityThreshold,
    topK,
    metadataKey,
    namespace,
  }: VectorPayload): Promise<PrepareChatResult> {
    const question = sanitizeQuestion(input);
    const context = await this.vectorService.retrieve({
      question,
      similarityThreshold,
      metadataKey,
      topK,
      namespace,
    });
    return { question, context };
  }

  protected async makeAiRequest({
    streaming,
    prompt,
    onComplete,
  }: {
    streaming: boolean;
    prompt: string;
    onComplete?: (output: string) => void;
  }) {
    if (streaming) {
      const stream = createStreamableValue("");
      let accumulatorOutput = "";

      (async () => {
        try {
          const rawStream = (await this.#model.stream([
            new HumanMessage(prompt),
          ])) as IterableReadableStreamInterface<UpstashMessage>;

          for await (const chunk of rawStream) {
            stream.append(chunk.content);
            accumulatorOutput += chunk.content;
          }
        } catch (error) {
          console.error("Stream writing error:", error);
        } finally {
          stream.done();

          onComplete?.(accumulatorOutput);
        }
      })().catch((error: unknown) => {
        console.error(error);
      });

      return { output: stream.value, isStream: true };
    } else {
      const { content } = (await this.#model.invoke(prompt)) as BaseMessage;

      onComplete?.(content as string);

      return { output: content, isStream: false };
    }
  }
}
