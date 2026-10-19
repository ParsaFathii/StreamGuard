"use client";

// StreamGuard Console — single-page application root.
// Session gate: no session (401) → LoginView; otherwise the console AppShell.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { LoginView } from "@/components/streamguard/login-view";
import { AppShell } from "@/components/streamguard/app-shell";

function Splash({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background">
      <div className="sg-brand sg-pulse flex size-10 items-center justify-center rounded-lg font-mono text-sm font-bold">
        SG
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export default function Page() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.session(),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  if (session.isLoading) {
    return <Splash label="…" />;
  }

  // 401 (or API unreachable) → login view
  if (session.isError || !session.data?.user) {
    return <LoginView />;
  }

  return <AppShell user={session.data.user} />;
}
