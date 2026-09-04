import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";

export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

export type Entry =
  | { id: string; type: "text"; text: string; streaming: boolean }
  | { id: string; type: "reasoning"; text: string; streaming: boolean }
  | { id: string; type: "tool"; name: string; title: string; input: unknown; output?: unknown; errorText?: string; state: ToolState }
  | { id: string; type: "note"; text: string; tone?: "good" | "bad" | "neutral" | "big" };

function ToolLine({ entry }: { entry: Extract<Entry, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const hasDetails = (entry.input && Object.keys(entry.input as object).length > 0) || entry.output !== undefined || entry.errorText;
  return (
    <div className="w-full">
      <button type="button" onClick={() => hasDetails && setOpen(!open)} className={cn("flex w-full items-center gap-1.5 text-left text-sm", hasDetails ? "cursor-pointer" : "cursor-default")}>
        {hasDetails && <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />}
        <span className={cn(entry.state === "output-error" && "text-red-400")}>{entry.title}</span>
        {entry.state === "input-available" && <Shimmer duration={1} className="text-xs text-muted-foreground">…</Shimmer>}
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-5">
          {entry.input !== undefined && Object.keys((entry.input as object) ?? {}).length > 0 && <ToolInput input={entry.input} />}
          <ToolOutput output={entry.output as never} errorText={entry.errorText} />
        </div>
      )}
    </div>
  );
}

export function Transcript({ entries, from, emptyTitle, waiting }: { entries: Entry[]; from: "user" | "assistant"; emptyTitle: string; waiting?: boolean }) {
  return (
    <Conversation className="h-full min-h-0 rounded-lg border border-border bg-card/40">
      <ConversationContent className="gap-2 p-3">
        {entries.length === 0 && !waiting && <ConversationEmptyState title={emptyTitle} description="" />}
        {entries.map((entry) => (
          <Message key={entry.id} from={from} className="max-w-full">
            <MessageContent className="w-full max-w-full group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-0">
              {entry.type === "text" && <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.text}</p>}
              {entry.type === "reasoning" && (
                <Reasoning isStreaming={entry.streaming} defaultOpen={false} className="w-full">
                  <ReasoningTrigger />
                  <ReasoningContent>{entry.text}</ReasoningContent>
                </Reasoning>
              )}
              {entry.type === "tool" && <ToolLine entry={entry} />}
              {entry.type === "note" && (
                <p
                  className={cn(
                    "text-sm",
                    entry.tone === "good" && "text-lime-400",
                    entry.tone === "bad" && "text-red-400",
                    entry.tone === "big" && "rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 font-medium",
                    (!entry.tone || entry.tone === "neutral") && "text-muted-foreground",
                  )}
                >
                  {entry.text}
                </p>
              )}
            </MessageContent>
          </Message>
        ))}
        {waiting && (
          <div className="px-1 text-sm">
            <Shimmer duration={1.2}>{emptyTitle}</Shimmer>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
