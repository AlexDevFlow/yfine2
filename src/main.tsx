import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";

import "@fontsource-variable/inter";
import "slot-text/style.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles/globals.css";
import "./i18n";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm";
import { PrivacyProvider } from "@/lib/privacy";
import { LoginScreen } from "@/components/auth/login-screen";
import { isDbEncrypted, registerReencryptOnClose, runCrashRecovery, setRuntimePassword } from "@/lib/auth-bridge";
import { installNoSelectGuard } from "@/lib/no-select";
import { router } from "./router";

installNoSelectGuard();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Keep showing the previous results while a new query (changed filters,
      // search text, page) loads — avoids the list flashing to a loading state.
      placeholderData: keepPreviousData,
    },
  },
});

/** Gate the app behind unlock when the on-disk DB is encrypted (Tauri only). */
function Root() {
  const [locked, setLocked] = useState<boolean | null>(null);
  // `appMounted` mounts the router (and lazily opens the DB) the moment auth
  // succeeds — BEHIND the login overlay — so the work happens under the bloom
  // instead of after a hard swap. `loginVisible` keeps the login layer alive
  // until its open-transition finishes and signals back.
  const [appMounted, setAppMounted] = useState(false);
  const [loginVisible, setLoginVisible] = useState(false);

  useEffect(() => {
    // Crash recovery BEFORE the DB connection is opened: drop a stale plaintext
    // yfine.db left by an unclean shutdown when the .enc is canonical, then gate
    // on whether the DB is (still) encrypted. The router — which lazily opens the
    // DB via getDb() — only mounts once we leave the locked/loading state below.
    runCrashRecovery()
      .then(isDbEncrypted)
      .then((encrypted) => {
        setLocked(encrypted);
        if (encrypted) setLoginVisible(true);
        else setAppMounted(true);
      })
      .catch(() => {
        setLocked(false);
        setAppMounted(true);
      });
  }, []);

  if (locked === null) {
    return <div className="grid h-full place-items-center text-sm text-muted">…</div>;
  }

  // App and login coexist during the open-transition: the app renders in normal
  // flow (z-0), the login overlay sits fixed on top (z-50) and the bloom covers
  // the seam while the router mounts underneath.
  return (
    <>
      {appMounted && <RouterProvider router={router} />}
      {loginVisible && (
        <LoginScreen
          onAuthenticated={(pw) => {
            setRuntimePassword(pw);
            void registerReencryptOnClose();
            setAppMounted(true); // start mounting the app behind the bloom
          }}
          onTransitionEnd={() => setLoginVisible(false)}
        />
      )}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <PrivacyProvider>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <ConfirmProvider>
                <Root />
              </ConfirmProvider>
            </ToastProvider>
          </QueryClientProvider>
        </PrivacyProvider>
      </ThemeProvider>
    </MotionConfig>
  </React.StrictMode>,
);
