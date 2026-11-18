import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createDocument,
  deleteDocument,
  listDocuments,
  streamChat,
  type DocumentRecord,
  type Source,
} from "./api";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  error?: boolean;
};

export function App() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    try {
      setDocuments(await listDocuments());
      setLibraryError("");
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Cannot reach the API");
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const next = await listDocuments();
          if (!cancelled) {
            setDocuments(next);
            setLibraryError("");
          }
          return;
        } catch (error) {
          if (attempt === 7 && !cancelled) {
            setLibraryError(error instanceof Error ? error.message : "Cannot reach the API");
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveNote("");
    try {
      const saved = await createDocument({ title, text, file });
      setTitle("");
      setText("");
      setFile(null);
      const passages = saved.chunkCount === 1 ? "passage" : "passages";
      setSaveNote(`Saved “${saved.title}” in ${saved.chunkCount} ${passages}.`);
      await refresh();
    } catch (error) {
      setSaveNote(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id: string) {
    setLibraryError("");
    try {
      await deleteDocument(id);
      await refresh();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Could not delete");
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function onAsk(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || streaming) return;

    const history = messages
      .filter((message) => !message.error && message.content.trim())
      .map((message) => ({ role: message.role, content: message.content }));
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: question },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setDraft("");
    setStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;
    const update = (patch: Partial<Message>) => {
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, ...patch } : message)),
      );
    };

    try {
      let content = "";
      await streamChat(
        question,
        history,
        (chatEvent) => {
          if (chatEvent.type === "sources") update({ sources: chatEvent.sources });
          if (chatEvent.type === "token") {
            content += chatEvent.content;
            update({ content });
          }
          if (chatEvent.type === "error") update({ content: chatEvent.message, error: true });
        },
        abort.signal,
      );
      if (!content) update({ content: "No answer came back." });
    } catch (error) {
      if (abort.signal.aborted) return;
      update({
        content: error instanceof Error ? error.message : "The request failed",
        error: true,
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="app">
      <section className="library">
        <header className="pane-head">
          <h1>Library</h1>
          <p>{documents.length === 1 ? "1 document" : `${documents.length} documents`}</p>
        </header>
        <form className="intake" onSubmit={onSave}>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            aria-label="Title"
          />
          <label
            className={dragging ? "drop over" : "drop"}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const next = event.dataTransfer.files?.[0];
              if (next) setFile(next);
            }}
          >
            <span>
              <strong>Drop a .txt, .md, or .pdf</strong>
              <span className="hint"> or choose a file</span>
            </span>
            <span className="file-name">{file ? file.name : "None"}</span>
            <input
              type="file"
              accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Or paste the document here"
            aria-label="Document text"
          />
          <button className="primary" type="submit" disabled={saving || (!text.trim() && !file)}>
            {saving ? "Embedding…" : "Add to library"}
          </button>
          <p className={saveNote && !saveNote.startsWith("Saved") ? "status error" : "status"}>
            {saveNote}
          </p>
        </form>
        <div className="docs">
          {libraryError ? <p className="status error">{libraryError}</p> : null}
          {documents.map((document) => (
            <article className="doc" key={document.id}>
              <strong>{document.title}</strong>
              <button className="ghost" type="button" onClick={() => void onDelete(document.id)}>
                Remove
              </button>
              <span className="doc-meta">
                {document.chunkCount} {document.chunkCount === 1 ? "passage" : "passages"} ·{" "}
                {formatDate(document.createdAt)}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className="chat">
        <header className="pane-head">
          <h1>Chat</h1>
          <p>Answers stay inside the library</p>
        </header>
        <div className="messages" ref={scrollerRef}>
          {messages.length === 0 ? (
            <p className="empty">Add a document, then ask something it can answer.</p>
          ) : (
            messages.map((message) => (
              <article
                className={message.error ? "bubble assistant error" : `bubble ${message.role}`}
                key={message.id}
              >
                {message.role === "assistant" ? (
                  <>
                    <div className="body">
                      {message.content}
                      {streaming && message.id === messages.at(-1)?.id ? (
                        <span className="caret" />
                      ) : null}
                    </div>
                    {message.sources && message.sources.length > 0 ? (
                      <div className="sources">
                        {message.sources.map((source) => (
                          <div className="source" key={`${message.id}-${source.documentId}-${source.excerpt}`}>
                            <strong>
                              {source.title}
                              <span className="source-score"> {Math.round(source.score * 100)}%</span>
                            </strong>
                            <span>{source.excerpt}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  message.content
                )}
              </article>
            ))
          )}
        </div>
        <form className="composer" onSubmit={onAsk}>
          <textarea
            value={draft}
            aria-label="Question"
            placeholder="Ask about the documents"
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {streaming ? (
            <button className="send" type="button" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="send" type="submit" disabled={!draft.trim()}>
              Send
            </button>
          )}
        </form>
      </section>
    </div>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
