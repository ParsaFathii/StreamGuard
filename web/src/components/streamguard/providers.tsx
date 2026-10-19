"use client";

// StreamGuard Console — app providers: TanStack Query, next-themes (dark default),
// sonner toaster, and lang/dir sync for RTL support.
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { useUiStore } from "@/lib/store";

function LangSync() {
  const lang = useUiStore((s) => s.lang);
  useEffect(() => {
    document.documentElement.lang = lang === "fa" ? "fa" : "en";
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  }, [lang]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              const status = (error as { status?: number })?.status ?? 0;
              if (status >= 400 && status < 500) return false; // 4xx: don't retry
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
        <LangSync />
        {children}
        <Toaster position="bottom-right" closeButton richColors />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
