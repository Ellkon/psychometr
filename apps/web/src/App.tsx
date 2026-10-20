import { healthResponseSchema } from "@kompas/shared";
import { useEffect, useState } from "react";

type ApiStatus = "checking" | "ok" | "unavailable";

const statusLabel: Record<ApiStatus, string> = {
  checking: "проверка…",
  ok: "доступен",
  unavailable: "недоступен",
};

export function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((response) => response.json())
      .then((body: unknown) => {
        setStatus(healthResponseSchema.safeParse(body).success ? "ok" : "unavailable");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("unavailable");
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main>
      <h1>Клинический компас</h1>
      <p>Сервер: {statusLabel[status]}</p>
    </main>
  );
}
