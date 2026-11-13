import type { ConversationId, ConversationWatch } from "@earendil-works/pi-durable";

type Query = {
  readonly externalId: string;
  readonly conversationId: ConversationId;
};

export async function watch(_query: Query, _signal: AbortSignal): Promise<ConversationWatch> {
  throw new Error("watch is not implemented");
}
