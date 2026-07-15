import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import type { User } from "../types";
import { api } from "../api/client";
import { terminalCapabilityFromResponse, type TerminalCapabilityState } from "../lib/terminalCapability";

interface AuthContextValue {
  user: User | null;
  providers: { github: boolean; gitlab: boolean; dev?: boolean };
  availableProviders: { github: boolean; gitlab: boolean };
  terminalCapability: TerminalCapabilityState;
  loading: boolean;
  error: string;
  retry: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  providers: { github: false, gitlab: false },
  availableProviders: { github: false, gitlab: false },
  terminalCapability: "checking",
  loading: true,
  error: "",
  retry: () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [providers, setProviders] = useState({ github: false, gitlab: false });
  const [availableProviders, setAvailableProviders] = useState({ github: false, gitlab: false });
  const [terminalCapability, setTerminalCapability] = useState<TerminalCapabilityState>("checking");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError("");
    setTerminalCapability("checking");
    api.auth.me()
      .then(({ user, providers, availableProviders, capabilities }) => {
        setUser(user);
        setProviders(providers);
        setAvailableProviders(availableProviders || providers);
        setTerminalCapability(terminalCapabilityFromResponse(capabilities));
      })
      .catch(() => {
        setUser(null);
        setProviders({ github: false, gitlab: false });
        setAvailableProviders({ github: false, gitlab: false });
        setTerminalCapability("unavailable");
        setError("Waynode could not reach this server. Check the address and try again.");
      })
      .finally(() => setLoading(false));
  }, [attempt]);

  const logout = async () => {
    await api.auth.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, providers, availableProviders, terminalCapability, loading, error, retry: () => setAttempt((value) => value + 1), logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
